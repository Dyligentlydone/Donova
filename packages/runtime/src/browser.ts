/**
 * Framecraft runtime — injected into every composition page.
 * Built to dist/runtime.global.js (IIFE). All behavior is seek-safe:
 * renderSeek(t) must leave the page in the exact state for time t,
 * regardless of previous seeks (in either direction).
 *
 * Globals this file owns: window.__fc, window.__hf, window.__player,
 * window.__playerReady, window.__renderReady, window.__clipManifest.
 * Author scripts register window.__timelines (not owned here).
 */
declare global {
  interface Window {
    __fc: any;
    __hf: any;
    __player: any;
    __playerReady: boolean;
    __renderReady: boolean;
    __timelines: Record<string, any>;
    __clipManifest: any[];
  }
}

type Adapter = {
  name: string;
  detect(): boolean;
  register(compId: string, tl: any): void;
  seekFrame(compId: string, frame: number, fps: number): void;
};

const w = window as unknown as Window;
w.__timelines = w.__timelines || {};
w.__clipManifest = w.__clipManifest || [];

const FRAME_EPS = 1e-6;

/* ---------------------------------- utils ---------------------------------- */

function attr(el: Element, name: string): string | null {
  return el.getAttribute(name);
}
function num(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------- adapters --------------------------------- */

const gsapAdapter: Adapter = {
  name: "gsap",
  detect: () => typeof (w as any).gsap !== "undefined",
  register(compId, tl) {
    manifestFor(compId).timelines.push(tl);
  },
  seekFrame(_compId, _frame, _fps) {
    // Root timelines are seeked via tl.totalTime in renderSeek below.
  },
};

/** CSS/WAAPI: animations and transitions the author created natively. We keep
 *  them paused and drive currentTime deterministically. */
const waapiAdapter: Adapter = {
  name: "waapi-css",
  detect: () => typeof document.getAnimations === "function",
  register() {},
  seekFrame(compId, frame, fps) {
    const t = frame / fps;
    const scope = compRoot(compId) ?? document;
    for (const a of scope.getAnimations({ subtree: true })) {
      try {
        a.pause();
        a.currentTime = t * 1000;
      } catch {
        /* finished animations may throw on some engines */
      }
    }
  },
};

/* --------------------------- data-fc-motion adapter ------------------------ */

const EASE_MAP: Record<string, string> = {
  linear: "linear",
  "power1.in": "cubic-bezier(0.42, 0, 1, 1)",
  "power1.out": "cubic-bezier(0, 0, 0.58, 1)",
  "power1.inOut": "cubic-bezier(0.42, 0, 0.58, 1)",
  "power2.in": "cubic-bezier(0.55, 0, 1, 1)",
  "power2.out": "cubic-bezier(0, 0, 0.45, 1)",
  "power2.inOut": "cubic-bezier(0.55, 0, 0.45, 1)",
  "power3.in": "cubic-bezier(0.895, 0.03, 0.685, 0.22)",
  "power3.out": "cubic-bezier(0.165, 0.84, 0.44, 1)",
  "power3.inOut": "cubic-bezier(0.77, 0, 0.175, 1)",
  "power4.in": "cubic-bezier(0.895, 0.03, 0.685, 0.22)",
  "power4.out": "cubic-bezier(0.165, 0.84, 0.44, 1)",
  "power4.inOut": "cubic-bezier(0.77, 0, 0.175, 1)",
  "sine.in": "cubic-bezier(0.47, 0, 0.745, 0.715)",
  "sine.out": "cubic-bezier(0.39, 0.575, 0.565, 1)",
  "sine.inOut": "cubic-bezier(0.445, 0.05, 0.55, 0.95)",
  "expo.in": "cubic-bezier(0.95, 0.05, 0.795, 0.035)",
  "expo.out": "cubic-bezier(0.19, 1, 0.22, 1)",
  "expo.inOut": "cubic-bezier(1, 0, 0, 1)",
  "circ.in": "cubic-bezier(0.6, 0.04, 0.98, 0.335)",
  "circ.out": "cubic-bezier(0.075, 0.82, 0.165, 1)",
  "circ.inOut": "cubic-bezier(0.785, 0.135, 0.15, 0.86)",
  // Approximations; CSS lacks native back/elastic/bounce curves. linear() would
  // be more precise; keep cubic-bezier approximations for broad engine support.
  "back.in": "cubic-bezier(0.6, -0.28, 0.735, 0.045)",
  "back.out": "cubic-bezier(0.175, 0.885, 0.32, 1.275)",
  "back.inOut": "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
  "elastic.out": "cubic-bezier(0.175, 0.885, 0.32, 1.4)",
  "elastic.in": "cubic-bezier(0.7, -0.4, 0.9, 0.1)",
  "elastic.inOut": "cubic-bezier(0.68, -0.4, 0.265, 1.4)",
  "bounce.out": "cubic-bezier(0.34, 1.56, 0.64, 1)",
  "bounce.in": "cubic-bezier(0.6, -0.28, 0.735, 0.045)",
  "bounce.inOut": "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
  steps: "steps(1, end)",
};

const _MOTION_TRANSFORM_PROPS = new Set([
  "translate",
  "translateX",
  "translateY",
  "translateZ",
  "scale",
  "scaleX",
  "scaleY",
  "rotate",
  "rotateX",
  "rotateY",
  "skewX",
  "skewY",
  "perspective",
  "x",
  "y",
]);

interface MotionAnimRec {
  el: Element;
  anim: Animation;
  /** absolute start time (root secs) incl. stagger for split children */
  t0: number;
  t1: number;
}
const motionAnims: MotionAnimRec[] = [];

function splitIntoWords(el: Element): HTMLElement[] {
  const text = el.textContent ?? "";
  el.textContent = "";
  const parts = text.split(/(\s+)/);
  const out: HTMLElement[] = [];
  for (const p of parts) {
    if (/^\s+$/.test(p) || p === "") {
      el.appendChild(document.createTextNode(p));
      continue;
    }
    const s = document.createElement("span");
    s.style.display = "inline-block";
    s.className = "fc-motion-word";
    s.textContent = p;
    el.appendChild(s);
    out.push(s);
  }
  return out;
}
function splitIntoChars(el: Element): HTMLElement[] {
  const words = splitIntoWords(el);
  const out: HTMLElement[] = [];
  for (const wd of words) {
    const text = wd.textContent ?? "";
    wd.textContent = "";
    for (const ch of text) {
      const s = document.createElement("span");
      s.style.display = "inline-block";
      s.className = "fc-motion-char";
      s.textContent = ch;
      wd.appendChild(s);
      out.push(s);
    }
  }
  return out;
}

function keyframesFor(props: Record<string, unknown>): [Keyframe, Keyframe] {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const prop = k === "x" ? "translateX" : k === "y" ? "translateY" : k;
    if (Array.isArray(v)) {
      from[prop] = v[0];
      to[prop] = v[1];
    } else {
      to[prop] = v;
    }
  }
  return [from as Keyframe, to as Keyframe];
}

