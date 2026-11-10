import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Render-engine routing.
 *
 * Studio (the hyperframes bundle we serve) can write composition features
 * that only the hyperframes runtime renders — color grades, motion blur,
 * audio groups/automation, FX chains. Our producer renders everything in
 * the Framecraft contract (clips, media, speed, transforms, GSAP, fades,
 * volume) byte-deterministically but does not implement those yet.
 *
 * Rather than let preview and render diverge silently, `fc render` scans
 * the composition tree (root + data-composition-src children) and routes
 * to the hyperframes engine when any Studio-only feature is present. The
 * user can force either with --engine. `fc check` reports the decision so
 * the choice is never a surprise.
 *
 * Each entry: the attribute (or tag) and the port backlog item in
 * plan/18-UPSTREAM-SYNC.md that would bring it home to our engine.
 */

export type Engine = "framecraft" | "hyperframes";

export interface StudioOnlyFeature {
  /** attribute name or element tag that triggers routing */
  pattern: RegExp;
  label: string;
}

export const STUDIO_ONLY_FEATURES: StudioOnlyFeature[] = [
  { pattern: /\bdata-motion-blur(?:-[a-z]+)?=/i, label: "motion blur (data-motion-blur)" },
  { pattern: /\bdata-color-grading=/i, label: "color grade (data-color-grading)" },
  { pattern: /\bdata-color-group=/i, label: "color group (data-color-group)" },
  { pattern: /\bdata-audio-group=/i, label: "audio group (data-audio-group)" },
  { pattern: /<hf-audio-group\b/i, label: "audio bus (<hf-audio-group>)" },
  { pattern: /\bdata-automation=/i, label: "volume/parameter automation (data-automation)" },
  { pattern: /\bdata-fx-chain=/i, label: "audio FX chain (data-fx-chain)" },
  { pattern: /\bdata-vfx-chain=/i, label: "video FX chain (data-vfx-chain)" },
  { pattern: /\bdata-playback-start=/i, label: "playback start offset (data-playback-start)" },
  { pattern: /\bdata-lottie-src=/i, label: "Lottie (data-lottie-src)" },
  { pattern: /\bdata-requires-webgpu=/i, label: "WebGPU shader (data-requires-webgpu)" },
  { pattern: /<hyperframes-shader\b|\bdata-hyper-shader/i, label: "shader transition" },
];

export interface EngineDecision {
  engine: Engine;
  /** features found, with the file they were found in */
  reasons: { label: string; file: string }[];
  forced: boolean;
}

/** Walk root + sub-compositions, return the set of HTML files. */
function collectCompositionFiles(projectDir: string, composition: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(projectDir, composition)];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const html = readFileSync(file, "utf8");
    for (const m of html.matchAll(/data-composition-src=["']([^"']+)["']/g)) {
      const src = m[1];
      if (src && !/^https?:/i.test(src)) queue.push(resolve(dirname(file), src));
    }
  }
  return [...seen];
}

export function decideEngine(projectDir: string, composition: string, forced?: Engine): EngineDecision {
  const reasons: EngineDecision["reasons"] = [];
  for (const file of collectCompositionFiles(projectDir, composition)) {
    const html = readFileSync(file, "utf8");
    for (const f of STUDIO_ONLY_FEATURES) {
      if (f.pattern.test(html))
        reasons.push({ label: f.label, file: file.replace(`${resolve(projectDir)}/`, "") });
    }
  }
  if (forced) return { engine: forced, reasons, forced: true };
  return { engine: reasons.length ? "hyperframes" : "framecraft", reasons, forced: false };
}

/** Human one-liner for check/render output. */
export function describeDecision(d: EngineDecision): string {
  if (d.engine === "framecraft") {
    return d.forced ? "render engine: framecraft (forced)" : "render engine: framecraft";
  }
  const why = d.reasons.length
    ? ` — Studio-only features: ${[...new Set(d.reasons.map((r) => r.label))].join(", ")}`
    : "";
  return `render engine: hyperframes${d.forced ? " (forced)" : ""}${why}`;
}

/** Framecraft project root marker, used by the hf render to pick a cwd. */
export function hasFramecraftJson(projectDir: string): boolean {
  return existsSync(join(projectDir, "framecraft.json"));
}
