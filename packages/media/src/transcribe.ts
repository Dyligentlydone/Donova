import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { locateFfmpeg, probe, runFfmpeg } from "@framecraft/engine";
import type { Transcript, TranscriptWord } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Local whisper.cpp transcription (17 §3.2).
 *
 * Models: ggml-* files from the ggerganov/whisper.cpp Hugging Face repo,
 * cached under ~/.cache/framecraft/whisper/models/, SHA-256 verified against
 * the pinned manifest below (hashes computed from known-good downloads).
 *
 * Binary: `whisper-cli` (whisper.cpp ≥1.7) on PATH — `brew install whisper-cpp`.
 * The CLI never auto-installs the binary; `doctor` reports it.
 */

export const WHISPER_MODELS: Record<string, { file: string; sha256?: string; sizeMB: number }> = {
  "tiny.en": { file: "ggml-tiny.en.bin", sizeMB: 75 },
  "base.en": { file: "ggml-base.en.bin", sizeMB: 142 },
  "small.en": {
    file: "ggml-small.en.bin",
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    sizeMB: 466,
  },
  "medium.en": { file: "ggml-medium.en.bin", sizeMB: 1500 },
};

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export function whisperModelDir(): string {
  return join(homedir(), ".cache", "framecraft", "whisper", "models");
}

export async function findWhisperCli(): Promise<string | null> {
  for (const bin of ["whisper-cli", "whisper-cpp", "main"]) {
    try {
      await execFileAsync(bin, ["--help"], { timeout: 5000 });
      return bin;
    } catch {
      /* not this one */
    }
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function download(url: string, dest: string, onBytes?: (n: number) => void): Promise<void> {
  await mkdir(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.part`;
  await new Promise<void>((resolvePromise, reject) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        req.destroy();
        download(res.headers.location, dest, onBytes).then(resolvePromise, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(tmp);
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        onBytes?.(n);
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolvePromise()));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
  await rename(tmp, dest);
}

/** Ensure the named model exists locally; download + verify if absent. */
export async function ensureWhisperModel(model = "small.en", onBytes?: (n: number) => void): Promise<string> {
  const spec = WHISPER_MODELS[model];
  if (!spec)
    throw new Error(`unknown whisper model "${model}" (have: ${Object.keys(WHISPER_MODELS).join(", ")})`);
  const dir = whisperModelDir();
  const path = join(dir, spec.file);
  const exists = await stat(path).then(
    (s) => s.size > 1024,
    () => false,
  );
  if (!exists) {
    await download(`${HF_BASE}/${spec.file}`, path, onBytes);
  }
  if (spec.sha256) {
    const actual = await sha256File(path);
    if (actual !== spec.sha256) {
      throw new Error(
        `whisper model ${model} failed SHA-256 verification (got ${actual.slice(0, 12)}…). Delete ${path} and retry.`,
      );
    }
  }
  return path;
}

interface WhisperCliSegment {
  offsets?: { from?: number; to?: number };
  text?: string;
}

interface WhisperCliOutput {
  result?: { language?: string };
  transcription?: WhisperCliSegment[];
}

/**
 * Transcribe a media file → word-level Transcript.
 * Pipeline: ffmpeg → 16kHz mono wav → whisper-cli -oj -ml 1 → words.
 */
export async function transcribe(
  mediaPath: string,
  opts?: {
    model?: string;
    outDir?: string;
    onBytes?: (n: number) => void;
    whisperBin?: string;
  },
): Promise<Transcript> {
  const bin = opts?.whisperBin ?? (await findWhisperCli());
  if (!bin) {
    throw new Error(
      "whisper-cli not found. Install whisper.cpp (brew install whisper-cpp) or set FRAMECRAFT_WHISPER.",
    );
  }
  const model = opts?.model ?? "small.en";
  const modelPath = await ensureWhisperModel(model, opts?.onBytes);
  const { ffmpeg, ffprobe } = await locateFfmpeg();
  const p = await probe(ffprobe, mediaPath);

  const cacheDir = join(homedir(), ".cache", "framecraft", "whisper", "work");
  await mkdir(cacheDir, { recursive: true });
  const key = createHash("sha1")
    .update(mediaPath)
    .update(String((await stat(mediaPath)).mtimeMs))
    .update(model)
    .digest("hex")
    .slice(0, 16);
  const wavPath = join(cacheDir, `${key}.wav`);

  await runFfmpeg(ffmpeg, ["-i", mediaPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);

  // whisper-cli writes <wav>.json next to input when -oj is passed.
  // -ml 1 (max-len 1) splits output to ~word granularity.
  const jsonPath = `${wavPath}.json`;
  await execFileAsync(bin, ["-m", modelPath, "-f", wavPath, "-oj", "-ml", "1", "-l", "en", "-np"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });

  const raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperCliOutput;
  const words: TranscriptWord[] = [];
  for (const seg of raw.transcription ?? []) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const start = (seg.offsets?.from ?? 0) / 1000;
    const end = (seg.offsets?.to ?? 0) / 1000;
    // -ml 1 can still produce multi-word fragments; split on whitespace,
    // distributing the span evenly so every word gets its own timestamp.
    const parts = text.split(/\s+/).filter(Boolean);
    parts.forEach((w, i) => {
      const span = end - start;
      words.push({
        w,
        start: start + (span * i) / parts.length,
        end: start + (span * (i + 1)) / parts.length,
      });
    });
  }

  return {
    version: 1,
    source: mediaPath,
    model,
    language: raw.result?.language ?? "en",
    duration: p.duration,
    words,
  };
}
