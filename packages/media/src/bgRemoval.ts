import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Background removal (MV8) — portrait matting via onnxruntime-node.
 *
 * Default model: MODNet (Apache-2.0, ZHKKKe/MODNet; ONNX export hosted at
 * huggingface.co/Xenova/modnet). It emits a continuous alpha matte — real
 * hair edge detail — at 512². Fallback: u2net_human_seg (Apache-2.0, rembg
 * GitHub releases) at 320², a binary-ish segmentation mask. Both download
 * on first use into ~/.cache/donova/models; a LICENSE note lands beside
 * each file.
 *
 * Image → PNG with alpha. Video → WebM VP9 with alpha (yuva420p).
 *
 * Pipeline per frame:
 *   1. letterbox the frame into the model's square input (never squash)
 *   2. run the model, take its probability matte directly (frame-stable —
 *      per-frame min/max drifted the fg/bg level and flickered edges)
 *   3. keep the largest connected component (drops wall patches, outlets)
 *      and fill holes inside it (fixes see-through light clothing)
 *   4. upsample to full res, then guided-filter the edge against the real
 *      pixels so the silhouette follows the frame, not the model-res guess
 *   5. blend toward the previous frame's mask only where it is stable —
 *      suppresses flicker without smearing real motion
 */

export type MatteModel = "modnet" | "u2net";

interface ModelSpec {
  file: string;
  url: string;
  /** square model input side */
  size: number;
  inputName: string;
  /** undefined = use the first output */
  outputName?: string;
  mean: [number, number, number];
  std: [number, number, number];
  /** u2net's silhouette runs ~2 model-px loose; erode after cleaning */
  erode?: number;
  license: string;
}

const MODELS: Record<MatteModel, ModelSpec> = {
  modnet: {
    file: "modnet.onnx",
    url: "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx",
    size: 512,
    inputName: "input",
    outputName: "output",
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    license:
      "MODNet — Real-Time Trimap-Free Portrait Matting via Objective Decomposition (AAAI 2022)\n" +
      "https://github.com/ZHKKKe/MODNet — Apache License 2.0\n" +
      "ONNX export: huggingface.co/Xenova/modnet\n",
  },
  u2net: {
    file: "u2net_human_seg.onnx",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx",
    size: 320,
    inputName: "input.1",
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    erode: 1,
    license:
      "U^2-Net human segmentation (u2net_human_seg.onnx)\n" +
      "https://github.com/xuebinqin/U-2-Net — Apache License 2.0\n" +
      "Weights redistributed via github.com/danielgatis/rembg releases\n",
  },
};

function modelDir(): string {
  return join(process.env.HOME ?? tmpdir(), ".cache", "donova", "models");
}

