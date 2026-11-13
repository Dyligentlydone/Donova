import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseCompositionHtml } from "@donova/contract";
import {
  CaptureSession,
  ensureChrome,
  locateFfmpeg,
  prepareVideoFrames,
  probe,
  startFileServer,
} from "@donova/engine";
import {
  generateCaptionsHtml,
  normalizeTranscript,
  planCuts,
  scaffoldFootage,
  transcribe as runTranscribe,
} from "@donova/media";
import type { CutPlan, Transcript } from "@donova/media";
import { getRuntimeSource } from "@donova/runtime";
import puppeteer from "puppeteer-core";
import {
  downloadAndExtractBundle,
  downloadProjectFiles,
  gcs,
  uploadProjectFiles,
} from "./storage.js";

/**
 * `POST /run` — the cloud-agent's media verbs. Pulls only the inputs a
 * command needs from the project prefix, runs it against the full Donova
 * toolchain in this image (ffmpeg + chrome + @donova/media), and pushes the
 * files it wrote back to the same prefix. Web pulls `filesWritten` into its
 * /tmp mirror afterwards, so agent turns never see stale state.
 */

export interface RunParams {
  cmd: string;
  args?: Record<string, unknown>;
  projectPrefix: string;
  bucket?: string;
}

export interface RunResult {
  ok: boolean;
  cmd: string;
  data?: unknown;
  filesWritten: string[];
  error?: string;
}

const DEFAULT_BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const MEDIA_CMDS = new Set(["probe", "transcribe", "cuts", "captions", "scaffold", "add", "snapshot"]);

const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Project-rel inputs a cmd needs pulled before it runs. `null` = full pull. */
function inputsFor(cmd: string, args: Record<string, unknown>): string[] | null {
  switch (cmd) {
    case "probe":
    case "transcribe":
      return [String(args.media ?? "")];
    case "cuts":
      return [s(args.transcript) ?? "transcript.json"];
    case "captions":
      return ["index.html", s(args.transcript) ?? "transcript.json", ...(s(args.cuts) ? [s(args.cuts)!] : [])];
    case "scaffold":
      return [String(args.media ?? ""), ...(s(args.cuts) ? [s(args.cuts)!] : []), ...(s(args.transcript) ? [s(args.transcript)!] : [])];
    case "add":
      return [];
    case "snapshot":
      return null;
    default:
      throw new Error(`unknown run cmd: ${cmd}`);
  }
}