function buildMotionAnims(): void {
  motionAnims.length = 0;
  const nodes = document.querySelectorAll("[data-fc-motion]");
  for (const el of nodes) {
    let spec: any;
    try {
      spec = JSON.parse(attr(el, "data-fc-motion") ?? "");
    } catch {
      continue;
    }
    if (!spec || !Array.isArray(spec.anims)) continue;
    // Anim `t` is relative to the element's timed ancestor (the .clip it sits
    // in), falling back to the element's own data-start, then 0.
    const timed = el.hasAttribute("data-start") ? el : el.closest("[data-start]");
    const elStart = num(attr(timed ?? el, "data-start"), 0);

    const targets: Element[] = (() => {
      if (spec.children) return [...el.querySelectorAll(spec.children)];
      if (spec.split === "chars") return splitIntoChars(el);
      if (spec.split === "words") return splitIntoWords(el);
      return [el];
    })();

    for (const a of spec.anims) {
      const ease = EASE_MAP[a.ease ?? "power2.out"] ?? "ease";
      const [from, to] = keyframesFor(a.props ?? {});
      const targetSet = a.children ? [...el.querySelectorAll(a.children)] : targets;
      targetSet.forEach((t, i) => {
        const offset = (spec.stagger ?? 0) * i;
        const t0 = elStart + a.t + offset;
        const anim = (t as Element).animate([from, to], {
          duration: a.dur * 1000,
          easing: ease,
          fill: "both",
        });
        anim.pause();
        motionAnims.push({ el: t, anim, t0, t1: t0 + a.dur });
      });
    }
  }
}

