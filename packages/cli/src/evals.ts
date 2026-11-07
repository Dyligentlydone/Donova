import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { render } from "@framecraft/producer";
import { checkProject } from "./check.js";
import { probeCmd, timelineCmd } from "./inspect.js";
import { snapshotTimes } from "./snapshot.js";

const _execFileP = promisify(execFile);

/**
 * `framecraft eval` — rule-scored checklist for a project (MV10). Each rule
 * returns pass/fail with a note; score = weighted pass fraction. A project
 * passes at ≥0.7 (17 §evals). Used to grade both hand edits and agent turns.
 */
export interface EvalRule {
  name: string;
  weight: number;
  pass: boolean;
  note: string;
}
export interface EvalResult {
  dir: string;
  score: number;
  pass: boolean;
  rules: EvalRule[];
}

export async function evalProject(opts: {
  dir: string;
  renderOut?: string;
}): Promise<EvalResult> {
  const dir = resolve(opts.dir);
  const rules: EvalRule[] = [];
  const add = (name: string, weight: number, pass: boolean, note: string) =>
    rules.push({ name, weight, pass, note });

  // 1. check clean
  const check = await checkProject(dir);
  const errCount = check.issues.filter((i) => i.severity === "error").length;
  const warnCount = check.issues.filter((i) => i.severity === "warn").length;
  add(
    "check-clean",
    2,
    errCount === 0 && check.runtimeErrors.length === 0,
    errCount === 0 ? "0 errors" : `${errCount} errors, ${check.runtimeErrors.length} runtime`,
  );

  // 2. non-trivial timeline
  const tl = await timelineCmd(dir);
  const clipCount = tl.clips.length;
  const duration = tl.duration;
  add("has-timeline", 1, clipCount >= 1 && duration > 0, `${clipCount} clips, ${duration.toFixed(1)}s`);

  // 3. frames differ (motion present) — 3 snapshots compared by size
  try {
    const snaps = await snapshotTimes(
      dir,
      "index.html",
      [0.1, duration / 2, Math.max(0.2, duration - 0.2)],
      join(dir, ".framecraft", "eval-snaps"),
    );
    const sizes = snaps.map((f) => statSync(f).size);
    const unique = new Set(sizes).size;
    add("motion", 1, unique >= 2, `${unique}/3 distinct frames`);
  } catch (e) {
    add("motion", 1, false, `snapshot failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }

  // 4. draft render + duration fidelity + audio
  const out = opts.renderOut ?? join(dir, "eval-draft.mp4");
  try {
    const t0 = Date.now();
    await render({
      projectDir: dir,
      composition: "index.html",
      out,
      quality: "draft",
      workers: 1,
      scale: 0.5,
    });
    const probe = (await probeCmd(out)) as { duration?: number; hasAudio?: boolean };
    const durOk =
      typeof probe.duration === "number" && duration > 0
        ? Math.abs(probe.duration - duration) / duration <= 0.1
        : false;
    add(
      "render",
      2,
      existsSync(out) && durOk,
      `${probe.duration?.toFixed(1)}s vs ${duration.toFixed(1)}s (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
    const needAudio = true; // plan: footage edits carry audio; flag absence
    add(
      "audio",
      1,
      probe.hasAudio === true || !needAudio,
      probe.hasAudio ? "audio stream present" : "no audio stream",
    );
  } catch (e) {
    add("render", 2, false, `render failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    add("audio", 1, false, "skipped");
  }

  // 5. no warnings either
  add("no-warnings", 1, warnCount === 0, `${warnCount} warnings`);

  const total = rules.reduce((s, r) => s + r.weight, 0);
  const got = rules.filter((r) => r.pass).reduce((s, r) => s + r.weight, 0);
  const score = got / total;
  return { dir, score, pass: score >= 0.7, rules };
}
