import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Background removal (MV8) — U²-Net human segmentation via onnxruntime-node,
 * same model class HyperFrames uses but our own implementation. Apache-2.0
 * model from the rembg project's GitHub releases; downloaded on first use.
 *
 * Image → PNG with alpha. Video → WebM VP9 with alpha (yuva420p).
 * Temporal smoothing: each frame's mask is blended toward the previous frame's
 * to suppress flicker (U²-Net has no temporal prior).
 */

const MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx";
const MODEL_SIZE = 320; // model input is 320×320

function modelDir(): string {
  return join(process.env.HOME ?? tmpdir(), ".cache", "framecraft", "models");
}

export async function ensureModel(): Promise<string> {
  const dir = modelDir();
  const path = join(dir, "u2net_human_seg.onnx");
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.download`;
  await new Promise<void>((resolve, reject) => {
    httpsGet(MODEL_URL, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        httpsGet(res.headers.location, (r2) => {
          const out = createWriteStream(tmp);
          r2.pipe(out);
          out.on("finish", () => out.close(() => resolve()));
          r2.on("error", reject);
        }).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`model download: HTTP ${res.statusCode}`));
      const out = createWriteStream(tmp);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      res.on("error", reject);
    }).on("error", reject);
  });
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
  return path;
}

let _session: unknown = null;
async function session(): Promise<{
  run(i: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}> {
  if (!_session) {
    const ort = await import("onnxruntime-node");
    _session = await ort.InferenceSession.create(await ensureModel(), {
      executionProviders: process.platform === "darwin" ? ["coreml", "cpu"] : ["cpu"],
    });
  }
  return _session as never;
}

/** Run U²-Net on an RGBA image buffer → alpha mask (0..255), WxH. */
async function maskFor(rgba: Buffer, width: number, height: number): Promise<Float32Array> {
  const ort = await import("onnxruntime-node");
  const sharp = (await import("sharp")).default;

  const { data } = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(MODEL_SIZE, MODEL_SIZE)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // NCHW float32 with ImageNet mean/std normalization (rembg's transform).
  const input = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const px = MODEL_SIZE * MODEL_SIZE;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  for (let i = 0; i < px; i++) {
    for (let c = 0; c < 3; c++) {
      input[c * px + i] = ((data[i * 3 + c] ?? 0) / 255 - (MEAN[c] ?? 0)) / (STD[c] ?? 1);
    }
  }
  const sess = await session();
  const out = await sess.run({
    "input.1": new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });
  const outKey = Object.keys(out)[0];
  const m = outKey ? out[outKey]?.data : undefined;
  if (!m) throw new Error("u2net produced no output tensor");

  // Normalize mask to 0..1 then upsample to WxH via sharp.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of m) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const u8 = Buffer.alloc(px);
  for (let i = 0; i < px; i++) u8[i] = Math.round((((m[i] ?? 0) - min) / range) * 255);
  // U²-Net's silhouette runs ~2 model-px loose; a 3×3 min-filter at 320²
  // erodes it before the upscale (deterministic — sharp blur+threshold
  // reshuffles channels on 1-ch raw input).
  const tight = Buffer.from(u8);
  for (let pass = 0; pass < 3; pass++) {
    const src = Buffer.from(tight);
    for (let y = 0; y < MODEL_SIZE; y++) {
      for (let x = 0; x < MODEL_SIZE; x++) {
        let mn = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < MODEL_SIZE && xx >= 0 && xx < MODEL_SIZE) {
              const v = src[yy * MODEL_SIZE + xx] ?? 0;
              if (v < mn) mn = v;
            }
          }
        }
        tight[y * MODEL_SIZE + x] = mn;
      }
    }
  }
  // sharp upsamples 1-channel raw to 3 channels — force back to a single
  // channel or the RGBA alpha plane comes out striped (3× expected bytes).
  const { data: big } = await sharp(tight, {
    raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 },
  })
    .resize(width, height)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Float32Array(big);
}

/** Compose mask over an RGBA buffer (in-place). smoothing blends with prev. */
function applyMask(
  rgba: Buffer,
  mask: Float32Array,
  prev: Float32Array | null,
  smoothing: number,
): Float32Array {
  const px = rgba.length / 4;
  const out = new Float32Array(px);
  for (let i = 0; i < px; i++) {
    const m = prev ? (mask[i] ?? 0) * (1 - smoothing) + (prev[i] ?? 0) * smoothing : (mask[i] ?? 0);
    // Soft threshold: min-max normalization inflates weak-confidence pixels
    // into a halo of background around the subject. Cut below ~35%, keep the
    // 35–70% ramp for edge softness.
    const t = m <= 90 ? 0 : m >= 180 ? 255 : ((m - 90) / 90) * 255;
    out[i] = t;
    rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(t)));
  }
  return out;
}

export async function removeBackgroundImage(input: string, out: string): Promise<{ path: string }> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await maskFor(data, info.width, info.height);
  applyMask(data, mask, null, 0);
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(out);
  return { path: out };
}

export async function removeBackgroundVideo(opts: {
  input: string;
  out: string;
  ffmpeg?: string;
  ffprobe?: string;
  smoothing?: number; // 0..1 mask blend with previous frame
  start?: number;
  end?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ path: string; frames: number }> {
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const ffprobe = opts.ffprobe ?? "ffprobe";
  const smoothing = opts.smoothing ?? 0.4;
  const sharp = (await import("sharp")).default;

  const { stdout } = await execFileP(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate",
    "-of",
    "json",
    opts.input,
  ]);
  const meta = JSON.parse(stdout) as {
    streams: Array<{ width: number; height: number; r_frame_rate: string }>;
  };
  const st = meta.streams[0];
  if (!st) throw new Error(`no video stream in ${opts.input}`);
  const [fn, fd] = st.r_frame_rate.split("/").map(Number);
  const fps = fn && fd ? fn / fd : 30;

  const work = await mkdtemp(join(tmpdir(), "fc-bg-"));
  const framesDir = join(work, "in");
  const outDir = join(work, "out");
  await mkdir(framesDir);
  await mkdir(outDir);

  const vfArgs = ["-i", opts.input, "-vf", `fps=${fps}`];
  if (opts.start != null) vfArgs.push("-ss", String(opts.start));
  if (opts.end != null) vfArgs.push("-to", String(opts.end));
  await execFileP(ffmpeg, ["-y", ...vfArgs, join(framesDir, "f%06d.png")]);

  const frames = (await readdir(framesDir)).filter((f) => f.endsWith(".png")).sort();
  let prev: Float32Array | null = null;
  for (const frame of frames) {
    const { data, info } = await sharp(join(framesDir, frame))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mask = await maskFor(data, info.width, info.height);
    prev = applyMask(data, mask, prev, smoothing);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toFile(join(outDir, frame));
    opts.onProgress?.(frames.indexOf(frame) + 1, frames.length);
  }

  await execFileP(ffmpeg, [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(outDir, "f%06d.png"),
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    opts.out,
  ]);
  await rm(work, { recursive: true, force: true });
  return { path: opts.out, frames: frames.length };
}