const motionAdapter: Adapter = {
  name: "motion",
  detect: () => true,
  register() {},
  seekFrame(_compId, frame, fps) {
    const t = frame / fps;
    for (const rec of motionAnims) {
      const local = Math.min(Math.max(t - rec.t0, 0), rec.t1 - rec.t0);
      try {
        rec.anim.currentTime = local * 1000;
      } catch {
        /* ignore */
      }
    }
  },
};

const adapters: Adapter[] = [gsapAdapter, waapiAdapter, motionAdapter];

/* ------------------------------ clip manifest ----------------------------- */

interface ManifestEntry {
  compId: string;
  timelines: any[];
}
const manifests = new Map<string, ManifestEntry>();
function manifestFor(compId: string): ManifestEntry {
  let m = manifests.get(compId);
  if (!m) {
    m = { compId, timelines: [] };
    manifests.set(compId, m);
  }
  return m;
}

function compRoot(compId: string): Element | null {
  return document.querySelector(`[data-composition-id="${compId}"]`);
}

/** Timed-element record built once at boot. */
interface TimedEl {
  el: HTMLElement;
  start: number;
  end: number;
  display: string;
  hasFadeIn: number;
  hasFadeOut: number;
}
let timedEls: TimedEl[] = [];

function collectTimedEls(): void {
  timedEls = [];
  for (const el of document.querySelectorAll<HTMLElement>("[data-start]")) {
    const start = num(attr(el, "data-start"), 0);
    const dur = num(attr(el, "data-duration"), Number.NaN);
    const endAttr = attr(el, "data-end");
    const end = endAttr != null ? num(endAttr, start) : Number.isFinite(dur) ? start + dur : start;
    timedEls.push({
      el,
      start,
      end,
      // Authored inline display (e.g. flex on blocks) is restored on show —
      // without it the first hide destroys it (blocks collapse to display:block).
      display: el.style.display || "",
      hasFadeIn: num(attr(el, "data-fade-in"), 0),
      hasFadeOut: num(attr(el, "data-fade-out"), 0),
    });
  }
}

function applyVisibility(t: number): void {
  for (const rec of timedEls) {
    const vis = t >= rec.start - FRAME_EPS && t < rec.end + FRAME_EPS;
    // display (not visibility) — matches contract §clips so layout never leaks.
    if (vis && rec.el.style.display === "none") rec.el.style.display = rec.display;
    else if (!vis && rec.el.style.display !== "none") {
      if (rec.el.style.display) rec.display = rec.el.style.display;
      rec.el.style.display = "none";
    }

    // data-fade-in/out convenience fades (composition-time).
    const fi = rec.hasFadeIn;
    const fo = rec.hasFadeOut;
    if ((fi > 0 || fo > 0) && vis) {
      let o = 1;
      const local = t - rec.start;
      if (fi > 0 && local < fi) o = Math.min(o, local / fi);
      if (fo > 0 && rec.end - t < fo) o = Math.min(o, (rec.end - t) / fo);
      rec.el.style.opacity = String(Math.max(0, Math.min(1, o)));
    }
  }
}

/* --------------------------- sub-compositions ----------------------------- */

/**
 * data-composition-src support (02 §sub-comps, MV4).
 * Each host element with data-composition-src fetches that HTML file and
 * inlines its content. The host's data-var-* attributes parameterize the
 * block two ways:
 *   - CSS custom props:  data-var-accent → --fc-accent on the host (so
 *     var(--fc-accent) resolves anywhere inside the pasted subtree).
 *   - Text slots:        [data-fc-var="title"] inside the block gets the
 *     host's data-var-title as textContent (absent var keeps default text;
 *     empty-string var hides the slot).
 * Imported timed children are remapped: their local data-start/duration are
 * scaled by hostDuration/subDuration (HyperFrames sub-comp semantics) and
 * offset by the host's start; data-fc-motion anim t/dur scale the same way.
 */
