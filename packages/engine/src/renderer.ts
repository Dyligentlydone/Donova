import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR } from "@framecraft/contract";
import { getRuntimeSource } from "@framecraft/runtime";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { CaptureSession } from "./capture.js";
import { deterministicFlags, ensureChrome, profileDirFor, screenshotModeFlags } from "./chrome.js";
import { StreamingEncoder, ensureOutDir } from "./encoder.js";

export interface RenderToFramesOpts {
  /** Absolute URL to load (typically served by startFileServer). */
  url: string;
  /** Seconds; totalFrames = duration*fps when set. */
  duration: number;
  fps: number;
  width: number;
  height: number;
  /** Frame range (inclusive start, exclusive end). Defaults to all. */
  startFrame?: number;
  endFrame?: number;
  capture?: {
    format?: "png" | "jpeg";
    jpegQuality?: number;
    disableBeginFrame?: boolean;
    /** Output scale (device scale factor). 0.5 → half-res draft frames. */
    scale?: number;
  };
  /** Encoder pixel dims when they differ from viewport (scaled capture). */
  encoderWidth?: number;
  encoderHeight?: number;
  /** If true, show the (headed) browser — debugging only. */
  headed?: boolean;
  /** Extra flags appended to deterministicFlags(). */
  extraChromeFlags?: string[];
  onProgress?: (done: number, total: number) => void;
}

function probeCachePath(executablePath: string): string {
  const h = createHash("sha1").update(executablePath).digest("hex").slice(0, 12);
  const d = join(homedir(), CACHE_DIR, "probes");
  mkdirSync(d, { recursive: true });
  return join(d, `beginframe-${h}.json`);
}

/** Probe beginFrame support inside a sacrificial browser; cache verdict. */
async function probeBeginFrameSupport(
  executablePath: string,
  opts: RenderToFramesOpts,
  disabled?: boolean,
): Promise<boolean> {
  if (disabled) return false;
  const cachePath = probeCachePath(executablePath);
  try {
    if (existsSync(cachePath)) {
      const v = JSON.parse(readFileSync(cachePath, "utf8")) as { ok?: boolean };
      if (typeof v.ok === "boolean") return v.ok;
    }
  } catch {
    /* ignore cache errors */
  }
  let ok = false;
  let probeBrowser: Browser | undefined;
  try {
    probeBrowser = await puppeteer.launch({
      executablePath,
      headless: "shell" as never,
      args: [...deterministicFlags(), ...(opts.extraChromeFlags ?? [])],
      defaultViewport: { width: opts.width, height: opts.height, deviceScaleFactor: 1 },
    });
    const page = await probeBrowser.newPage();
    ok = await CaptureSession.probe(page, opts.fps, false);
  } catch {
    ok = false;
  }
  await probeBrowser?.close().catch(() => {});
  try {
    writeFileSync(cachePath, JSON.stringify({ ok, at: new Date().toISOString() }));
  } catch {
    /* non-fatal */
  }
  return ok;
}

export interface FrameSource {
  /** Iterate frames one at a time. */
  frames(): AsyncIterable<Buffer>;
  close(): Promise<void>;
  supportsBeginFrame(): boolean;
}

/** Launch a browser + page, inject runtime, expose per-frame PNG buffers. */
export async function openFrameSource(opts: RenderToFramesOpts): Promise<FrameSource> {
  const chrome = await ensureChrome({ headlessShell: true });
  // chrome-headless-shell supports HeadlessExperimental.beginFrame; regular
  // Chrome runs "new" headless and capture falls back to screenshots.
  const headlessMode = opts.headed ? false : chrome.headless === "shell" ? ("shell" as never) : true;
  // Probe beginFrame inside a sacrificial browser process — on some systems a
  // failed beginFrame crashes the whole browser, so it must be isolated from
  // the real capture browser (03 §6). The verdict is cached per executable.
  // It must run BEFORE launch: the capture browser's flags depend on it.
  const beginFrameOk = await probeBeginFrameSupport(
    chrome.executablePath,
    opts,
    opts.capture?.disableBeginFrame,
  );
  const browser: Browser = await puppeteer.launch({
    executablePath: chrome.executablePath,
    headless: headlessMode,
    args: [
      ...(beginFrameOk ? deterministicFlags() : screenshotModeFlags()),
      ...(opts.extraChromeFlags ?? []),
    ],
    userDataDir: profileDirFor(`${opts.url}#${opts.startFrame ?? 0}`),
    defaultViewport: { width: opts.width, height: opts.height, deviceScaleFactor: 1 },
    protocolTimeout: 120_000,
  });

  const page: Page = await browser.newPage();
  page.setDefaultTimeout(30_000);

  await page.goto(opts.url, { waitUntil: "load", timeout: 60_000 });
  await page.evaluate(getRuntimeSource());
  await page.waitForFunction("window.__playerReady === true", { timeout: 15_000 });

  const capture = new CaptureSession(page, {
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    format: opts.capture?.format ?? "jpeg",
    jpegQuality: opts.capture?.jpegQuality,
    disableBeginFrame: opts.capture?.disableBeginFrame,
    scale: opts.capture?.scale,
  });
  await capture.init();
  if (beginFrameOk) await capture.enableBeginFrame();

  const startFrame = opts.startFrame ?? 0;
  const endFrame = opts.endFrame ?? Math.round(opts.duration * opts.fps);
  const total = Math.max(0, endFrame - startFrame);

  async function* frames(): AsyncIterable<Buffer> {
    for (let f = 0; f < total; f++) {
      const frameNo = startFrame + f;
      const t = frameNo / opts.fps;
      let buf: Buffer | null = null;
      await capture.captureFrame(t, (cf) => {
        buf = cf.data;
      });
      if (!buf) throw new Error(`frame ${frameNo}: no data captured`);
      opts.onProgress?.(f + 1, total);
      yield buf;
    }
  }

  return {
    frames,
    supportsBeginFrame: () => capture.supportsBeginFrame,
    close: async () => {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

export interface RenderVideoOpts extends RenderToFramesOpts {
  ffmpeg: string;
  out: string;
  encoder?: {
    crf?: number;
    preset?: string;
    codec?: "h264" | "h265" | "vp9" | "prores";
    alpha?: boolean;
    pixelFormat?: string;
  };
  onEncodeStderr?: (line: string) => void;
}

/** Convenience: stream frames directly into an encoder → video-only file. */
export async function renderVideoOnly(
  opts: RenderVideoOpts,
): Promise<{ frames: number; beginFrame: boolean }> {
  await ensureOutDir(opts.out);
  const src = await openFrameSource(opts);
  const enc = new StreamingEncoder({
    ffmpeg: opts.ffmpeg,
    out: opts.out,
    fps: opts.fps,
    width: opts.encoderWidth ?? opts.width,
    height: opts.encoderHeight ?? opts.height,
    crf: opts.encoder?.crf,
    preset: opts.encoder?.preset,
    codec: opts.encoder?.codec,
    alpha: opts.encoder?.alpha,
    pixelFormat: opts.encoder?.pixelFormat,
    onStderr: opts.onEncodeStderr,
  });
  let n = 0;
  try {
    for await (const f of src.frames()) {
      await enc.writeFrame(f);
      n++;
    }
    await enc.finish();
  } finally {
    await src.close();
  }
  return { frames: n, beginFrame: src.supportsBeginFrame() };
}
