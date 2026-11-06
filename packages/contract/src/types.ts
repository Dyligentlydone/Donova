/** Shared contract types. Keep JSON-friendly: these flow over studio-server APIs and
 *  the player postMessage bridge, and are serialized into schemas/*.json. */

export type Timecode = string; // "MM:SS.mmm" | "SS.mmm" | "HH:MM:SS.mmm"

export interface TimingRule {
  start?: number; // seconds
  duration?: number; // seconds
  end?: number; // seconds
  trackIndex?: number;
  speed?: number;
}

export interface AnimationKeyframe {
  t: number; // seconds, local to element's time window
  props: Record<string, number | string>; // CSS-ish values after compile
  ease?: string;
}

export interface ClipSpec {
  id: string; // stable clip id (assigned during parse)
  domIndex: number; // index into document order of timed elements
  parentClipId?: string; // set when nested inside another timed element
  isCompositionRoot?: boolean;
  timing: {
    start: number;
    duration: number;
    end?: number;
    /** Set when the clip lives inside a sub-composition: seconds within root timeline. */
    resolvedStart?: number;
    resolvedDuration?: number;
    visibleFrom?: number;
    visibleUntil?: number;
    /** Local-time → root-time scale for clips nested under sped/slowed sub-comps. */
    timeScale?: number;
  };
  audio: {
    hasAudio: boolean;
    start?: number; // seconds into media file
    end?: number;
    offset?: number; // seconds within composition timeline
    volume?: number;
    fadeIn?: number;
    fadeOut?: number;
    pan?: number;
    bus?: string;
  };
  media: {
    tag: string; // e.g. 'div', 'img', 'video', 'audio', 'section'
    src?: string;
    kind?: "video" | "audio" | "image" | "iframe" | "element";
  };
  attrs: Record<string, string>; // raw data-* attrs (motion etc.)
  classes: string[];
  textSnippet?: string; // first ~80 chars of text content (timeline labels)
}

export interface CompositionSpec {
  id: string;
  isRoot: boolean;
  path?: string; // file path relative to project root (sub-compositions)
  width: number;
  height: number;
  duration: number; // seconds (authoritative for root; sub-comps may omit)
  fps?: number;
  background?: string;
  variables: Record<string, string>; // from data-var-* / <fc-var>
  clips: ClipSpec[];
  /** Media elements (video/audio/img) inside timed clips — inherit the clip's window. */
  mediaItems: Array<{
    src: string;
    kind: "video" | "audio" | "image" | "iframe";
    tag: string;
    clipId?: string;
    attrs: Record<string, string>;
  }>;
  timelines: TimelineSpec[];
  fonts: FontFaceDecl[];
  mediaRefs: MediaRef[];
  errors: ContractIssue[];
  warnings: ContractIssue[];
}

export interface TimelineSpec {
  id: string;
  adapter: "gsap" | "waapi-css" | "lottie" | "three" | "anime" | "typegpu" | "motion" | "custom";
  /** True if registered on window.__timelines. */
  registered: boolean;
  /** Estimated duration from static scan (seconds), when discoverable. */
  estDuration?: number;
  /** True when window.__timelines[id] = gsap.timeline({paused:true}) detected. */
  isPausedRoot?: boolean;
}

export interface FontFaceDecl {
  family: string;
  src: string; // resolved local path or data: URI after compile
  weight?: string;
  style?: string;
  display?: string;
}

export interface MediaRef {
  kind: "video" | "audio" | "image" | "font" | "sub" | "other";
  src: string; // as authored
  resolvedPath?: string; // project-local absolute path after compile
  remote?: boolean;
  elementDomIndex?: number;
}

export interface ContractIssue {
  rule: string; // e.g. "clip-missing-start"
  severity: "error" | "warn" | "info";
  message: string;
  file?: string;
  line?: number;
  col?: number;
  clipId?: string;
  suggestion?: string;
}

/** Timing compiler outputs. */
export interface ResolvedTimeline {
  compositionId: string;
  duration: number;
  /** Clip windows in ROOT timeline seconds, depth-flattened across sub-comps. */
  clips: Array<{
    clipId: string;
    compPath: string[];
    start: number;
    end: number;
    trackIndex?: number;
    audio?: ClipSpec["audio"];
    media?: ClipSpec["media"];
  }>;
  /** Segment boundaries for render scheduling (every clip edge, sorted, deduped). */
  cuts: number[];
}

export interface RenderPlan {
  fps: number;
  totalFrames: number;
  width: number;
  height: number;
  /** Frames grouped so each segment is a single encode unit when workers>1. */
  segments: Array<{ startFrame: number; frameCount: number }>;
}