async function loadSubComps(): Promise<void> {
  for (let depth = 0; depth < 4; depth++) {
    const hosts = [...document.querySelectorAll<HTMLElement>("[data-composition-src]")].filter(
      (el) => el.dataset.fcSubLoaded !== "1",
    );
    if (!hosts.length) return;
    await Promise.all(
      hosts.map(async (host) => {
        host.dataset.fcSubLoaded = "1";
        const src = attr(host, "data-composition-src");
        if (!src) return;
        try {
          const res = await fetch(src);
          if (!res.ok) return;
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const subRoot = doc.querySelector("[data-composition-id]");
          const content = subRoot ? [...subRoot.childNodes] : [...doc.body.childNodes];

          const hostStart = num(attr(host, "data-start"), 0);
          const hostEnd = (() => {
            const e = attr(host, "data-end");
            if (e != null) return num(e, hostStart);
            return hostStart + num(attr(host, "data-duration"), 0);
          })();
          const hostDur = Math.max(hostEnd - hostStart, FRAME_EPS);
          // Sub duration: comp root's data-duration, else first imported timed
          // child's, else the host's (no scaling).
          let subDur = subRoot ? num(attr(subRoot, "data-duration"), 0) : 0;
          if (!(subDur > 0)) {
            for (const n of content) {
              if (n instanceof Element && n.hasAttribute("data-duration")) {
                subDur = num(attr(n, "data-duration"), 0);
                break;
              }
            }
          }
          const scale = subDur > 0 ? hostDur / subDur : 1;

          // Vars: data-var-* → --fc-* on the host.
          for (const a of host.attributes) {
            if (a.name.startsWith("data-var-")) {
              host.style.setProperty(`--fc-${a.name.slice(9)}`, a.value);
            }
          }

          const frag = document.createDocumentFragment();
          for (const n of content) frag.appendChild(document.importNode(n, true));
          host.appendChild(frag);

          // Sub-composition styles assume they own the document — their
          // `body`/`html`/`#root` selectors would hit OUR page and unprefixed
          // selectors would leak into siblings. Scope every rule to the host:
          // document-owning selectors become the host itself, everything else
          // becomes a descendant of it.
          const scope = `sub-${subCounter++}`;
          host.setAttribute("data-fc-sub", scope);
          const scopeSel = `[data-fc-sub="${scope}"]`;
          const scopeCss = (css: string): string => {
            const sheet = new CSSStyleSheet();
            try {
              sheet.replaceSync(css);
            } catch {
              return "";
            }
            const selfSel = /^(?:html|body|#root|#stage|:root|\[data-composition-id\])\b/;
            const rewrite = (sel: string): string =>
              sel
                .split(",")
                .map((part) => {
                  const p = part.trim();
                  if (!p) return p;
                  if (selfSel.test(p)) return p.replace(selfSel, scopeSel);
                  return `${scopeSel} ${p}`;
                })
                .join(", ");
            const decls = (rule: CSSStyleRule, isSelf: boolean): string => {
              // The host owns its clip box — a block's body/html canvas dims
              // (e.g. 1920x1080) must not resize the host on foreign projects.
              if (!isSelf) return rule.style.cssText;
              const keep: string[] = [];
              for (const prop of rule.style) {
                if (["width", "height", "min-width", "min-height", "max-width", "max-height"].includes(prop))
                  continue;
                keep.push(`${prop}:${rule.style.getPropertyValue(prop)};`);
              }
              return keep.join("");
            };
            const walk = (rules: CSSRuleList): string =>
              [...rules]
                .map((rule) => {
                  if (rule instanceof CSSStyleRule) {
                    const isSelf = rule.selectorText.split(",").every((p) => selfSel.test(p.trim()));
                    return `${rewrite(rule.selectorText)} { ${decls(rule, isSelf)} }`;
                  }
                  if ("cssRules" in rule) {
                    const inner = walk((rule as CSSGroupingRule).cssRules);
                    if (rule instanceof CSSMediaRule) return `@media ${rule.conditionText} { ${inner} }`;
                    if (rule instanceof CSSSupportsRule)
                      return `@supports ${rule.conditionText} { ${inner} }`;
                    if (rule instanceof CSSLayerBlockRule) return `@layer ${rule.name} { ${inner} }`;
                    return rule.cssText; // @keyframes/@font-face pass through
                  }
                  return rule.cssText;
                })
                .join("\n");
            return walk(sheet.cssRules);
          };
          for (const st of doc.querySelectorAll("style, link[rel~='stylesheet']")) {
            let css = "";
            if (st instanceof HTMLStyleElement) css = st.textContent ?? "";
            else {
              const href = st.getAttribute("href");
              if (!href) continue;
              try {
                const r = await fetch(new URL(href, new URL(src, location.href).href).href);
                if (r.ok) css = await r.text();
              } catch {
                continue;
              }
            }
            const scoped = scopeCss(css);
            if (!scoped) continue;
            const el = document.createElement("style");
            el.textContent = scoped;
            host.appendChild(el);
          }

          // Imported <script> nodes are inert (clone never runs). Re-create
          // them so they execute: external srcs load first (in order), then
          // inline bodies — matching document order semantics. GSAP CDN srcs
          // are rewritten to the runtime-served copy for offline determinism.
          const scripts = [...doc.querySelectorAll("script")];
          const timelinesBefore = new Map(Object.entries(w.__timelines ?? {}));
          for (const s of scripts) {
            const srcAttr = s.getAttribute("src");
            if (srcAttr) {
              const rewritten = /gsap[^"']*\.(min\.)?js(\?.*)?$/i.test(srcAttr) ? "/__fc-gsap.js" : srcAttr;
              await new Promise<void>((res) => {
                const el = document.createElement("script");
                el.src = rewritten;
                el.onload = () => res();
                el.onerror = () => res(); // missing script must not stall the load
                host.appendChild(el);
                setTimeout(res, 5000);
              });
            } else if (s.textContent?.trim()) {
              const el = document.createElement("script");
              el.textContent = s.textContent;
              host.appendChild(el);
            }
          }
          // Any __timelines entries this block's scripts registered belong to
          // the block's LOCAL clock — scope them to the host's window/scale so
          // renderSeek can map global time back. Object-identity diff keeps a
          // repeated block's second registration bound to its own host.
          for (const [key, tl] of Object.entries(w.__timelines ?? {})) {
            if (timelinesBefore.get(key) !== tl && tl != null) {
              scopedTimelines.push({ tl, start: hostStart, scale });
            }
          }

          // Text slots.
          for (const slot of host.querySelectorAll<HTMLElement>("[data-fc-var]")) {
            const key = attr(slot, "data-fc-var") ?? "";
            const v = attr(host, `data-var-${key}`);
            if (v == null) continue; // keep default text
            if (v === "") slot.style.display = "none";
            else slot.textContent = v;
          }

          // Remap timing of imported timed children.
          for (const el of host.querySelectorAll<HTMLElement>("[data-start]")) {
            if (el === host) continue;
            const s = num(attr(el, "data-start"), 0);
            el.setAttribute("data-start", String(hostStart + s * scale));
            const d = attr(el, "data-duration");
            if (d != null) el.setAttribute("data-duration", String(num(d, 0) * scale));
            const e = attr(el, "data-end");
            if (e != null) el.setAttribute("data-end", String(hostStart + num(e, 0) * scale));
            const mot = attr(el, "data-fc-motion");
            if (mot && scale !== 1) {
              try {
                const spec = JSON.parse(mot);
                if (Array.isArray(spec.anims)) {
                  for (const a of spec.anims) {
                    if (typeof a.t === "number") a.t *= scale;
                    if (typeof a.dur === "number") a.dur *= scale;
                  }
                  if (typeof spec.stagger === "number") spec.stagger *= scale;
                  el.setAttribute("data-fc-motion", JSON.stringify(spec));
                }
              } catch {
                /* leave as-is */
              }
            }
          }
        } catch {
          /* missing/unfetchable sub-comp — leave host empty */
        }
      }),
    );
  }
}

/* ------------------------------- media sync ------------------------------- */

interface MediaEl {
  el: HTMLMediaElement;
  start: number; // composition seconds when media begins
  mediaStart: number; // source seconds where the clip begins (data-media-start)
  speed: number;
}
let mediaEls: MediaEl[] = [];

function collectMedia(): void {
  mediaEls = [];
  for (const el of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
    // Media lives inside a timed ancestor or carries data-start itself.
    const holder = el.closest("[data-start]") ?? el;
    const start = num(attr(holder, "data-start"), 0);
    const audioOffset = num(attr(holder, "data-audio-offset") ?? attr(el, "data-audio-offset"), 0);
    const speed = num(attr(holder, "data-speed") ?? attr(el, "data-speed"), 1);
    const mediaStart = num(
      attr(holder, "data-media-start") ?? attr(el, "data-media-start") ?? attr(el, "data-trim-start"),
      0,
    );
    mediaEls.push({ el, start: start + audioOffset, mediaStart, speed });
  }
}

/** Seek all media to composition time t. Returns a promise that resolves when
 *  every needed seek has landed (or timed out). */
function seekMedia(t: number, timeoutMs = 4000): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const m of mediaEls) {
    // Videos replaced by deterministic frame overlays don't need element
    // seeks — their audio is muxed by the FFmpeg graph, not the element.
    if ((m.el as HTMLElement).dataset.fcOverlay === "1") continue;
    const elapsed = (t - m.start) * m.speed;
    const local = m.mediaStart + elapsed;
    const dur = m.el.duration;
    const inWindow = elapsed >= -FRAME_EPS && (!Number.isFinite(dur) || local <= dur + FRAME_EPS);
    const target = Math.max(0, local);
    if (!inWindow) {
      if (!m.el.paused) m.el.pause();
      continue;
    }
    if (Math.abs(m.el.currentTime - target) < 1 / 60) continue;
    jobs.push(
      new Promise<void>((resolve) => {
        const el = m.el;
        const to = setTimeout(() => {
          el.removeEventListener("seeked", onSeeked);
          resolve();
        }, timeoutMs);
        const onSeeked = () => {
          clearTimeout(to);
          el.removeEventListener("seeked", onSeeked);
          resolve();
        };
        el.addEventListener("seeked", onSeeked);
        try {
          el.currentTime = target;
        } catch {
          clearTimeout(to);
          el.removeEventListener("seeked", onSeeked);
          resolve();
        }
      }),
    );
  }
  return Promise.all(jobs).then(() => undefined);
}

