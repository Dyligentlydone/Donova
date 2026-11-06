import type { ContractIssue } from "./types.js";

/**
 * data-fc-motion — declarative motion for Studio-authored animation (01 §6b).
 * Written and read by the runtime's `motion` adapter; rendered via WAAPI.
 *
 * Shape (JSON):
 * {
 *   "v": 1,
 *   "split": "words" | "chars" | "none",
 *   "stagger": 0.06,                    // seconds between split children
 *   "children": "li",                   // optional CSS selector: animate children, not el
 *   "anims": [
 *     { "t": 0, "dur": 0.5, "ease": "power2.out",
 *       "props": { "opacity": [0,1], "translateY": ["1em","0em"] } }
 *   ]
 * }
 * - t is seconds relative to the element's own data-start window.
 * - props values are [from,to] pairs or a single "to" value.
 * - Transform-ish props map to individual transform properties so they compose
 *   with GSAP's `transform` (01 §6b): translate, translateX/Y, scale, scaleX/Y,
 *   rotate, rotateX/Y.
 */

export interface MotionAnim {
  t: number;
  dur: number;
  ease?: string;
  props: Record<string, [unknown, unknown] | unknown>;
  /** Optional per-anim selector/split override. */
  children?: string;
}

export interface MotionSpec {
  v: number;
  split?: "words" | "chars" | "none";
  stagger?: number;
  children?: string;
  anims: MotionAnim[];
}

const MOTION_PROPS = new Set([
  "opacity",
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
  "backgroundColor",
  "color",
  "letterSpacing",
  "filter",
  "clipPath",
  "width",
  "height",
  "x",
  "y",
  "borderRadius",
  "boxShadow",
]);

const EASES = new Set([
  "linear",
  "power1.in",
  "power1.out",
  "power1.inOut",
  "power2.in",
  "power2.out",
  "power2.inOut",
  "power3.in",
  "power3.out",
  "power3.inOut",
  "power4.in",
  "power4.out",
  "power4.inOut",
  "sine.in",
  "sine.out",
  "sine.inOut",
  "expo.in",
  "expo.out",
  "expo.inOut",
  "circ.in",
  "circ.out",
  "circ.inOut",
  "back.in",
  "back.out",
  "back.inOut",
  "elastic.in",
  "elastic.out",
  "elastic.inOut",
  "bounce.in",
  "bounce.out",
  "bounce.inOut",
  "steps",
]);

export function parseMotionAttr(raw: string | undefined): { spec?: MotionSpec; issues: ContractIssue[] } {
  const issues: ContractIssue[] = [];
  if (raw == null || raw.trim() === "") return { issues };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    issues.push({ rule: "motion-json", severity: "error", message: "data-fc-motion is not valid JSON." });
    return { issues };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    issues.push({ rule: "motion-schema", severity: "error", message: "data-fc-motion must be a JSON object." });
    return { issues };
  }
  const spec = json as MotionSpec;
  if (spec.v !== 1) {
    issues.push({ rule: "motion-schema", severity: "error", message: `Unsupported data-fc-motion v=${String(spec.v)}.` });
  }
  if (spec.split != null && !["words", "chars", "none"].includes(spec.split)) {
    issues.push({ rule: "motion-schema", severity: "error", message: `Invalid split "${String(spec.split)}".` });
  }
  if (!Array.isArray(spec.anims)) {
    issues.push({ rule: "motion-schema", severity: "error", message: "data-fc-motion.anims must be an array." });
    return { spec, issues };
  }
  for (const [i, a] of spec.anims.entries()) {
    if (typeof a.t !== "number" || a.t < 0) {
      issues.push({ rule: "motion-time-range", severity: "error", message: `anims[${i}].t must be ≥ 0 seconds.` });
    }
    if (typeof a.dur !== "number" || a.dur <= 0) {
      issues.push({ rule: "motion-time-range", severity: "error", message: `anims[${i}].dur must be > 0 seconds.` });
    }
    if (a.ease != null && !EASES.has(a.ease)) {
      issues.push({
        rule: "motion-ease",
        severity: "error",
        message: `Unknown ease "${a.ease}" in anims[${i}].`,
        suggestion: [...EASES].slice(0, 6).join(", ") + ", …",
      });
    }
    for (const k of Object.keys(a.props ?? {})) {
      if (!MOTION_PROPS.has(k)) {
        issues.push({
          rule: "motion-prop",
          severity: "warn",
          message: `anims[${i}] uses unmapped property "${k}". It will be applied as a CSS property.`,
        });
      }
    }
  }
  return { spec, issues };
}
