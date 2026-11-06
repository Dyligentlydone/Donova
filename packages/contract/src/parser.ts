import * as parse5 from "parse5";
import { ATTR, CLIP_CLASS, G } from "./names.js";
import { parseBool, parseTime } from "./time.js";
import type {
  ClipSpec,
  CompositionSpec,
  ContractIssue,
  FontFaceDecl,
  MediaRef,
  TimelineSpec,
} from "./types.js";

type El = parse5.DefaultTreeAdapterMap["element"];
type Node = parse5.DefaultTreeAdapterMap["node"];

function getAttr(el: El, name: string): string | undefined {
  const a = el.attrs?.find((x) => x.name === name);
  return a?.value;
}
function hasAttr(el: El, name: string): boolean {
  return el.attrs?.some((x) => x.name === name) ?? false;
}
function classesOf(el: El): string[] {
  return (getAttr(el, "class") ?? "").split(/\s+/).filter(Boolean);
}
function localName(el: El): string {
  return el.tagName.toLowerCase();
}
function* walk(node: Node): Generator<El> {
  if (node && typeof node === "object" && "tagName" in node) yield node as El;
  const children = (node as { childNodes?: Node[] }).childNodes ?? [];
  for (const c of children) yield* walk(c);
}
function textSnippetOf(el: El): string | undefined {
  let out = "";
  for (const n of el.childNodes ?? []) {
    if ("value" in n && typeof (n as { value?: string }).value === "string") {
      out += (n as { value: string }).value;
    }
    if (out.length > 80) break;
  }
  const s = out.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 80) : undefined;
}

const MEDIA_TAG_KIND: Record<string, MediaRef["kind"]> = {
  video: "video",
  audio: "audio",
  img: "image",
  source: "other",
  track: "sub",
};

export interface ParseResult {
  spec: CompositionSpec;
  /** Map from clipId → parse5 element (for callers that need DOM access). */
  elements: Map<string, El>;
}