/* --------------------------- video frame overlays ------------------------- */

interface VideoMapEntry {
  selector: string;
  index?: number;
  ext?: string;
  dir: string;
  fps: number;
  start: number;
  duration: number;
  trimStart: number;
  speed: number;
  frameCount: number;
}
interface VideoOverlay {
  video: HTMLVideoElement;
  img: HTMLImageElement;
  wrapper: HTMLDivElement;
  entry: VideoMapEntry;
  pending?: Promise<void>;
}
const videoOverlays: VideoOverlay[] = [];

async function loadVideoMap(): Promise<void> {
  if (document.querySelector("video") == null) return;
  try {
    const res = await fetch(".framecraft/video-map.json");
    if (!res.ok) return;
    const map = (await res.json()) as { entries?: VideoMapEntry[] };
    for (const e of map.entries ?? []) {
      const v =
        typeof e.index === "number"
          ? document.querySelectorAll<HTMLVideoElement>("video")[e.index]
          : document.querySelector<HTMLVideoElement>(e.selector);
      if (!v) continue;
      // Overlay <img> exactly covering the video's box.
      const img = document.createElement("img");
      img.className = "fc-video-frame";
      const cs = getComputedStyle(v);
      img.style.position = "absolute";
      img.style.inset = "0";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = cs.objectFit || "cover";
      img.style.pointerEvents = "none";
      const wrapper = document.createElement("div");
      wrapper.style.position = "absolute";
      wrapper.style.left = `${v.offsetLeft}px`;
      wrapper.style.top = `${v.offsetTop}px`;
      wrapper.style.width = `${v.offsetWidth}px`;
      wrapper.style.height = `${v.offsetHeight}px`;
      wrapper.style.overflow = "hidden";
      wrapper.appendChild(img);
      const holder = v.parentElement;
      if (holder) {
        // Insert at the video's own DOM slot — with the hoisted media model
        // (video IS the .clip) appending to the parent would paint the frame
        // over every later sibling (blocks, captions).
        holder.insertBefore(wrapper, v.nextSibling);
      }
      v.style.opacity = "0"; // keep for semantics/audio map; frame comes from img
      v.dataset.fcOverlay = "1";
      videoOverlays.push({ video: v, img, wrapper, entry: e });
    }
  } catch {
    /* no video map — fine */
  }
}

