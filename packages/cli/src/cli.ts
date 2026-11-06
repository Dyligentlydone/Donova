import { defineCommand, runMain } from "citty";
import { CLI_NAME, VERSION } from "@framecraft/contract";
import { render } from "@framecraft/producer";
import { checkProject, reportCheck } from "./check.js";
import { initProject } from "./init.js";
import { previewProject } from "./preview.js";
import { startStudioServer } from "@framecraft/studio-server";

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
    workers: { type: "string", description: "parallel render workers", default: "1" },
  },
  async run({ args }) {
    const res = await render({
      projectDir: String(args.dir),
      composition: String(args.composition),
      out: String(args.out),
      fps: args.fps ? Number(args.fps) : undefined,
      quality: args.quality as "draft" | "standard" | "high",
      format: args.format as "mp4" | "webm" | "mov" | "gif" | "png-seq" | "hls",
      alpha: args.alpha,
      workers: Number(args.workers) || 1,
      onProgress: (done, total) => {
        if (done % 15 === 0 || done === total) process.stderr.write(`\rrender ${done}/${total} frames`);
      },
    });
    process.stderr.write("\n");
    console.log(
      `${res.out}  ${res.width}x${res.height} @${res.fps}fps  ${res.frames} frames  ${res.duration}s` +
        (res.beginFrame ? "  [beginFrame]" : "  [screenshot]"),
    );
  },
});

const initCmd = defineCommand({
  meta: { name: "init", description: "Scaffold a new Framecraft project" },
  args: {
    dir: { type: "positional", description: "project directory", required: false, default: "." },
    name: { type: "string", description: "project name" },
    duration: { type: "string", description: "duration seconds", default: "5" },
  },
  async run({ args }) {
    const files = await initProject(String(args.dir), { name: args.name, duration: Number(args.duration) });
    console.log(`created: ${files.join(", ")}`);
    console.log(`\nnext: cd ${args.dir} && ${CLI_NAME} check && ${CLI_NAME} render`);
  },
});

const checkCmd = defineCommand({
  meta: { name: "check", description: "Lint + headless browser gate" },
  args: {
    dir: { type: "positional", description: "project directory", required: false, default: "." },
    composition: { type: "string", default: "index.html" },
    "no-browser": { type: "boolean", description: "static lint only", default: false },
    json: { type: "boolean", default: false },
  },
  async run({ args }) {
    const res = await checkProject(String(args.dir), String(args.composition), { browser: !args["no-browser"] });
    if (args.json) console.log(JSON.stringify(res, null, 2));
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
    const { url, compositionUrl } = await startStudioServer(String(args.dir), { port: Number(args.port) || 0 });
    console.log(`studio:   ${url}`);
    console.log(`serving:  ${compositionUrl}`);
    await new Promise(() => {});
  },
});

const main = defineCommand({
  meta: { name: CLI_NAME, version: VERSION, description: "Framecraft — HTML to video" },
  subCommands: { init: initCmd, check: checkCmd, render: renderCmd, preview: previewCmd, studio: studioCmd },
});

export function run(): void {
  runMain(main);
}