function registryRoot(): string {
  const candidates = [
    process.env.DONOVA_REGISTRY,
    "/app/registry", // worker image layout
    resolve(process.cwd(), "registry"),
    resolve(process.cwd(), "../../registry"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(join(p, "catalog.json")));
  if (!found) throw new Error("registry catalog.json not found (set DONOVA_REGISTRY)");
  return found;
}

async function snapshotTimes(
  projectDir: string,
  composition: string,
  times: number[],
  outDir: string,
): Promise<string[]> {
  const dir = resolve(projectDir);
  const html = await readFile(join(dir, composition), "utf8");
  const { spec } = parseCompositionHtml(html, { isRoot: true, path: composition });
  const fps = spec.fps ?? 30;

  const { ffmpeg, ffprobe } = await locateFfmpeg();
  if (/<video[\s>]/i.test(html)) {
    await prepareVideoFrames(ffmpeg, ffprobe, dir, spec, fps);
  }

  const chrome = await ensureChrome({ headlessShell: true });
  const server = await startFileServer(dir);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome.executablePath,
      headless: chrome.headless === "shell" ? ("shell" as never) : true,
      args: ["--mute-audio", "--no-first-run", "--force-color-profile=srgb", "--hide-scrollbars"],
      defaultViewport: { width: spec.width, height: spec.height, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    await page.goto(`${server.url}/${composition}`, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(getRuntimeSource());
    await page.waitForFunction("window.__playerReady === true", { timeout: 15_000 });
    const cap = new CaptureSession(page, {
      width: spec.width,
      height: spec.height,
      fps,
      disableBeginFrame: true,
    });
    await cap.init();
    await mkdir(outDir, { recursive: true });
    const outs: string[] = [];
    for (const t of [...times].sort((a, b) => a - b)) {
      const out = join(outDir, `t${t.toFixed(3)}.png`);
      await cap.captureFrame(t, async (f) => {
        await writeFile(out, f.data);
      });
      outs.push(out);
    }
    return outs;
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}

export async function executeRun(params: RunParams): Promise<RunResult> {
  const { cmd } = params;
  if (!MEDIA_CMDS.has(cmd)) {
    return { ok: false, cmd, filesWritten: [], error: `unknown run cmd: ${cmd}` };
  }
  const bucket = params.bucket || DEFAULT_BUCKET;
  const prefix = params.projectPrefix;
  const args = params.args ?? {};
  const jobId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = join("/tmp", "donova-run", jobId);
  const written: string[] = [];

  try {
    const inputs = inputsFor(cmd, args);
    if (inputs === null) {
      await downloadAndExtractBundle({ bucket, projectPrefix: prefix, destDir: dir });
    } else {
      const pulled = await downloadProjectFiles(gcs(), bucket, prefix, inputs, dir);
      const media = s(args.media);
      if ((cmd === "probe" || cmd === "transcribe" || cmd === "scaffold") && (!media || !pulled.includes(media))) {
        throw new Error(`media not found in project: ${media || "(missing args.media)"}`);
      }
      if (cmd === "cuts" && !pulled.length) {
        throw new Error(`transcript not found: ${inputs[0]} — run transcribe first`);
      }
      if (cmd === "captions" && !pulled.includes("index.html")) {
        throw new Error("index.html not found in project");
      }
    }

    switch (cmd) {
      case "probe": {
        const { ffprobe } = await locateFfmpeg();
        const p = await probe(ffprobe, join(dir, String(args.media)));
        return { ok: true, cmd, data: p, filesWritten: written };
      }
      case "transcribe": {
        const media = String(args.media);
        const t = await runTranscribe(join(dir, media), {
          engine: "parakeet", // no whisper-cli in the image
          model: s(args.model),
          prompt: s(args.prompt),
          language: s(args.language),
        });
        const out = s(args.out) ?? "transcript.json";
        await writeFile(join(dir, out), `${JSON.stringify(t, null, 2)}\n`);
        written.push(out);
        return {
          ok: true,
          cmd,
          data: { path: out, words: t.words.length, duration: t.duration, model: t.model },
          filesWritten: written,
        };
      }
      case "cuts": {
        const rel = s(args.transcript) ?? "transcript.json";
        const transcript = normalizeTranscript(
          JSON.parse(await readFile(join(dir, rel), "utf8")) as unknown,
        );
        if (!transcript.words.length) throw new Error(`${rel} has no transcript words`);
        const plan = planCuts(transcript, {
          silenceThreshold: n(args.threshold),
          pad: n(args.pad),
        });
        const out = s(args.out) ?? "cuts.json";
        await writeFile(join(dir, out), `${JSON.stringify(plan, null, 2)}\n`);
        written.push(out);
        return {
          ok: true,
          cmd,
          data: { path: out, segments: plan.segments.length, duration: plan.duration, removed: plan.removed },
          filesWritten: written,
        };
      }
      case "captions": {
        const transcript = normalizeTranscript(
          JSON.parse(await readFile(join(dir, s(args.transcript) ?? "transcript.json"), "utf8")) as unknown,
        ) as Transcript;
        let plan: CutPlan | undefined;
        const cutsRel = s(args.cuts);
        if (cutsRel && existsSync(join(dir, cutsRel))) {
          plan = JSON.parse(await readFile(join(dir, cutsRel), "utf8")) as CutPlan;
        }
        const html = await readFile(join(dir, "index.html"), "utf8");
        const res = generateCaptionsHtml({
          html,
          transcript,
          plan,
          mode: s(args.mode) === "phrase" ? "phrase" : "word",
          emphasis: Array.isArray(args.emphasis) ? (args.emphasis as string[]) : undefined,
          maxPhraseWords: n(args.maxPhraseWords),
        });
        await writeFile(join(dir, "index.html"), res.html);
        written.push("index.html");
        return { ok: true, cmd, data: { path: "index.html", captions: res.captions, mode: res.mode }, filesWritten: written };
      }
      case "scaffold": {
        const media = String(args.media);
        const { ffprobe } = await locateFfmpeg();
        const p = await probe(ffprobe, join(dir, media));
        if (!p.width || !p.height) throw new Error(`cannot probe video dims: ${media}`);
        const rot = Math.abs(p.rotation ?? 0);
        const dispW = rot === 90 || rot === 270 ? p.height : p.width;
        const dispH = rot === 90 || rot === 270 ? p.width : p.height;

        let plan: CutPlan;
        if (s(args.cuts) && existsSync(join(dir, String(args.cuts)))) {
          plan = JSON.parse(await readFile(join(dir, String(args.cuts)), "utf8")) as CutPlan;
        } else if (s(args.transcript) && existsSync(join(dir, String(args.transcript)))) {
          const t = JSON.parse(await readFile(join(dir, String(args.transcript)), "utf8")) as Transcript;
          plan = planCuts(normalizeTranscript(t));
        } else {
          plan = {
            version: 1,
            source: media,
            silenceThreshold: 0,
            pad: 0,
            sourceDuration: p.duration,
            duration: p.duration,
            removed: 0,
            segments: [
              { srcStart: 0, srcEnd: p.duration, compStart: 0, duration: p.duration, wordStart: 0, wordEnd: -1 },
            ],
          };
        }
        const html = scaffoldFootage({
          source: media, // project-rel path — resolves against the project root
          outWidth: n(args.width) ?? dispW,
          outHeight: n(args.height) ?? dispH,
          plan,
          fps: p.fps ? Math.round(p.fps) : 30,
        });
        const out = s(args.out) ?? "index.html";
        await mkdir(dirname(join(dir, out)), { recursive: true });
        await writeFile(join(dir, out), html);
        written.push(out);
        return {
          ok: true,
          cmd,
          data: { path: out, segments: plan.segments.length, duration: plan.duration, width: n(args.width) ?? dispW, height: n(args.height) ?? dispH },
          filesWritten: written,
        };
      }
      case "add": {
        const name = String(args.name ?? "");
        if (!name) throw new Error("add requires args.name");
        const regRoot = registryRoot();
        const catalog = JSON.parse(await readFile(join(regRoot, "catalog.json"), "utf8")) as {
          items: Array<{ name: string; path: string; type?: string }>;
        };
        const entry = catalog.items.find((i) => i.name === name);
        const blockDir = join(regRoot, entry?.path ?? `blocks/${name}`);
        if (!existsSync(blockDir)) {
          throw new Error(`block "${name}" not in registry`);
        }
        if (entry?.type === "sfx") {
          const dest = join(dir, "media", "sfx", name);
          await mkdir(dest, { recursive: true });
          for (const f of await readdir(blockDir)) {
            if (!/\.(wav|mp3|m4a|ogg)$/.test(f)) continue;
            await cp(join(blockDir, f), join(dest, f));
            written.push(join("media", "sfx", name, f).split("\\").join("/"));
          }
        } else {
          const meta = JSON.parse(await readFile(join(blockDir, "block.json"), "utf8")) as { files?: string[] };
          const dest = join(dir, "compositions", name);
          await mkdir(dest, { recursive: true });
          for (const f of meta.files ?? (await readdir(blockDir))) {
            if (f === "block.json") continue;
            await cp(join(blockDir, f), join(dest, f), { recursive: true });
            written.push(join("compositions", name, f).split("\\").join("/"));
          }
        }
        return { ok: true, cmd, data: { name, files: written }, filesWritten: written };
      }
      case "snapshot": {
        const times = Array.isArray(args.times) ? (args.times as number[]).filter((t) => Number.isFinite(t)) : [];
        if (!times.length) throw new Error("snapshot requires args.times (number[])");
        const composition = s(args.composition) ?? "index.html";
        const outRel = s(args.out) ?? ".donova/snapshots";
        const outs = await snapshotTimes(dir, composition, times, join(dir, outRel));
        for (const p of outs) {
          written.push(join(outRel, basename(p)).split("\\").join("/"));
        }
        return {
          ok: true,
          cmd,
          data: { frames: times.map((t, i) => ({ t, path: written[i] })) },
          filesWritten: written,
        };
      }
      default:
        return { ok: false, cmd, filesWritten: written, error: `unhandled cmd: ${cmd}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${jobId}] run ${cmd} failed:`, err);
    return { ok: false, cmd, filesWritten: written, error: message };
  } finally {
    // Push outputs back to the project prefix even on partial success.
    if (written.length) {
      try {
        await uploadProjectFiles(gcs(), bucket, prefix, dir, written);
      } catch (err) {
        console.error(`[${jobId}] push-back failed:`, err);
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