function frameUrl(e: VideoMapEntry, t: number): string {
  const local = Math.max(0, (t - e.start) * e.speed);
  let idx = Math.floor(local * e.fps);
  idx = Math.min(Math.max(idx, 0), e.frameCount - 1);
  return `${e.dir}/f${String(idx).padStart(6, "0")}.${e.ext ?? "png"}`;
}

function updateVideoFrames(t: number): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const ov of videoOverlays) {
    // Only swap frames for overlays inside (or just before) their window —
    // off-window clips are display:none anyway.
    if (t < ov.entry.start - FRAME_EPS || t > ov.entry.start + ov.entry.duration + FRAME_EPS) {
      continue;
    }
    // Mirror the source element's transform (data-fc-motion anims drive the
    // video element; without this the rendered frame ignores zoom/punch-ins).
    // Individual longhands (scale/rotate/translate) don't fold into
    // `transform` — mirror each so either authoring style works.
    const cs = getComputedStyle(ov.video);
    const ws = ov.wrapper.style;
    ws.transform = cs.transform === "none" ? "" : cs.transform;
    ws.translate = cs.translate === "none" ? "" : cs.translate;
    ws.rotate = cs.rotate === "none" ? "" : cs.rotate;
    ws.scale = cs.scale === "none" ? "" : cs.scale;
    ws.transformOrigin = cs.transformOrigin;
    const url = frameUrl(ov.entry, t);
    if (ov.img.getAttribute("src") === url) continue;
    jobs.push(
      new Promise<void>((resolve) => {
        const to = setTimeout(resolve, 2000);
        ov.img.addEventListener(
          "load",
          () => {
            clearTimeout(to);
            resolve();
          },
          { once: true },
        );
        ov.img.addEventListener(
          "error",
          () => {
            clearTimeout(to);
            resolve();
          },
          { once: true },
        );
        ov.img.src = url;
      }),
    );
  }
  return Promise.all(jobs).then(() => undefined);
}

