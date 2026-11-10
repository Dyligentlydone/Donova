import type { CDPSession, Page } from "puppeteer-core";

export interface CaptureOpts {
  width: number;
  height: number;
  fps: number;
  format?: "png" | "jpeg";
  jpegQuality?: number;
  /** Output scale (device scale factor). 0.5 → half-res frames (draft mode). */
  scale?: number;
  /** Transparent page background + PNG alpha channel in captured frames. */
  alpha?: boolean;
  /** Force screenshot mode even when beginFrame is available. */
  disableBeginFrame?: boolean;
}

export interface CapturedFrame {
  frame: number;
  data: Buffer;
  durationUs: number;
}

type FrameCallback = (f: CapturedFrame) => Promise<void> | void;

function isPng(b: Buffer): boolean {
  return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/**
 * CaptureSession — per plan 03 §3/§6.
 *
 * Preferred path: HeadlessExperimental.beginFrame with the protocol contract
 * Chrome expects: `HeadlessExperimental.enable` → a warm-up frame at
 * frameTimeTicks 0 with noDisplayUpdates → per-frame calls with
 * frameTimeTicks = 1000 + n*interval and an attached screenshot. Chrome then
 * paints exactly one frame per call (deterministic).
 *
 * Fallback: Page.captureScreenshot (rAF-aligned; less precise but robust).
 * The beginFrame probe validates the returned PNG signature before committing;
 * any failure downgrades to screenshot mode for the session.
 */
export class CaptureSession {
  constructor(
    private page: Page,
    private opts: CaptureOpts,
  ) {}

  private cdp?: CDPSession;
  private useBeginFrame = false;
  private frameNo = 0;
  private tickBase = 1000;
  private intervalMs = 33;

  /**
   * Probe beginFrame support inside a page that belongs to a SACRIFICIAL
   * browser process. On some environments (e.g. macOS with no attached
   * display) a failed beginFrame crashes the entire browser process — so this
   * must never run inside the real capture browser. Returns true only when a
   * valid PNG came back.
   */
  static async probe(page: Page, fps: number, disable?: boolean): Promise<boolean> {
    if (disable) return false;
    const intervalMs = Math.round(1000 / fps);
    try {
      await page.goto("data:text/html,<style>html,body{margin:0}</style><div>fc-probe</div>", {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      const cdp = await page.createCDPSession();
      const timeout = new Promise<never>((_r, rej) =>
        setTimeout(() => rej(new Error("probe timeout")), 10_000),
      );
      const probe = (async () => {
        await cdp.send("HeadlessExperimental.enable");
        await cdp.send("HeadlessExperimental.beginFrame", {
          frameTimeTicks: 0,
          interval: intervalMs,
          noDisplayUpdates: true,
        });
        for (let attempt = 1; attempt <= 5; attempt++) {
          const res = (await cdp.send("HeadlessExperimental.beginFrame", {
            frameTimeTicks: 1000 + (attempt - 1) * intervalMs,
            interval: intervalMs,
            screenshot: { format: "png" },
          })) as { screenshotData?: string };
          const bytes = res.screenshotData ? Buffer.from(res.screenshotData, "base64") : Buffer.alloc(0);
          if (isPng(bytes)) return true;
          await new Promise((r) => setTimeout(r, 10));
        }
        return false;
      })();
      return await Promise.race([probe, timeout]);
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await this.page.setViewport({
      width: this.opts.width,
      height: this.opts.height,
      deviceScaleFactor: this.opts.scale ?? 1,
    });
    this.intervalMs = Math.round(1000 / this.opts.fps);
    this.cdp = await this.page.createCDPSession();
    if (this.opts.alpha) {
      // Required for transparency to survive into captured PNGs.
      await this.cdp
        .send("Emulation.setDefaultBackgroundColorOverride", {
          color: { r: 0, g: 0, b: 0, a: 0 },
        })
        .catch(() => {});
    }
    if (this.opts.disableBeginFrame) this.useBeginFrame = false;
  }

  /** Called by the renderer after a successful external probe: re-runs
   *  enable + warmup on the real page's session. */
  async enableBeginFrame(): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send("HeadlessExperimental.enable");
    await this.cdp.send("HeadlessExperimental.beginFrame", {
      frameTimeTicks: 0,
      interval: this.intervalMs,
      noDisplayUpdates: true,
    });
    this.useBeginFrame = true;
  }

  /** Seek page to time, then capture one frame. */
  async captureFrame(t: number, onFrame: FrameCallback): Promise<void> {
    const profile = process.env.EDITNCE_PROFILE_CAPTURE === "1";
    const t0 = performance.now();
    // Drive the runtime seek.
    await this.page.evaluate(async (tt: number) => {
      const w = window as unknown as {
        __fc?: { renderSeek(t: number): Promise<void> };
        __renderReady?: boolean;
      };
      if (w.__fc?.renderSeek) await w.__fc.renderSeek(tt);
    }, t);

    // Wait for readiness gate (bounded).
    await this.page
      .waitForFunction("window.__renderReady === true", { timeout: 10_000, polling: 16 })
      .catch(() => {
        /* proceed anyway after timeout; lint surface will catch instability */
      });
    if (profile) {
      const prof = await this.page.evaluate(
        () => (window as unknown as { __fc?: { _seekProfile?: Record<string, number> } }).__fc?._seekProfile,
      );
      process.stderr.write(
        `\n[seek] frame ${this.frameNo} ${JSON.stringify(prof, (_k, v) => (typeof v === "number" ? Math.round(v) : v))}\n`,
      );
    }

    const start = performance.now();
    let data: Buffer;
    if (this.useBeginFrame && this.cdp) {
      const res = (await this.cdp.send("HeadlessExperimental.beginFrame", {
        frameTimeTicks: this.tickBase + this.frameNo * this.intervalMs,
        interval: this.intervalMs,
        noDisplayUpdates: false,
        screenshot: {
          format: this.opts.format === "jpeg" ? "jpeg" : "png",
          quality: this.opts.format === "jpeg" ? (this.opts.jpegQuality ?? 85) : undefined,
        },
      })) as { screenshotData?: string };
      if (!res.screenshotData) throw new Error("beginFrame returned no screenshotData");
      data = Buffer.from(res.screenshotData, "base64");
    } else {
      data = Buffer.from(
        await this.page.screenshot({
          type: this.opts.format === "jpeg" ? "jpeg" : "png",
          quality: this.opts.format === "jpeg" ? (this.opts.jpegQuality ?? 85) : undefined,
          captureBeyondViewport: false,
          omitBackground: this.opts.alpha === true,
        }),
      );
    }
    const durationUs = Math.round((performance.now() - start) * 1000);
    if (profile) {
      const shot = performance.now() - start;
      const total = performance.now() - t0;
      process.stderr.write(
        `\n[capture] frame ${this.frameNo} t=${t.toFixed(2)} total=${total.toFixed(0)}ms shot=${shot.toFixed(0)}ms\n`,
      );
    }
    await onFrame({ frame: this.frameNo++, data, durationUs });
  }

  get supportsBeginFrame(): boolean {
    return this.useBeginFrame;
  }
}
