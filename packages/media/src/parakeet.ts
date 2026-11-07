import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { download, sha256File } from "./download.js";
import type { TranscriptWord } from "./types.js";

/**
 * NVIDIA Parakeet-TDT 0.6B v3 via sherpa-onnx-node — the higher-accuracy
 * engine (better WER than whisper-large-v3, ~5-10x faster). Model: CC-BY-4.0
 * (commercial use, NVIDIA attribution required — see NOTICE). Runtime:
 * Apache-2.0.
 *
 * Decode runs in a child process: onnxruntime can abort a process uncatchably.
 * Windows are cut at the quietest point near each boundary so no slice lands
 * inside a word; stretches that decode to nothing but still carry energy are
 * re-decoded with padding and spliced back in.
 */

export const PARAKEET_MODEL_LABEL = "parakeet-tdt-0.6b-v3";
export const PARAKEET_LANGUAGES =
  "en es fr de bg hr cs da nl et fi el hu it lv lt mt pl pt ro sk sl sv ru uk";

/** True when no language was asked for, or Parakeet transcribes it ("pt-BR" counts as pt). */
export function parakeetSpeaks(language?: string): boolean {
  const base = language?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return !base || PARAKEET_LANGUAGES.split(" ").includes(base);
}

const MODEL_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const MODEL_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";

export function parakeetModelDir(): string {
  return join(homedir(), ".cache", "framecraft", "parakeet", "parakeet-tdt-0.6b-v3-int8");
}

export interface ModelFile {
  name: string;
  bytes: number;
  sha256: string;
}

/** Order matters: encoder, decoder, joiner, tokens (see recognizerConfig). */
const PARAKEET_MODEL_FILES: readonly ModelFile[] = [
  {
    name: "encoder.int8.onnx",
    bytes: 652_184_281,
    sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
  },
  {
    name: "decoder.int8.onnx",
    bytes: 11_845_275,
    sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
  },
  {
    name: "joiner.int8.onnx",
    bytes: 6_355_277,
    sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
  },
  {
    name: "tokens.txt",
    bytes: 93_939,
    sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
  },
];

async function verifies(path: string, file: ModelFile): Promise<boolean> {
  const size = await stat(path).then(
    (s) => s.size,
    () => -1,
  );
  if (size !== file.bytes) return false;
  return (await sha256File(path)) === file.sha256;
}

/** True when all model files are present and verified. */
export async function parakeetModelInstalled(dir = parakeetModelDir()): Promise<boolean> {
  for (const f of PARAKEET_MODEL_FILES) {
    const size = await stat(join(dir, f.name)).then(
      (s) => s.size,
      () => -1,
    );
    if (size !== f.bytes) return false;
  }
  return true;
}