/* ---------------------------------- seek ---------------------------------- */

let fps = 30;
let currentTime = 0;
let booted = false;

/** Timelines registered by imported sub-compositions run on the block's local
 * clock — renderSeek maps global time through each entry's host window/scale. */
interface ScopedTimeline {
  tl: any;
  start: number;
  scale: number;
}
const scopedTimelines: ScopedTimeline[] = [];
let subCounter = 0;

function seekTl(tl: any, t: number): void {
  if (typeof tl?.totalTime === "function") {
    tl.pause();
    tl.totalTime(t, true);
  } else if (typeof tl?.seek === "function") {
    tl.seek(t);
  }
}

function rootTimelines(): any[] {
  const scoped = new Set(scopedTimelines.map((s) => s.tl));
  const out: any[] = [];
  for (const [, tl] of Object.entries(w.__timelines ?? {})) {
    if (!scoped.has(tl)) out.push(tl);
  }
  return out;
}

async function renderSeek(t: number): Promise<void> {
  const prof: Record<string, number> = {};
  const mark = (name: string, t0: number) => {
    prof[name] = (prof[name] ?? 0) + (performance.now() - t0);
  };
  let t0 = performance.now();
  currentTime = t;
  const frame = Math.round(t * fps);

  // 1. Root GSAP timelines (page-level) + scoped sub-comp timelines (local clock).
  for (const tl of rootTimelines()) seekTl(tl, t);
  for (const s of scopedTimelines) {
    seekTl(s.tl, Math.max(0, (t - s.start) / (s.scale || 1)));
  }

  // 2. Adapters (WAAPI/CSS animations, motion).
  for (const a of adapters) {
    if (a.name === "gsap") continue;
    for (const compId of Object.keys(w.__timelines ?? {})) a.seekFrame(compId, frame, fps);
    if (Object.keys(w.__timelines ?? {}).length === 0) a.seekFrame("__root__", frame, fps);
  }

  // 3. Clip visibility + fades.
  applyVisibility(t);
  mark("visibility", t0);

  // 4. Video frame overlays (deterministic path) + media seek.
  t0 = performance.now();
  await updateVideoFrames(t);
  mark("videoFrames", t0);
  t0 = performance.now();
  await seekMedia(t);
  mark("seekMedia", t0);

  // 5. Readiness.
  t0 = performance.now();
  await waitReady();
  mark("waitReady", t0);
  (w.__fc as Record<string, unknown>)._seekProfile = prof;
}

