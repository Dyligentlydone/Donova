import { locateFfmpeg, runFfmpegCapture } from "@framecraft/engine";

/** `framecraft compare` — PSNR between two video files (regression + agent verify). */
export async function compareVideos(a: string, b: string): Promise<{ psnr: number; raw: string }> {
  const { ffmpeg } = await locateFfmpeg();
  // PSNR logs to stderr; runFfmpegCapture captures stdout — use lavfi and parse stderr via execFile.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  let stderr = "";
  try {
    const res = await run(ffmpeg, ["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], {
      maxBuffer: 1 << 20,
    });
    stderr = res.stderr ?? "";
  } catch (e) {
    stderr = (e as { stderr?: string }).stderr ?? String(e);
  }
  const m = /average:(\d+(?:\.\d+)?|inf)/.exec(stderr);
  return { psnr: m ? (m[1] === "inf" ? Number.POSITIVE_INFINITY : Number(m[1])) : 0, raw: stderr };
}
