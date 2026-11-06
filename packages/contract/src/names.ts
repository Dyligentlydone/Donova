/**
 * Centralized product naming. Any rename touches this file (+ package.json name/bin).
 * Root user-visible rename must additionally update: docs + CLI strings.
 */
export const PRODUCT = "Framecraft" as const;
export const PRODUCT_SLUG = "framecraft" as const;
export const CLI_NAME = "framecraft" as const;
export const CLI_ALIAS = "fc" as const;
export const NPM_SCOPE = "@framecraft" as const;

/** Browser globals injected/expected by the runtime. */
export const G = {
  /** Root-seek + diagnostics object. */
  fc: "__fc",
  /** Map<compositionId, TimelineLike>. Compat with HyperFrames-era authoring. */
  timelines: "__timelines",
  /** Main player controller object (set by runtime boot). */
  player: "__player",
  /** Boolean: composition scripts have run, runtime bound. */
  playerReady: "__playerReady",
  /** Boolean: ready to capture the current frame. */
  renderReady: "__renderReady",
  /** Per-clip+adapter manifest written at boot for Studio/timeline. */
  clipManifest: "__clipManifest",
  /** Per-composition seek hook. */
  hf: "__hf",
} as const;

/** postMessage sources. */
export const MSG = {
  parentToIframe: "fc-parent",
  iframeToParent: "fc-preview",
} as const;

/** Env var prefix. */
export const ENV_PREFIX = "FRAMECRAFT_" as const;

/** Local cache dir name under user home (e.g. ~/.framecraft). */
export const CACHE_DIR = ".framecraft" as const;

/** Config file names in projects. */
export const CONFIG_FILES = {
  json: "framecraft.json",
  ts: "framecraft.config.ts",
} as const;

/** Attribute names. Single source so lint/parser/editor stay in sync. */
export const ATTR = {
  compositionId: "data-composition-id",
  compositionSrc: "data-composition-src",
  srcIsIframe: "data-src-is-iframe",
  width: "data-width",
  height: "data-height",
  duration: "data-duration",
  start: "data-start",
  end: "data-end",
  trackIndex: "data-track-index",
  speed: "data-speed",
  fps: "data-fps",
  fadeIn: "data-fade-in",
  fadeOut: "data-fade-out",
  hasAudio: "data-has-audio",
  clipAbsolute: "data-clip-absolute",
  audioStart: "data-audio-start",
  audioEnd: "data-audio-end",
  audioOffset: "data-audio-offset",
  audioFadeIn: "data-audio-fade-in",
  audioFadeOut: "data-audio-fade-out",
  motion: "data-fc-motion",
  srcIsFont: "data-src-is-font",
  opacity: "data-opacity",
  defer: "data-defer-until",
  track: "data-track",
  trimStart: "data-trim-start",
  trimEnd: "data-trim-end",
} as const;

export const CLIP_CLASS = "clip" as const;
export const AUDIO_HIDDEN_CLASS = "fc-audio-only" as const;

export const VERSION = "0.1.0" as const;