async function waitReady(): Promise<void> {
  w.__renderReady = false;
  try {
    // document.fonts.ready can hang forever in chrome-headless-shell even when
    // nothing is loading — only await it while fonts are actually loading, and
    // bound the wait tightly. (MV7: this was a 2s/frame stall.)
    const fonts = document.fonts;
    if (fonts && fonts.status === "loading") {
      await Promise.race([fonts.ready, sleep(500)]);
    }
  } catch {
    /* ignore */
  }
  // Images inside the composition must be decoded. Only wait on images that
  // actually have a source — an <img> with no src (e.g. an off-window video
  // frame overlay) reports naturalWidth 0 forever and used to stall every
  // frame for the full 2s timeout (MV7).
  const imgs = [...document.querySelectorAll("img")].filter((i) => i.getAttribute("src") && !i.complete);
  if (imgs.length) {
    await Promise.race([
      Promise.all(
        imgs.map(
          (i) =>
            new Promise<void>((r) => {
              const done = () => r();
              i.addEventListener("load", done, { once: true });
              i.addEventListener("error", done, { once: true });
              setTimeout(done, 2000);
            }),
        ),
      ),
      sleep(2500),
    ]);
  }
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  w.__renderReady = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------------------- boot ---------------------------------- */

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;

  const root = document.querySelector("[data-composition-id]");
  if (root) {
    fps = num(attr(root, "data-fps"), num(attr(document.body, "data-fps"), 30)) || 30;
    // The composition root owns its pixel box — clips and absolutely
    // positioned children resolve against it, not the viewport.
    const el = root as HTMLElement;
    const cw = num(attr(el, "data-width"), 0);
    const ch = num(attr(el, "data-height"), 0);
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    if (cw > 0) el.style.width = `${cw}px`;
    if (ch > 0) el.style.height = `${ch}px`;
    el.style.overflow = "hidden";
  }

  // Register authored timelines with adapters.
  for (const [compId, tl] of Object.entries(w.__timelines ?? {})) {
    manifestFor(compId).timelines.push(tl);
  }

  await loadSubComps();
  collectTimedEls();
  collectMedia();
  buildMotionAnims();
  await loadVideoMap();

  // Boot lands at t=0 before anything observes readiness — hosts may seek from
  // here without racing an initial paint.
  await renderSeek(0);

  w.__playerReady = true;
}

/* --------------------------------- exports -------------------------------- */

w.__fc = {
  get fps() {
    return fps;
  },
  get currentTime() {
    return currentTime;
  },
  renderSeek,
  boot,
  adapters,
};

w.__player = {
  seek: (t: number) => renderSeek(t),
  play: () => {
    /* preview playback handled by host */
  },
  pause: () => {},
};

w.__hf = w.__hf || {};
w.__hf.renderSeek = renderSeek;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}

export {};
