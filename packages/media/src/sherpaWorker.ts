import { createRequire } from "node:module";
import { type SherpaWindow, WORKER_PREFIXES, droppedSpeechGaps, silenceCuts, spliceGap } from "./parakeet.js";
import { readWav } from "./wav.js";

/**
 * Parakeet decode worker. Runs in a child process because onnxruntime can
 * abort the whole process on some inputs, uncatchably. Input arrives as JSON
 * in EDITNCE_PARAKEET_INPUT; results stream back as prefixed stdout lines.
 */

interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaOnnx {
  OfflineRecognizer: new (
    config: object,
  ) => {
    createStream(): { acceptWaveform(wave: Wave): void };
    decode(stream: unknown): void;
    getResult(stream: unknown): Omit<SherpaWindow, "offset">;
  };
}

const { wavPath, runtimePath, config } = JSON.parse(process.env.EDITNCE_PARAKEET_INPUT ?? "{}");
const parentPid = process.ppid;
const { RESULT_PREFIX, ERROR_PREFIX, WINDOW_PREFIX } = WORKER_PREFIXES;

/** Leading silence moves the frame grid; 0.5 s recovers the dropped clause. */
const RETRY_PAD_SECONDS = 0.5;
/** Audio kept on each side of a skipped gap when it is decoded on its own. */
const GAP_MARGIN_SECONDS = 0.5;

function decodeWindow(
  recognizer: InstanceType<SherpaOnnx["OfflineRecognizer"]>,
  wave: Wave,
  padSeconds = 0,
): Omit<SherpaWindow, "offset"> {
  const pad = Math.round(padSeconds * wave.sampleRate);
  const samples = new Float32Array(pad + wave.samples.length);
  samples.set(wave.samples, pad);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
  recognizer.decode(stream);
  const { tokens, timestamps, durations } = recognizer.getResult(stream);
  return { tokens, timestamps: timestamps.map((t) => Math.max(0, t - padSeconds)), durations };
}

try {
  const sherpa = createRequire(import.meta.url)(runtimePath) as SherpaOnnx;
  const recognizer = new sherpa.OfflineRecognizer(config);
  const wave = await readWav(wavPath);
  const cuts = silenceCuts(wave.samples, wave.sampleRate);
  const windows: SherpaWindow[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    // A killed parent cannot read the result; stop decoding.
    if (process.ppid !== parentPid) throw new Error("the parent process exited, so decode stopped");
    const slice = {
      sampleRate: wave.sampleRate,
      samples: wave.samples.subarray(cuts[k] ?? 0, cuts[k + 1] ?? wave.samples.length),
    };
    let decoded = decodeWindow(recognizer, slice);
    const gaps = droppedSpeechGaps(slice.samples, slice.sampleRate, decoded);
    let spliced = decoded;
    for (const [from, to] of gaps) {
      const lo = Math.max(0, from - GAP_MARGIN_SECONDS);
      const at = (seconds: number) => Math.round(seconds * slice.sampleRate);
      const samples = slice.samples.subarray(at(lo), at(to + GAP_MARGIN_SECONDS));
      const patch = decodeWindow(recognizer, { sampleRate: slice.sampleRate, samples }, RETRY_PAD_SECONDS);
      spliced = spliceGap(spliced, patch, lo, [from, to]);
    }
    if (spliced.tokens.length > decoded.tokens.length) decoded = spliced;
    else if (gaps.length > 0) {
      const retry = decodeWindow(recognizer, slice, RETRY_PAD_SECONDS);
      if (retry.tokens.length > decoded.tokens.length) decoded = retry;
    }
    windows.push({ offset: (cuts[k] ?? 0) / wave.sampleRate, ...decoded });
    const through = (cuts[k + 1] ?? wave.samples.length) / wave.sampleRate;
    process.stdout.write(`${WINDOW_PREFIX}${JSON.stringify({ window: windows.at(-1), through })}\n`);
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(windows)}\n`);
} catch (err) {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  process.stderr.write(`${ERROR_PREFIX}${message}\n`, () => {
    throw err;
  });
}