export async function ensureModel(model: MatteModel = "modnet"): Promise<string> {
  const spec = MODELS[model];
  const dir = modelDir();
  const path = join(dir, spec.file);
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.download`;
    await new Promise<void>((resolve, reject) => {
      httpsGet(spec.url, function get(res) {
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
          httpsGet(res.headers.location, get).on("error", reject);
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
  }
  if (!existsSync(`${path}.LICENSE.txt`)) await writeFile(`${path}.LICENSE.txt`, spec.license, "utf8");
  return path;
}

const _sessions = new Map<MatteModel, unknown>();
async function session(model: MatteModel): Promise<{
  run(i: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}> {
  let s = _sessions.get(model);
  if (!s) {
    const ort = await import("onnxruntime-node");
    s = await ort.InferenceSession.create(await ensureModel(model), {
      executionProviders: process.platform === "darwin" ? ["coreml", "cpu"] : ["cpu"],
    });
    _sessions.set(model, s);
  }
  return s as never;
}

/* ---------------------------------- masks --------------------------------- */

/** 4-connected components over a binary grid; returns per-pixel label ids. */
function components(bin: Uint8Array, size: number): { labels: Int32Array; sizes: Map<number, number> } {
  const n = size * size;
  const labels = new Int32Array(n).fill(-1);
  const sizes = new Map<number, number>();
  let next = 0;
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!bin[s] || labels[s] !== -1) continue;
    let top = 0;
    stack[top++] = s;
    labels[s] = next;
    let count = 0;
    while (top > 0) {
      const i = stack[--top] as number;
      count++;
      const x = (i as number) % size;
      const y = ((i as number) / size) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, y > 0 ? i - size : -1, y < size - 1 ? i + size : -1];
      for (const j of nb) if (j >= 0 && bin[j] && labels[j] === -1) { labels[j] = next; stack[top++] = j; }
    }
    sizes.set(next as number, count as number);
    next++;
  }
  return { labels, sizes };
}

/**
 * Clean a model-res probability mask: keep the largest foreground component,
 * then fill holes inside it (background pockets fully enclosed by it).
 */
function cleanModelMask(u8: Uint8Array, size: number): { mask: Uint8Array; dropped: number } {
  const n = size * size;
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = (u8[i] ?? 0) >= 128 ? 1 : 0;

  const { labels, sizes } = components(fg, size);
  let best = -1;
  let bestSize = 0;
  for (const [id, sz] of sizes) if (sz > bestSize) { best = id; bestSize = sz; }
  if (best === -1) return { mask: u8, dropped: 0 };

  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) keep[i] = labels[i] === best ? (u8[i] ?? 0) : 0;

  // hole fill: background that can't reach the border becomes foreground
  const bg = new Uint8Array(n);
  for (let i = 0; i < n; i++) bg[i] = labels[i] === best ? 0 : 1;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  for (let x = 0; x < size; x++)
    for (const y of [0, size - 1]) { const i = y * size + x; if (bg[i]) { outside[i] = 1; stack.push(i); } }
  for (let y = 0; y < size; y++)
    for (const x of [0, size - 1]) { const i = y * size + x; if (bg[i] && !outside[i]) { outside[i] = 1; stack.push(i); } }
  while (stack.length) {
    const i = stack.pop() ?? 0;
    const x = i % size;
    const y = (i / size) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, y > 0 ? i - size : -1, y < size - 1 ? i + size : -1])
      if (j >= 0 && bg[j] && !outside[j]) { outside[j] = 1; stack.push(j); }
  }
  for (let i = 0; i < n; i++) if (bg[i] && !outside[i]) keep[i] = 255;
  return { mask: keep, dropped: Math.max(0, sizes.size - 1) };
}

/** Light erosion at model-res (U²-Net's silhouette runs ~2 model-px loose). */
function erode(u8: Uint8Array, size: number, passes: number): Uint8Array {
  let cur = u8;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Uint8Array(cur);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let mn = 255;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < size && xx >= 0 && xx < size) {
              const v = cur[yy * size + xx] ?? 0;
              if ((v ?? 0) < mn) mn = v ?? 0;
            }
          }
        out[y * size + x] = mn;
      }
    }
    cur = out;
  }
  return cur;
}

/* ------------------------------ guided filter ------------------------------ */

/** Separable box mean on a row-major Float32 grid (prefix-sum, O(n)). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const cum = new Float32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) cum[x + 1] = (cum[x] ?? 0) + (src[row + x] ?? 0);
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      tmp[row + x] = ((cum[b + 1] ?? 0) - (cum[a] ?? 0)) / (b - a + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) cum[y + 1] = (cum[y] ?? 0) + (tmp[y * w + x] ?? 0);
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      out[y * w + x] = ((cum[b + 1] ?? 0) - (cum[a] ?? 0)) / (b - a + 1);
    }
  }
  return out;
}

/**
 * Guided filter: align a soft mask (0..255) to the luma edges of a guide image
 * at the same resolution. He Kaiming et al., ECCV 2010 — a standard,
 * deterministic, linear-complexity edge-preserving smoother.
 */
function guidedFilter(guide: Float32Array, mask: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const meanG = boxMean(guide, w, h, r);
  const meanM = boxMean(mask, w, h, r);
  const gm = new Float32Array(n);
  const gg = new Float32Array(n);
  for (let i = 0; i < n; i++) { gm[i] = (guide[i] ?? 0) * (mask[i] ?? 0); gg[i] = (guide[i] ?? 0) * (guide[i] ?? 0); }
  const meanGM = boxMean(gm, w, h, r);
  const meanGG = boxMean(gg, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = (meanGM[i] ?? 0) - (meanG[i] ?? 0) * (meanM[i] ?? 0);
    const varG = (meanGG[i] ?? 0) - (meanG[i] ?? 0) * (meanG[i] ?? 0);
    a[i] = cov / (varG + eps);
    b[i] = (meanM[i] ?? 0) - (a[i] ?? 0) * (meanG[i] ?? 0);
  }
  const meanA = boxMean(a, w, h, r);
  const meanB = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (meanA[i] ?? 0) * (guide[i] ?? 0) + (meanB[i] ?? 0);
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/* --------------------------------- infer ---------------------------------- */

export interface MaskStats {
  /** dropped disconnected components (islands like wall patches) */
  islandsDropped: number;
  /** fraction of frame that ended up opaque (0..1) */
  coverage: number;
}

/** Run the matte model on an RGBA image buffer → alpha mask (0..255), WxH. */
export async function maskFor(
  rgba: Buffer,
  width: number,
  height: number,
  model: MatteModel = "modnet",
): Promise<{ mask: Float32Array; stats: MaskStats }> {
  const ort = await import("onnxruntime-node");
  const sharp = (await import("sharp")).default;
  const spec = MODELS[model];
  const S = spec.size;

  // 1. letterbox into the square model input — never squash 9:16 into 1:1
  const scale = Math.min(S / width, S / height);
  const rw = Math.max(1, Math.round(width * scale));
  const rh = Math.max(1, Math.round(height * scale));
  const ox = Math.floor((S - rw) / 2);
  const oy = Math.floor((S - rh) / 2);
  const { data } = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(rw, rh)
    .removeAlpha()
    .extend({ top: oy, bottom: S - rh - oy, left: ox, right: S - rw - ox, background: { r: 114, g: 114, b: 114 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // NCHW float32 with the model's own mean/std normalization.
  const input = new Float32Array(3 * S * S);
  const px = S * S;
  for (let i = 0; i < px; i++)
    for (let c = 0; c < 3; c++) input[c * px + i] = ((data[i * 3 + c] ?? 0) / 255 - (spec.mean[c] ?? 0)) / (spec.std[c] ?? 1);

  const sess = await session(model);
  const out = await sess.run({
    [spec.inputName]: new ort.Tensor("float32", input, [1, 3, S, S]),
  });
  const outKey = spec.outputName ?? Object.keys(out)[0];
  const m = outKey ? out[outKey]?.data : undefined;
  if (!m) throw new Error(`${model} produced no output tensor`);

  // 2. stable normalization: this ONNX build emits probabilities (sigmoid
  // is baked in), so the values are already on the same 0..1 scale every
  // frame — unlike the old per-frame min/max stretch, which drifted the
  // fg/bg level frame to frame and flickered edges. Clamp defensively.
  const u8 = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    const v = m[i] ?? 0;
    u8[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }

  // 3. largest component + hole fill at model-res; u2net's silhouette
  // runs loose so it gets a light erosion — MODNet's soft matte doesn't.
  const { mask: cleaned, dropped } = cleanModelMask(u8, S);
  const tightened = spec.erode ? erode(cleaned, S, spec.erode) : cleaned;

  // 4. upsample the cleaned letterbox region back to full res
  const { data: cropped } = await sharp(Buffer.from(tightened), {
    raw: { width: S, height: S, channels: 1 },
  })
    .extract({ left: ox, top: oy, width: rw, height: rh })
    .resize(width, height, { kernel: "lanczos3" })
    .extractChannel(0) // sharp promotes 1-ch raw to RGB — pin it back down
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Float32Array(cropped.length);
  for (let i = 0; i < cropped.length; i++) mask[i] = cropped[i] ?? 0;

  // coverage + island count for the quality report
  let cov = 0;
  for (const v of mask) if (v >= 128) cov++;
  const stats: MaskStats = { islandsDropped: dropped, coverage: cov / mask.length };

  return { mask, stats };
}

/** Luma guide + mask for the guided filter at a bounded work resolution. */
export async function guidedRefine(rgba: Buffer, mask: Float32Array, width: number, height: number): Promise<Float32Array> {
  const sharp = (await import("sharp")).default;
  const wScale = Math.min(1, 960 / Math.max(width, height));
  const gw = Math.max(1, Math.round(width * wScale));
  const gh = Math.max(1, Math.round(height * wScale));

  const { data: guideData } = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(gw, gh)
    .removeAlpha()
    .toColourspace("b-w") // 1-channel luma, not promoted RGB
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: maskData } = await sharp(Buffer.from(Uint8Array.from(mask, (v) => v)), {
    raw: { width, height, channels: 1 },
  })
    .resize(gw, gh)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const g = new Float32Array(gw * gh);
  const p = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) { g[i] = (guideData[i] ?? 0) / 255; p[i] = (maskData[i] ?? 0) / 255; }

  const refined = guidedFilter(g, p, gw, gh, 10, 0.02 * 0.02);

  const { data: up } = await sharp(Buffer.from(Uint8Array.from(refined, (v) => Math.round(v * 255))), {
    raw: { width: gw, height: gh, channels: 1 },
  })
    .resize(width, height, { kernel: "lanczos3" })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(up.length);
  for (let i = 0; i < up.length; i++) out[i] = up[i] ?? 0;
  return out;
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
    const cur = mask[i] ?? 0;
    const pv = prev?.[i] ?? cur;
    // selective temporal blend: only smooth pixels that aren't moving, so
    // flicker dies but real motion doesn't smear.
    const stable = Math.abs(cur - pv) < 48;
    const m = prev && stable ? pv * smoothing + cur * (1 - smoothing) : cur;
    // Soft threshold: weak-confidence halo pixels get cut; the 35–70% ramp
    // keeps edge softness.
    const t = m <= 90 ? 0 : m >= 180 ? 255 : ((m - 90) / 90) * 255;
    out[i] = t;
    rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(t)));
  }
  return out;
}

export interface MatteReport {
  frames: number;
  /** mean |alpha delta| between consecutive frames (0..255) — flicker index */
  flicker: number;
  coverageMin: number;
  coverageMax: number;
}

export async function removeBackgroundImage(input: string, out: string, model: MatteModel = "modnet"): Promise<{ path: string }> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { mask } = await maskFor(data, info.width, info.height, model);
  const refined = await guidedRefine(data, mask, info.width, info.height);
  applyMask(data, refined, null, 0);
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
  model?: MatteModel;
  start?: number;
  end?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ path: string; frames: number; report: MatteReport }> {
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
  let prevAlpha: Float32Array | null = null;
  let flickerSum = 0;
  let flickerN = 0;
  let coverageMin = 1;
  let coverageMax = 0;
  for (const frame of frames) {
    const { data, info } = await sharp(join(framesDir, frame))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { mask, stats } = await maskFor(data, info.width, info.height, opts.model);
    const refined = await guidedRefine(data, mask, info.width, info.height);
    const alpha = applyMask(data, refined, prev, smoothing);
    coverageMin = Math.min(coverageMin, stats.coverage);
    coverageMax = Math.max(coverageMax, stats.coverage);
    if (prevAlpha) {
      let d = 0;
      for (let i = 0; i < alpha.length; i++) d += Math.abs((alpha[i] ?? 0) - (prevAlpha[i] ?? 0));
      flickerSum += d / alpha.length;
      flickerN++;
    }
    prevAlpha = alpha;
    prev = refined;
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
    // Keyframe every 0.5s: live <video> previews seek the webm, and Chrome's
    // VP9-alpha decoder shows frame 0 frozen when a seek lands mid-GOP.
    "-g",
    "15",
    "-auto-alt-ref",
    "0",
    opts.out,
  ]);
  await rm(work, { recursive: true, force: true });
  return {
    path: opts.out,
    frames: frames.length,
    report: { frames: frames.length, flicker: flickerN ? flickerSum / flickerN : 0, coverageMin, coverageMax },
  };
}
