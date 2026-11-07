import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { CLI_NAME, VERSION } from "@framecraft/contract";
import { render } from "@framecraft/producer";
import { startStudioServer } from "@framecraft/studio-server";
import { defineCommand, runMain } from "citty";
import { addBlock } from "./add.js";
import { captionsCmd } from "./captions.js";
import { checkProject, reportCheck } from "./check.js";
import { compareVideos } from "./compare.js";
import { copyPrompt } from "./copyPrompt.js";
import { cutsCmd } from "./cuts.js";
import { doctor, reportDoctor } from "./doctor.js";
import { ERR, guardJson, jsonErr, jsonOut } from "./errors.js";
import { evalProject } from "./evals.js";
import { initProject } from "./init.js";
import { probeCmd, timelineCmd } from "./inspect.js";
import { previewProject } from "./preview.js";
import { removeBackgroundCmd } from "./removeBackground.js";
import { scaffoldCmd } from "./scaffold.js";
import { skillsUpdateCmd } from "./skills.js";
import { contactSheet, snapshotTimes } from "./snapshot.js";
import { styleCmd } from "./style.js";
import { transcribeCmd } from "./transcribe.js";
import { ttsCmd } from "./tts.js";

const JSON_ARG = {
  json: { type: "boolean" as const, description: "machine-readable output", default: false },
};

/** `--workers auto`: ~1 Chrome per 3 cores, capped (17 §3.5 / MV7.6). */
function autoWorkers(): number {
  return Math.min(8, Math.max(1, Math.floor(cpus().length / 3)));
}

const renderCmd = defineCommand({
  meta: { name: "render", description: "Render a composition to video" },
  args: {
    dir: { type: "positional", description: "project directory", required: false, default: "." },
    composition: { type: "string", description: "composition file", default: "index.html" },
    out: { type: "string", description: "output file", default: "out.mp4" },
    fps: { type: "string", description: "frames per second" },
    quality: { type: "string", description: "draft | standard | high", default: "standard" },
    format: { type: "string", description: "mp4 | webm | mov | gif | png-seq | hls", default: "mp4" },
    alpha: { type: "boolean", description: "preserve alpha (webm/mov)", default: false },
    workers: { type: "string", description: "parallel render workers (or 'auto')", default: "1" },
    range: { type: "string", description: "render only start-end seconds (e.g. 1.5-4)" },
    draft: { type: "boolean", description: "half-res fast draft", default: false },
    scale: { type: "string", description: "output scale factor (e.g. 0.5)" },
    profile: { type: "boolean", description: "print per-stage timings", default: false },
    ...JSON_ARG,
  },
  async run({ args }) {
    await guardJson(args.json, async () => {
      const range = args.range
        ? (() => {
            const m = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(String(args.range));
            if (!m)
              throw Object.assign(new Error(`bad --range "${args.range}" (use start-end)`), {
                code: ERR.INVALID_PROJECT,
              });
            return { start: Number(m[1]), end: Number(m[2]) };
          })()
        : undefined;
      const workers = args.workers === "auto" ? autoWorkers() : Number(args.workers) || 1;
      const res = await render({
        projectDir: String(args.dir),
        composition: String(args.composition),
        out: String(args.out),
        fps: args.fps ? Number(args.fps) : undefined,
        quality: args.quality as "draft" | "standard" | "high",
        format: args.format as "mp4" | "webm" | "mov" | "gif" | "png-seq" | "hls",
        alpha: args.alpha,
        workers,
        range,
        scale: args.draft || args.quality === "draft" ? 0.5 : args.scale ? Number(args.scale) : undefined,
        onProgress: args.json
          ? undefined
          : (done, total) => {
              if (done % 15 === 0 || done === total) process.stderr.write(`\rrender ${done}/${total} frames`);
            },
      });
      if (!args.json) {
        process.stderr.write("\n");
        if (args.profile && res.stages) {
          for (const [k, ms] of Object.entries(res.stages)) {
            console.log(`  ${k}: ${(ms / 1000).toFixed(1)}s`);
          }
        }
        console.log(
          `${res.out}  ${res.width}x${res.height} @${res.fps}fps  ${res.frames} frames  ${res.duration.toFixed(2)}s${res.beginFrame ? "  [beginFrame]" : "  [screenshot]"}`,
        );
      } else jsonOut(res);
    });
  },
});