/** Download any missing model files, verify size + sha256, rename into place. */
export async function ensureParakeetModel(
  onBytes?: (done: number, total: number) => void,
  dir = parakeetModelDir(),
): Promise<boolean> {
  const missing: ModelFile[] = [];
  for (const file of PARAKEET_MODEL_FILES) {
    if (!(await verifies(join(dir, file.name), file))) missing.push(file);
  }
  const total = missing.reduce((sum, f) => sum + f.bytes, 0);
  const staging = `${dir}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  let done = 0;
  try {
    for (const file of missing) {
      const dest = join(dir, file.name);
      const temp = join(staging, file.name);
      await mkdir(dirname(temp), { recursive: true });
      const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file.name}`;
      await download(url, temp, (bytes) => onBytes?.(done + bytes, total)).catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not download ${file.name} from huggingface.co (${why}). Check your network and re-run.`,
        );
      });
      if (!(await verifies(temp, file))) {
        throw new Error(
          `${file.name} did not match its pinned size and sha256, so it was discarded. Re-run to retry.`,
        );
      }
      mkdirSync(dir, { recursive: true });
      renameSync(temp, dest);
      done += file.bytes;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return missing.length > 0;
}

/** The platforms sherpa-onnx-node publishes a native package for. */
const SUPPORTED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-ia32",
];

/** Why sherpa-onnx cannot run here, or null. Its Linux prebuilt needs glibc 2.32 (so no musl). */
export function sherpaUnsupportedReason(
  platform = process.platform,
  arch = process.arch,
  glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
    ?.glibcVersionRuntime,
): string | null {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.includes(target)) {
    return `Parakeet runs on ${SUPPORTED_TARGETS.join(", ")}; this system is ${target}.`;
  }
  if (platform !== "linux") return null;
  if (!glibc) return "Parakeet needs glibc 2.32 or newer; this Linux has no glibc (musl?).";
  const [major = 0, minor = 0] = glibc.split(".").map(Number);
  if (major > 2 || (major === 2 && minor >= 32)) return null;
  return `Parakeet needs glibc 2.32 or newer; this system has glibc ${glibc}.`;
}

/** Resolve sherpa-onnx-node from this package's deps, wherever cwd happens to be. */
function sherpaRuntimePath(): string {
  return createRequire(import.meta.url).resolve("sherpa-onnx-node");
}

/** Probe that the native binding actually loads — in a child, like decode. */
export async function sherpaRuntimeLoadError(timeoutMs = 30_000): Promise<string | null> {
  let runtimePath: string;
  try {
    runtimePath = sherpaRuntimePath();
  } catch (err) {
    return `sherpa-onnx-node is not installed (${err instanceof Error ? err.message : err})`;
  }
  const { execFile: exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec(
      process.execPath,
      [
        "-e",
        "try{require(process.env.FRAMECRAFT_SHERPA)}catch(e){console.error(String(e&&e.message||e));process.exit(1)}",
      ],
      { timeout: timeoutMs, env: { ...process.env, FRAMECRAFT_SHERPA: runtimePath } },
      (err, _stdout, stderr) => {
        if (!err) resolve(null);
        else resolve(stderr.trim() || err.message);
      },
    );
  });
}

// --- decode worker plumbing -------------------------------------------------

const RESULT_PREFIX = "FRAMECRAFT_PARAKEET_RESULT:";
const ERROR_PREFIX = "FRAMECRAFT_PARAKEET_ERROR:";
const WINDOW_PREFIX = "FRAMECRAFT_PARAKEET_WINDOW:";

/** One decoded window from sherpa-onnx: token times are relative to the window's `offset` (s). */
export interface SherpaWindow {
  offset: number;
  tokens: string[];
  timestamps: number[];
  durations?: number[];
}

function recognizerConfig(modelDir: string): object {
  const [encoder, decoder, joiner, tokens] = PARAKEET_MODEL_FILES.map((f) => join(modelDir, f.name));
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: 4,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
    decodingMethod: "greedy_search",
  };
}

/** At least 30 minutes, twice the audio length for slow CPUs; whole ms, within Node's timer limit. */
const decodeTimeoutMs = (audioSeconds: number) =>
  Math.min(2 ** 31 - 1, Math.max(1_800_000, Math.ceil(audioSeconds * 2000)));

const MAX_REASON_CHARS = 600;
const bounded = (why: string) => (why.length > MAX_REASON_CHARS ? `${why.slice(0, MAX_REASON_CHARS)}…` : why);

function failureReason(
  err: { killed?: boolean; signal?: unknown; code?: unknown } | null,
  stderr: string,
): string {
  const how = !err
    ? "exited without a result"
    : err.killed
      ? "was stopped (timeout or output limit)"
      : err.signal
        ? `crashed (${err.signal})`
        : `exited with code ${err.code}`;
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const why = lines.find((line) => line.startsWith(ERROR_PREFIX))?.slice(ERROR_PREFIX.length) ?? lines.at(-1);
  if (!why) return how;
  return `${how}: ${bounded(why)}`;
}

/** Decodes in a child process: onnxruntime aborts the whole process on some inputs, uncatchably. */
function decode(
  wavPath: string,
  modelDir: string,
  audioSeconds: number,
  onWindow?: (window: SherpaWindow, through: number) => void,
): Promise<SherpaWindow[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const worker = join(here, import.meta.url.endsWith(".ts") ? "sherpaWorker.ts" : "sherpaWorker.js");
  const input = { wavPath, runtimePath: sherpaRuntimePath(), config: recognizerConfig(modelDir) };
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [worker],
      {
        env: { ...process.env, FRAMECRAFT_PARAKEET_INPUT: JSON.stringify(input) },
        maxBuffer: 256 * 1024 * 1024,
        timeout: decodeTimeoutMs(audioSeconds),
      },
      (err, stdout, stderr) => {
        const line = stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
        if (!err && line) resolve(JSON.parse(line.slice(RESULT_PREFIX.length)));
        else reject(new Error(`Parakeet decoder ${failureReason(err, stderr)}`));
      },
    );
    if (onWindow && child.stdout) {
      createInterface({ input: child.stdout }).on("line", (l) => {
        if (!l.startsWith(WINDOW_PREFIX)) return;
        try {
          const streamed = JSON.parse(l.slice(WINDOW_PREFIX.length)) as {
            window: SherpaWindow;
            through: number;
          };
          onWindow(streamed.window, streamed.through);
        } catch {
          /* partial line */
        }
      });
    }
  });
}

// --- token/word assembly (worker + parent share these) -----------------------

const roundToMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Merge Parakeet's sub-word tokens into words on the space boundary. */
export function mergeWindowsToWords(windows: SherpaWindow[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const w of windows) {
    w.tokens.forEach((text, i) => {
      const start = roundToMs(w.offset + (w.timestamps[i] ?? 0));
      const end = roundToMs(start + (w.durations?.[i] ?? 0));
      const last = words[words.length - 1];
      if (text.startsWith(" ") || !last) words.push({ w: text.trim(), start, end });
      else {
        last.w += text;
        last.end = end;
      }
    });
  }
  return words.filter((x) => x.w.length > 0);
}

function meanEnergy(samples: Float32Array, from: number, to: number): number {
  let energy = 0;
  for (let i = from; i < to; i++) energy += (samples[i] ?? 0) ** 2;
  return energy / Math.max(1, to - from);
}

/**
 * Stretches (s) of at least 1 s without tokens that are about as loud as the window: skipped speech.
 * A window with no tokens at all is music or noise, not a skip.
 */
export function droppedSpeechGaps(
  samples: Float32Array,
  sampleRate: number,
  decoded: Omit<SherpaWindow, "offset">,
): [number, number][] {
  if (decoded.tokens.length === 0) return [];
  const loud = 0.3 * meanEnergy(samples, 0, samples.length);
  const { timestamps, durations } = decoded;
  const gapStarts = [0, ...timestamps.map((t, i) => t + (durations?.[i] ?? 0))];
  const gapEnds = [...timestamps, samples.length / sampleRate];
  const at = (seconds: number) => Math.round(seconds * sampleRate);
  return gapStarts
    .map((from, i): [number, number] => [from, gapEnds[i] ?? from])
    .filter(([from, to]) => to - from >= 1 && meanEnergy(samples, at(from), at(to)) > loud);
}

/** Number of trailing `a` entries that equal the leading `b` entries. */
function overlap(a: string[], b: string[]): number {
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (a.slice(-n).every((text, i) => text === b[i])) return n;
  }
  return 0;
}

interface Token {
  text: string;
  start: number;
  duration: number;
}

/** Tokens grouped into words: a token with a leading space starts one. */
function wordsOf(tokens: Token[]): Token[][] {
  const words: Token[][] = [];
  for (const t of tokens) {
    const last = words[words.length - 1];
    if (t.text.startsWith(" ") || !last) words.push([t]);
    else last.push(t);
  }
  return words;
}

const letters = (word: Token[]) =>
  word
    .map((t) => t.text)
    .join("")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/** How far from a gap edge the patch may re-hear the neighbouring word (measured: 0.26 s). */
const EDGE_SECONDS = 0.3;

/**
 * Adds the `patch` words, decoded from `offset` s into the window, that start inside the gap, minus
 * the gap's neighbours re-heard near its edges (compared as whole words, by letters).
 */
export function spliceGap(
  decoded: Omit<SherpaWindow, "offset">,
  patch: Omit<SherpaWindow, "offset">,
  offset: number,
  [from, to]: [number, number],
): Omit<SherpaWindow, "offset"> {
  const tokens = (w: Omit<SherpaWindow, "offset">, shift: number): Token[] =>
    w.tokens.map((text, i) => ({
      text,
      start: shift + (w.timestamps[i] ?? 0),
      duration: w.durations?.[i] ?? 0,
    }));
  const kept = wordsOf(tokens(decoded, 0));
  const added = wordsOf(tokens(patch, offset)).filter(([first]) => {
    const f = first?.start ?? 0;
    return f >= from && f < to;
  });
  const before = kept.filter(([first]) => (first?.start ?? 0) < from).map(letters);
  const after = kept.filter(([first]) => (first?.start ?? 0) >= to).map(letters);
  const head = added.filter(([first]) => (first?.start ?? 0) < from + EDGE_SECONDS).map(letters);
  const tail = added.filter(([first]) => (first?.start ?? 0) >= to - EDGE_SECONDS).map(letters);
  const fresh = added
    .slice(overlap(before, head), added.length - overlap(tail, after))
    .map(([first, ...rest]) => [
      { text: ` ${first?.text.trimStart() ?? ""}`, start: first?.start ?? 0, duration: first?.duration ?? 0 },
      ...rest,
    ]);
  const merged = [...kept, ...fresh].sort((a, b) => (a[0]?.start ?? 0) - (b[0]?.start ?? 0)).flat();
  return {
    tokens: merged.map((t) => t.text),
    timestamps: merged.map((t) => t.start),
    durations: merged.map((t) => t.duration),
  };
}

function quietestBlockCenter(samples: Float32Array, lo: number, hi: number, block: number): number {
  let best = hi;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let s = lo; s + block <= hi; s += block) {
    const energy = meanEnergy(samples, s, s + block);
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = s + block / 2;
    }
  }
  return best;
}

/**
 * Window boundaries (sample indices, first 0, last samples.length) about every `windowSeconds`,
 * each moved to the quietest 100 ms within ±5 s, so no cut lands inside a word.
 */
export function silenceCuts(samples: Float32Array, sampleRate: number, windowSeconds = 30): number[] {
  const cuts = [0];
  const total = samples.length;
  const step = Math.round(windowSeconds * sampleRate);
  const wobble = Math.round(5 * sampleRate);
  const block = Math.round(0.1 * sampleRate);
  for (let at = step; at + step * 0.5 < total; at += step) {
    const lo = Math.max(cuts[cuts.length - 1] ?? 0, at - wobble);
    const hi = Math.min(total, at + wobble);
    cuts.push(Math.round(quietestBlockCenter(samples, lo, hi, block)));
  }
  cuts.push(total);
  return cuts;
}

export const WORKER_PREFIXES = { RESULT_PREFIX, ERROR_PREFIX, WINDOW_PREFIX };

/** Full engine path: wav → worker decode → word list. */
export async function transcribeWithParakeet(
  wavPath: string,
  audioSeconds: number,
  opts?: { onWindow?: (through: number) => void; modelDir?: string },
): Promise<TranscriptWord[]> {
  const modelDir = opts?.modelDir ?? parakeetModelDir();
  const loadError = await sherpaRuntimeLoadError();
  if (loadError) {
    throw new Error(
      `Parakeet runtime does not load (${loadError}). Reinstall dependencies, or use --engine whisper.`,
    );
  }
  const windows = await decode(wavPath, modelDir, audioSeconds, (_w, through) => opts?.onWindow?.(through));
  return mergeWindowsToWords(windows);
}
