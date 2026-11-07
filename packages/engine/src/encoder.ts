import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface EncodeOpts {
  ffmpeg: string;
  out: string;
  fps: number;
  width: number;
  height: number;
  /** libx264 crf or preset knobs (04 §7). */
  crf?: number;
  preset?: string;
  codec?: "h264" | "h265" | "vp9" | "prores";
  alpha?: boolean;
  pixelFormat?: string;
  onStderr?: (line: string) => void;
}

/**
 * Streaming encoder: PNG/JPEG frames are written to ffmpeg stdin as image2pipe.
 * No intermediate files (04 §4). Produces a video-only file; audio is muxed
 * later by the producer so it can be mixed deterministically.
 */
export class StreamingEncoder {
  private proc?: ChildProcess;
  private stderrTail = "";
  private err?: Error;
  private done: Promise<void>;

  constructor(private opts: EncodeOpts) {
    const args = this.args();
    this.proc = spawn(opts.ffmpeg, ["-hide_banner", "-y", ...args], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let buf = "";
    this.proc.stderr?.on("data", (d) => {
      const s = d.toString();
      this.stderrTail = (this.stderrTail + s).slice(-4000);
      buf += s;
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        opts.onStderr?.(line);
      }
    });
    this.done = new Promise<void>((resolve, reject) => {
      this.proc?.on("error", reject);
      this.proc?.on("exit", (code) => {
        if (this.err) reject(this.err);
        else if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}:\n${this.stderrTail}`));
      });
    });
    // Observed by finish(); this guard keeps an intentional kill() (no
    // finish() call) from surfacing as an unhandled rejection.
    this.done.catch(() => {});
    this.proc.stdin?.on("error", (e) => {
      // EPIPE when ffmpeg dies first.
      this.err = this.err ?? new Error(`stdin pipe error: ${String(e)}`);
    });
  }

  private args(): string[] {
    const o = this.opts;
    const pixFmt = o.alpha ? "yuva420p" : (o.pixelFormat ?? "yuv420p");
    const args = [
      "-f",
      "image2pipe",
      "-framerate",
      String(o.fps),
      "-i",
      "pipe:0",
      "-an", // no audio in this pass; producer muxes later
    ];
    const codec = o.codec ?? "h264";
    if (codec === "h264") {
      args.push("-c:v", "libx264", "-preset", o.preset ?? "medium", "-crf", String(o.crf ?? 18));
      // JPEG pipe input is full-range; without the format filter libx264 keeps
      // yuvj420p and players misread the range.
      if (!o.alpha) args.push("-vf", "format=yuv420p");
      args.push("-pix_fmt", pixFmt);
      args.push("-movflags", "+faststart");
    } else if (codec === "h265") {
      args.push("-c:v", "libx265", "-crf", String(o.crf ?? 20), "-pix_fmt", pixFmt, "-tag:v", "hvc1");
    } else if (codec === "vp9") {
      args.push("-c:v", "libvpx-vp9", "-crf", String(o.crf ?? 32), "-b:v", "0", "-pix_fmt", pixFmt);
      args.push("-auto-alt-ref", "0"); // required for alpha
    } else if (codec === "prores") {
      args.push(
        "-c:v",
        "prores_ks",
        "-profile:v",
        o.alpha ? "4444" : "standard",
        "-pix_fmt",
        o.alpha ? "yuva444p10le" : "yuv422p10le",
      );
    }
    return [...args, o.out];
  }

  writeFrame(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin) return reject(new Error("encoder stdin closed"));
      if (this.err) return reject(this.err);
      const ok = stdin.write(data, (e) => (e ? reject(e) : resolve()));
      if (!ok) {
        stdin.once("drain", () => resolve());
      }
    });
  }

  async finish(): Promise<void> {
    this.proc?.stdin?.end();
    await this.done;
  }

  kill(): void {
    this.proc?.kill("SIGKILL");
  }
}

/** Chunked encoder: encode a frame range to an intermediate segment file. */
export async function encodeChunkToFile(
  opts: EncodeOpts & { dir: string; name: string },
  frames: AsyncIterable<Buffer>,
): Promise<string> {
  await mkdir(opts.dir, { recursive: true });
  const out = `${opts.dir}/${opts.name}`;
  const enc = new StreamingEncoder({ ...opts, out });
  try {
    for await (const f of frames) await enc.writeFrame(f);
    await enc.finish();
    return out;
  } catch (e) {
    enc.kill();
    throw e;
  }
}

/** Ensure the directory for an output file exists. */
export async function ensureOutDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