const initCmd = defineCommand({
  meta: { name: "init", description: "Scaffold a new Framecraft project" },
  args: {
    dir: { type: "positional", description: "project directory", required: false, default: "." },
    name: { type: "string", description: "project name" },
    duration: { type: "string", description: "duration seconds", default: "5" },
    footage: { type: "string", description: "raw footage file → footage project layout" },
    width: { type: "string", description: "output width (default: source)" },
    height: { type: "string", description: "output height (default: source)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    await guardJson(args.json, async () => {
      const files = await initProject(String(args.dir), {
        name: args.name,
        duration: Number(args.duration),
        footage: args.footage,
        width: args.width ? Number(args.width) : undefined,
        height: args.height ? Number(args.height) : undefined,
      });
      if (args.json) jsonOut({ files, dir: String(args.dir) });
      else {
        console.log(`created: ${files.join(", ")}`);
        console.log(`\nnext: cd ${args.dir} && ${CLI_NAME} check && ${CLI_NAME} render`);
      }
    });
  },
});

const checkCmd = defineCommand({
  meta: { name: "check", description: "Lint + headless browser gate" },
  args: {
    dir: { type: "positional", description: "project directory", required: false, default: "." },
    composition: { type: "string", default: "index.html" },
    "no-browser": { type: "boolean", description: "static lint only", default: false },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      checkProject(String(args.dir), String(args.composition), {
        browser: !args["no-browser"],
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(reportCheck(res));
    if (!res.ok) process.exitCode = 1;
  },
});

const previewCmd = defineCommand({
  meta: { name: "preview", description: "Serve a local scrub preview" },
  args: {
    dir: { type: "positional", default: "." },
    composition: { type: "string", default: "index.html" },
  },
  async run({ args }) {
    const { url } = await previewProject(String(args.dir), String(args.composition));
    console.log(`preview: ${url}`);
    await new Promise(() => {}); // hold until killed
  },
});

const studioCmd = defineCommand({
  meta: { name: "studio", description: "Open the Studio editor" },
  args: {
    dir: { type: "positional", default: "." },
    port: { type: "string", default: "0" },
  },
  async run({ args }) {
    const { url, compositionUrl } = await startStudioServer(String(args.dir), {
      port: Number(args.port) || 0,
    });
    console.log(`studio:   ${url}`);
    console.log(`serving:  ${compositionUrl}`);
    await new Promise(() => {});
  },
});

const snapshotCmd = defineCommand({
  meta: { name: "snapshot", description: "Capture PNGs at specific times" },
  args: {
    dir: { type: "positional", default: "." },
    composition: { type: "string", default: "index.html" },
    times: { type: "string", description: "comma-separated seconds", required: true },
    out: { type: "string", description: "output dir", default: "snapshots" },
    "contact-sheet": { type: "string", description: "also write tiled sheet to this path" },
    cols: { type: "string", description: "contact-sheet columns", default: "3" },
    ...JSON_ARG,
  },
  async run({ args }) {
    await guardJson(args.json, async () => {
      const times = String(args.times).split(",").map(Number).filter(Number.isFinite);
      const outs = await snapshotTimes(String(args.dir), String(args.composition), times, String(args.out));
      const sheet = args["contact-sheet"]
        ? await contactSheet(
            outs,
            [...times].sort((a, b) => a - b),
            String(args["contact-sheet"]),
            Number(args.cols) || 3,
          )
        : undefined;
      if (args.json) jsonOut({ snapshots: outs, contactSheet: sheet });
      else {
        for (const o of outs) console.log(o);
        if (sheet) console.log(sheet);
      }
    });
  },
});

const compareCmd = defineCommand({
  meta: { name: "compare", description: "PSNR between two videos" },
  args: {
    a: { type: "positional", required: true },
    b: { type: "positional", required: true },
    ...JSON_ARG,
  },
  async run({ args }) {
    await guardJson(args.json, async () => {
      const r = await compareVideos(String(args.a), String(args.b));
      if (args.json) jsonOut(r);
      else
        console.log(
          `PSNR: ${r.psnr === Number.POSITIVE_INFINITY ? "∞ (identical)" : `${r.psnr.toFixed(2)} dB`}`,
        );
    });
  },
});

const addCmd = defineCommand({
  meta: { name: "add", description: "Install a registry block into compositions/" },
  args: {
    name: { type: "positional", required: true },
    dir: { type: "string", default: "." },
    ...JSON_ARG,
  },
  async run({ args }) {
    await guardJson(args.json, async () => {
      const r = await addBlock(String(args.dir), String(args.name));
      if (args.json) jsonOut({ block: String(args.name), ...r });
      else {
        console.log(`installed ${args.name} → ${r.dest}`);
        console.log(`files: ${r.files.join(", ")}`);
        console.log(
          r.files[0]?.startsWith("media/")
            ? `use:  <audio class="clip" data-start="…" data-duration="…" src="${r.files[0]}"></audio>`
            : `use:  <div class="clip" data-start="…" data-duration="…" data-composition-src="compositions/${args.name}/index.html"></div>`,
        );
      }
    });
  },
});

const catalogCmd = defineCommand({
  meta: { name: "catalog", description: "List registry blocks and SFX" },
  args: { ...JSON_ARG, type: { type: "string", description: "block | sfx | all" } },
  async run({ args }) {
    await guardJson(args.json, async () => {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const regRoot = fileURLToPath(new URL("../../../registry", import.meta.url));
      const catalog = JSON.parse(await readFile(join(regRoot, "catalog.json"), "utf8")) as {
        items: Array<{ name: string; type?: string; description?: string }>;
      };
      const items = catalog.items.filter(
        (i) => !args.type || args.type === "all" || (i.type ?? "block") === args.type,
      );
      if (args.json) jsonOut({ items });
      else {
        for (const i of items) {
          console.log(`${(i.type ?? "block").padEnd(6)} ${i.name.padEnd(22)} ${i.description ?? ""}`);
        }
      }
    });
  },
});

const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "Check environment health" },
  args: {
    dir: { type: "positional", required: false },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      doctor({ projectDir: args.dir ? String(args.dir) : undefined }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(reportDoctor(res));
    if (!res.ok) process.exitCode = 1;
  },
});