export function parseCompositionHtml(html: string, opts?: { path?: string; isRoot?: boolean }): ParseResult {
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
  const issues: ContractIssue[] = [];
  const clips: ClipSpec[] = [];
  const mediaItems: CompositionSpec["mediaItems"] = [];
  const timelines: TimelineSpec[] = [];
  const fonts: FontFaceDecl[] = [];
  const mediaRefs: MediaRef[] = [];
  const elements = new Map<string, El>();

  // --- Root composition element ---
  let compEl: El | undefined;
  let compositionId = "";
  for (const el of walk(doc)) {
    if (hasAttr(el, ATTR.compositionId)) {
      compEl = el;
      compositionId = getAttr(el, ATTR.compositionId) ?? "";
      break;
    }
  }
  if (!compEl && opts?.isRoot !== false) {
    issues.push({
      rule: "missing-root-composition",
      severity: "error",
      message: `No element with ${ATTR.compositionId}. Wrap the composition in a root element.`,
    });
  }

  const width =
    parseTime(getAttr(compEl ?? ({} as El), ATTR.width)) ?? Number(getAttr(compEl ?? ({} as El), ATTR.width));
  const height = Number(getAttr(compEl ?? ({} as El), ATTR.height));
  const duration = parseTime(getAttr(compEl ?? ({} as El), ATTR.duration));
  const fps = parseTime(getAttr(compEl ?? ({} as El), ATTR.fps));

  // --- Variables: data-var-* on root + <fc-var name value> ---
  const variables: Record<string, string> = {};
  if (compEl) {
    for (const a of compEl.attrs ?? []) {
      if (a.name.startsWith("data-var-")) variables[a.name.slice(9)] = a.value;
    }
  }
  for (const el of walk(doc)) {
    if (localName(el) === "fc-var") {
      const n = getAttr(el, "name");
      if (n) variables[n] = getAttr(el, "value") ?? "";
    }
  }

  // --- Timed elements ---
  let domIndex = 0;
  let clipSeq = 0;
  const visitTimed = (node: Node, parentClipId?: string): void => {
    if (!("tagName" in node)) {
      for (const c of (node as { childNodes?: Node[] }).childNodes ?? []) visitTimed(c, parentClipId);
      return;
    }
    const el = node as El;
    const start = parseTime(getAttr(el, ATTR.start));
    const isTimed = hasAttr(el, ATTR.start);
    const thisClipId = `clip-${clipSeq}`;
    const childParent = isTimed ? thisClipId : parentClipId;

    if (isTimed) {
      const duration = parseTime(getAttr(el, ATTR.duration));
      const end = parseTime(getAttr(el, ATTR.end));
      const tag = localName(el);
      const src = getAttr(el, "src");
      const kind =
        tag === "video"
          ? "video"
          : tag === "audio"
            ? "audio"
            : tag === "img"
              ? "image"
              : tag === "iframe"
                ? "iframe"
                : "element";
      const clip: ClipSpec = {
        id: thisClipId,
        domIndex: domIndex++,
        parentClipId,
        timing: {
          start: start ?? 0,
          duration: duration ?? (end != null && start != null ? end - start : 0),
          end,
        },
        audio: {
          hasAudio:
            tag === "video" ? parseBool(getAttr(el, ATTR.hasAudio), !hasAttr(el, "muted")) : tag === "audio",
          start: parseTime(getAttr(el, ATTR.audioStart)),
          end: parseTime(getAttr(el, ATTR.audioEnd)),
          offset: parseTime(getAttr(el, ATTR.audioOffset)),
          fadeIn: parseTime(getAttr(el, ATTR.audioFadeIn)),
          fadeOut: parseTime(getAttr(el, ATTR.audioFadeOut)),
          volume: (() => {
            const raw = getAttr(el, "data-volume");
            if (raw == null) return undefined;
            const n = Number(raw);
            return Number.isFinite(n) ? n : undefined;
          })(),
        },
        media: { tag, src, kind },
        attrs: Object.fromEntries(
          (el.attrs ?? []).filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value]),
        ),
        classes: classesOf(el),
        textSnippet: textSnippetOf(el),
      };
      clips.push(clip);
      elements.set(clip.id, el);
      clipSeq++;

      if (clip.timing.duration <= 0 && clip.timing.end == null) {
        issues.push({
          rule: "clip-zero-duration",
          severity: "error",
          message: `Timed element <${tag}> has data-start but no positive data-duration or data-end.`,
          clipId: clip.id,
        });
      }
      if (kind === "element" && !clip.classes.includes(CLIP_CLASS)) {
        issues.push({
          rule: "clip-missing-class",
          severity: "warn",
          message: `Timed <${tag}> should have class="${CLIP_CLASS}".`,
          clipId: clip.id,
          suggestion: `Add class="${CLIP_CLASS}" for consistent scene box styling.`,
        });
      }
    } else {
      // Untimed media element inside (or outside) a clip → inherits parent window.
      const tag = localName(el);
      const src = getAttr(el, "src");
      if (src && (tag === "video" || tag === "audio" || tag === "img" || tag === "iframe")) {
        mediaItems.push({
          src,
          kind: tag === "video" ? "video" : tag === "audio" ? "audio" : tag === "img" ? "image" : "iframe",
          tag,
          clipId: parentClipId,
          attrs: Object.fromEntries(
            (el.attrs ?? []).filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value]),
          ),
        });
      }
    }

    const kids = el.childNodes ?? [];
    for (const c of kids) visitTimed(c, childParent);
  };
  visitTimed(doc, undefined);

  // --- Media refs ---
  domIndex = 0;
  for (const el of walk(doc)) {
    const tag = localName(el);
    if (tag in MEDIA_TAG_KIND || hasAttr(el, ATTR.compositionSrc)) {
      const src = getAttr(el, "src") ?? getAttr(el, ATTR.compositionSrc) ?? getAttr(el, "href");
      if (!src) continue;
      const isCompSrc = hasAttr(el, ATTR.compositionSrc);
      mediaRefs.push({
        kind: isCompSrc ? "sub" : (MEDIA_TAG_KIND[tag] ?? "other"),
        src,
        remote: /^https?:\/\//.test(src),
        elementDomIndex: domIndex,
      });
    }
    if (hasAttr(el, ATTR.start)) domIndex++;
  }

  // --- Inline scripts: timeline registration scan ---
  const allScripts: string[] = [];
  for (const el of walk(doc)) {
    if (localName(el) === "script" && !getAttr(el, "src")) {
      let js = "";
      for (const n of el.childNodes ?? []) {
        if ("value" in n) js += (n as { value: string }).value;
      }
      if (js.trim()) allScripts.push(js);
    }
  }
  const scriptText = allScripts.join("\n");
  const tlRe = new RegExp(
    `(?:window\\s*\\.\\s*)?${G.timelines}\\s*\\[?\\s*['"\`]([\\w-]+)['"\`]\\s*\\]?\\s*=\\s*([^\\n;]+)`,
    "g",
  );
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  for (;;) {
    m = tlRe.exec(scriptText);
    if (!m) break;
    const id = m[1] ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    const rhs = m[2] ?? "";
    const adapter: TimelineSpec["adapter"] = /gsap/i.test(rhs)
      ? "gsap"
      : /lottie/i.test(rhs)
        ? "lottie"
        : /THREE|three/i.test(rhs)
          ? "three"
          : "custom";
    timelines.push({
      id,
      adapter,
      registered: true,
      isPausedRoot: /paused\s*:\s*true/.test(rhs),
    });
  }
  if ((opts?.isRoot ?? true) && timelines.length === 0 && clips.length === 0) {
    issues.push({
      rule: "no-timeline",
      severity: "warn",
      message: `No window.${G.timelines} registration found. Static compositions are allowed, but nothing will animate.`,
    });
  }

  // --- Fonts: @font-face in <style> blocks ---
  const fontFaceRe = /@font-face\s*\{([^}]+)\}/g;
  for (const el of walk(doc)) {
    if (localName(el) !== "style") continue;
    let css = "";
    for (const n of el.childNodes ?? []) {
      if ("value" in n) css += (n as { value: string }).value;
    }
    for (;;) {
      const fm = fontFaceRe.exec(css);
      if (!fm) break;
      const body = fm[1] ?? "";
      const family = /font-family\s*:\s*['"]?([^;'"]+)/.exec(body)?.[1]?.trim();
      const src = /src\s*:\s*url\(['"]?([^)'"]+)/.exec(body)?.[1]?.trim();
      if (family && src) {
        fonts.push({
          family,
          src,
          weight: /font-weight\s*:\s*(\w+)/.exec(body)?.[1],
          style: /font-style\s*:\s*(\w+)/.exec(body)?.[1],
          display: /font-display\s*:\s*(\w+)/.exec(body)?.[1],
        });
      }
    }
  }

  const spec: CompositionSpec = {
    id: compositionId || "main",
    isRoot: opts?.isRoot ?? true,
    path: opts?.path,
    width: Number.isFinite(width) ? Number(width) : 1920,
    height: Number.isFinite(height) ? Number(height) : 1080,
    duration: duration ?? 0,
    fps,
    background: getAttr(compEl ?? ({} as El), "data-background"),
    variables,
    clips,
    mediaItems,
    timelines,
    fonts,
    mediaRefs,
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity !== "error"),
  };
  return { spec, elements };
}
