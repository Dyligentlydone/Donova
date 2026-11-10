import type { Transcript, TranscriptWord } from "./types.js";

interface RawWhisperSegment {
  offsets?: { from?: number; to?: number };
  text?: string;
}

/**
 * Accept either an donova transcript ({ words: [...] }) or raw whisper-cli
 * -oj output ({ transcription: [...] }) and normalize to Transcript.
 * Duration falls back to the last word's end when the raw format lacks it.
 */
export function normalizeTranscript(json: unknown, source = "media", duration?: number): Transcript {
  const obj = json as Record<string, unknown>;

  // Already an donova transcript.
  if (Array.isArray(obj?.words)) {
    const t = obj as unknown as Transcript;
    return { ...t, words: t.words.map((w) => ({ w: w.w, start: w.start, end: w.end, p: w.p })) };
  }

  const segments = (obj?.transcription as RawWhisperSegment[] | undefined) ?? [];
  const words: TranscriptWord[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const start = (seg.offsets?.from ?? 0) / 1000;
    const end = (seg.offsets?.to ?? 0) / 1000;
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
  const result = obj?.result as { language?: string } | undefined;
  return {
    version: 1,
    source,
    model: "whisper.cpp",
    language: result?.language ?? "en",
    duration: duration ?? (words.length ? (words[words.length - 1]?.end ?? 0) : 0),
    words,
  };
}