const transcribeCliCmd = defineCommand({
  meta: { name: "transcribe", description: "Transcribe media → transcript.json (local whisper)" },
  args: {
    media: { type: "positional", required: true },
    model: { type: "string", description: "whisper model", default: "small.en" },
    out: { type: "string", description: "output transcript path" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      transcribeCmd({
        media: String(args.media),
        model: String(args.model),
        out: args.out,
        json: args.json,
        onBytes: (n) => process.stderr.write(`\rmodel download: ${(n / 1e6).toFixed(0)} MB`),
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else
      console.log(`transcript: ${res.path}  (${res.words} words, ${res.duration.toFixed(1)}s, ${res.model})`);
  },
});

const cutsCliCmd = defineCommand({
  meta: { name: "cuts", description: "Transcript → dead-air cut plan" },
  args: {
    transcript: { type: "positional", required: true },
    threshold: { type: "string", description: "silence gap seconds", default: "0.35" },
    pad: { type: "string", description: "pad around kept segments", default: "0.06" },
    out: { type: "string", description: "output plan path", default: "cuts.json" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      cutsCmd({
        transcript: String(args.transcript),
        threshold: Number(args.threshold),
        pad: Number(args.pad),
        out: args.out,
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else
      console.log(
        `cuts: ${res.path}  (${res.segments} segments, ${res.duration.toFixed(1)}s kept, ${res.removed.toFixed(1)}s removed)`,
      );
  },
});

const scaffoldCliCmd = defineCommand({
  meta: { name: "scaffold", description: "Footage → neutral index.html" },
  args: {
    media: { type: "positional", required: true },
    cuts: { type: "string", description: "apply a cuts.json plan" },
    transcript: { type: "string", description: "compute cuts from transcript.json" },
    width: { type: "string" },
    height: { type: "string" },
    dir: { type: "string", description: "project dir", default: "." },
    out: { type: "string", description: "composition filename", default: "index.html" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      scaffoldCmd({
        media: String(args.media),
        cuts: args.cuts,
        transcript: args.transcript,
        width: args.width ? Number(args.width) : undefined,
        height: args.height ? Number(args.height) : undefined,
        dir: String(args.dir),
        out: args.out,
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else
      console.log(
        `scaffolded: ${res.path}  (${res.segments} segments, ${res.duration.toFixed(1)}s, ${res.width}x${res.height})`,
      );
  },
});

const captionsCliCmd = defineCommand({
  meta: { name: "captions", description: "Transcript → caption track in index.html" },
  args: {
    transcript: { type: "positional", required: true },
    cuts: { type: "string", description: "cuts.json to map source→comp time" },
    mode: { type: "string", description: "word | phrase", default: "word" },
    emphasis: { type: "string", description: "comma-separated words to accent" },
    max: { type: "string", description: "max words per phrase", default: "4" },
    dir: { type: "string", description: "project dir", default: "." },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      captionsCmd({
        dir: String(args.dir),
        transcript: String(args.transcript),
        cuts: args.cuts,
        mode: String(args.mode) === "phrase" ? "phrase" : "word",
        emphasis: args.emphasis ? String(args.emphasis).split(",") : [],
        maxPhraseWords: Number(args.max),
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(`captions: ${res.captions} ${res.mode}-captions → ${res.path}`);
  },
});

const probeCliCmd = defineCommand({
  meta: { name: "probe", description: "Probe media file" },
  args: { media: { type: "positional", required: true }, ...JSON_ARG },
  async run({ args }) {
    const res = await guardJson(args.json, () => probeCmd(String(args.media)));
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(JSON.stringify(res, null, 2));
  },
});

const timelineCliCmd = defineCommand({
  meta: { name: "timeline", description: "Resolved clip list" },
  args: {
    dir: { type: "positional", default: "." },
    composition: { type: "string", default: "index.html" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () => timelineCmd(String(args.dir), String(args.composition)));
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(JSON.stringify(res, null, 2));
  },
});

const styleCliCmd = defineCommand({
  meta: { name: "style", description: "Manage the user style.md" },
  args: {
    action: { type: "positional", description: "init | show | path", required: true },
    dir: { type: "string", default: "." },
    global: { type: "boolean", description: "use ~/.config/framecraft/style.md", default: false },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      styleCmd({
        action: String(args.action) as "init" | "show" | "path",
        dir: String(args.dir),
        global: args.global,
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else if (String(args.action) === "show") console.log(res.content ?? "");
    else console.log(res.path ?? "no style.md resolved");
  },
});

const skillsCliCmd = defineCommand({
  meta: { name: "skills", description: "Install agent skills into a project" },
  args: {
    action: { type: "positional", description: "update", default: "update" },
    dir: { type: "string", description: "project dir", default: "." },
    only: { type: "string", description: "comma-separated skill names" },
    global: { type: "boolean", default: false },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      skillsUpdateCmd({
        dir: String(args.dir),
        only: args.only ? String(args.only).split(",") : undefined,
        global: args.global,
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else {
      console.log(`installed skills: ${res.installed.join(", ")}`);
      for (const t of res.targets.slice(0, 6)) console.log(`  ${t}`);
      if (res.targets.length > 6) console.log(`  … +${res.targets.length - 6} more`);
    }
  },
});

const ttsCliCmd = defineCommand({
  meta: { name: "tts", description: "Text → speech audio file" },
  args: {
    text: { type: "positional", required: true },
    out: { type: "string", default: "vo.wav" },
    voice: { type: "string" },
    provider: { type: "string", description: "say | edge | kokoro" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      ttsCmd({
        text: String(args.text),
        out: String(args.out),
        voice: args.voice,
        provider: args.provider as "say" | "edge" | "kokoro" | undefined,
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(`tts: ${res.path}  (${res.duration.toFixed(1)}s, ${res.provider}/${res.voice})`);
  },
});

const removeBgCliCmd = defineCommand({
  meta: { name: "remove-background", description: "Cut subject out (image→PNG, video→WebM alpha)" },
  args: {
    media: { type: "positional", required: true },
    out: { type: "string" },
    start: { type: "string", description: "start seconds (video)" },
    end: { type: "string", description: "end seconds (video)" },
    smoothing: { type: "string", default: "0.4" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const res = await guardJson(args.json, () =>
      removeBackgroundCmd({
        media: String(args.media),
        out: args.out,
        start: args.start ? Number(args.start) : undefined,
        end: args.end ? Number(args.end) : undefined,
        smoothing: Number(args.smoothing),
      }),
    );
    if (res == null) return;
    if (args.json) jsonOut(res);
    else console.log(`cutout: ${res.path}  (${res.kind}${res.frames ? `, ${res.frames} frames` : ""})`);
  },
});

const evalCliCmd = defineCommand({
  meta: { name: "eval", description: "Rule-scored project checklist (pass ≥ 0.7)" },
  args: { dir: { type: "positional", default: "." }, ...JSON_ARG },
  async run({ args }) {
    const res = await guardJson(args.json, () => evalProject({ dir: String(args.dir) }));
    if (res == null) return;
    if (args.json) jsonOut(res);
    else {
      for (const r of res.rules) console.log(` ${r.pass ? "✓" : "✗"} ${r.name} (w${r.weight}) — ${r.note}`);
      console.log(`score ${(res.score * 100).toFixed(0)}% → ${res.pass ? "PASS" : "FAIL"}`);
    }
  },
});

const mcpCliCmd = defineCommand({
  meta: { name: "mcp", description: "MCP server over stdio for agent clients" },
  args: {},
  async run() {
    await import("./mcp.js");
    // mcp.ts installs the stdio loop on import; keep alive.
    await new Promise(() => {});
  },
});

const copyPromptCliCmd = defineCommand({
  meta: { name: "copy-prompt", description: "Print a ready-made agent prompt for this project" },
  args: { dir: { type: "string", default: "." }, ...JSON_ARG },
  async run({ args }) {
    const text = await copyPrompt({ dir: String(args.dir) });
    if (args.json) jsonOut({ prompt: text });
    else console.log(text);
  },
});

const main = defineCommand({
  meta: { name: CLI_NAME, version: VERSION, description: "Framecraft — HTML to video" },
  subCommands: {
    init: initCmd,
    check: checkCmd,
    render: renderCmd,
    preview: previewCmd,
    studio: studioCmd,
    snapshot: snapshotCmd,
    compare: compareCmd,
    add: addCmd,
    catalog: catalogCmd,
    doctor: doctorCmd,
    transcribe: transcribeCliCmd,
    cuts: cutsCliCmd,
    scaffold: scaffoldCliCmd,
    captions: captionsCliCmd,
    probe: probeCliCmd,
    timeline: timelineCliCmd,
    style: styleCliCmd,
    skills: skillsCliCmd,
    mcp: mcpCliCmd,
    "copy-prompt": copyPromptCliCmd,
    tts: ttsCliCmd,
    eval: evalCliCmd,
    "remove-background": removeBgCliCmd,
  },
});

export function run(): void {
  runMain(main);
}
