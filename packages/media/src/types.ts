/** Word-level transcript schema written by `editnce transcribe` (17 §3.2). */
export interface TranscriptWord {
  /** Display word (may include punctuation). */
  w: string;
  /** Source-media seconds when the word starts. */
  start: number;
  /** Source-media seconds when the word ends. */
  end: number;
  /** Optional confidence 0..1 from the recognizer. */
  p?: number;
}

export interface Transcript {
  version: 1;
  /** Media file this transcript describes (path as given on the CLI). */
  source: string;
  /** Whisper model id used. */
  model: string;
  /** Language code (e.g. "en"). */
  language: string;
  /** Media duration in seconds. */
  duration: number;
  words: TranscriptWord[];
}

/** One kept piece of the source after silence removal. */
export interface CutSegment {
  /** Seconds into the source where this segment starts. */
  srcStart: number;
  /** Seconds into the source where this segment ends. */
  srcEnd: number;
  /** Seconds on the output timeline where this segment starts. */
  compStart: number;
  /** Output seconds covered. */
  duration: number;
  /** Indices into transcript.words covered by this segment. */
  wordStart: number;
  wordEnd: number;
}

export interface CutPlan {
  version: 1;
  source: string;
  /** Gap threshold (seconds) that was treated as silence. */
  silenceThreshold: number;
  /** Padding kept around each kept segment. */
  pad: number;
  /** Source duration. */
  sourceDuration: number;
  /** Output duration after cuts. */
  duration: number;
  /** Seconds removed. */
  removed: number;
  segments: CutSegment[];
}
