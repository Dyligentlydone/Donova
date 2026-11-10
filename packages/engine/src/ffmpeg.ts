import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { ENV_PREFIX, LEGACY } from "@donova/contract";

const execFileAsync = promisify(execFile);

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

let cached: FfmpegPaths | null = null;

/** Locate ffmpeg/ffprobe: env override → ffmpeg-static/ffprobe-static → PATH. */
export async function locateFfmpeg(): Promise<FfmpegPaths> {
  if (cached) return cached;
  const envFfmpeg =
    process.env[`${ENV_PREFIX}FFMPEG`] ??
    LEGACY.envPrefixes.map((p) => process.env[`${p}FFMPEG`]).find(Boolean);
  const envFfprobe =
    process.env[`${ENV_PREFIX}FFPROBE`] ??
    LEGACY.envPrefixes.map((p) => process.env[`${p}FFPROBE`]).find(Boolean);

  let ffmpeg = envFfmpeg;
  let ffprobe = envFfprobe;

  if (!ffmpeg) {
    try {
      const req = createRequire(import.meta.url);
      ffmpeg = req("ffmpeg-static") as unknown as string;
    } catch {
      /* not installed */
    }
  }
  if (!ffprobe) {
    try {
      const req = createRequire(import.meta.url);
      ffprobe = (req("ffprobe-static") as unknown as { path: string }).path;
    } catch {
      /* not installed */
    }
  }

  ffmpeg = ffmpeg || "ffmpeg";
  ffprobe = ffprobe || "ffprobe";

  // Verify they run.
  await execFileAsync(ffmpeg, ["-version"]);
  await execFileAsync(ffprobe, ["-version"]);

  cached = { ffmpeg, ffprobe };
  return cached;
}

export interface ProbeResult {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Display-matrix rotation in degrees (e.g. -90 for portrait iPhone footage). */
  rotation?: number;
  hasAudio: boolean;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  pixFmt?: string;
  /** WebM/MOV alpha carried as a stream tag rather than pix_fmt (alpha_mode=1). */
  alphaMode?: boolean;
}

export async function probe(ffprobe: string, path: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
      pix_fmt?: string;
      side_data_list?: Array<{ rotation?: number | string }>;
      tags?: Record<string, string>;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const [rn, rd] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const sd = video?.side_data_list?.find((s) => s.rotation != null)?.rotation;
  const tagRot = video?.tags?.rotate;
  const rotation = sd != null ? Number(sd) : tagRot != null ? Number(tagRot) : undefined;
  return {
    duration: Number(data.format?.duration ?? 0),
    width: video?.width,
    height: video?.height,
    fps: rd ? (rn ?? 0) / rd : undefined,
    rotation: Number.isFinite(rotation) ? rotation : undefined,
    hasAudio: !!audio,
    codec: video?.codec_name ?? audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    pixFmt: video?.pix_fmt,
    alphaMode: video?.tags?.alpha_mode === "1" || video?.tags?.alpha_mode === "yes",
  };
}

export interface RunOpts {
  cwd?: string;
  /** Pipe stdin into the process. */
  input?: NodeJS.ReadableStream | Buffer;
  onStderr?: (line: string) => void;
  timeoutMs?: number;
}

/** Run ffmpeg, stream stderr to callback, reject on non-zero exit. */
export function runFfmpeg(ffmpeg: string, args: string[], opts: RunOpts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-y", ...args], {
      cwd: opts.cwd,
      stdio: [opts.input ? "pipe" : "ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    let buf = "";
    p.stderr?.on("data", (d) => {
      buf += d.toString();
      stderrTail = (stderrTail + d.toString()).slice(-4000);
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        opts.onStderr?.(line);
      }
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          p.kill("SIGKILL");
          reject(new Error(`ffmpeg timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : undefined;
    p.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    p.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}:\n${stderrTail}`));
    });
    if (opts.input && p.stdin) {
      const inp = opts.input;
      if (Buffer.isBuffer(inp)) {
        p.stdin.write(inp);
        p.stdin.end();
      } else {
        inp.pipe(p.stdin);
      }
    }
  });
}

/** Run ffprobe-free ffmpeg command and return stdout (for e.g. loudness json). */
export async function runFfmpegCapture(ffmpeg: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-y", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
