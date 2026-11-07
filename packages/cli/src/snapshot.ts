import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseCompositionHtml } from "@framecraft/contract";
import {
  CaptureSession,
  ensureChrome,
  locateFfmpeg,
  prepareVideoFrames,
  runFfmpeg,
  startFileServer,
} from "@framecraft/engine";
import { getRuntimeSource } from "@framecraft/runtime";
import puppeteer from "puppeteer-core";

/**
 * `framecraft snapshot` — capture specific times as PNGs (agent tool: lets an
 * agent LOOK at frames). `framecraft compare` — PSNR between two videos/frames.
 */
export async function snapshotTimes(
  projectDir: string,
  composition: string,
  times: number[],
  outDir: string,
): Promise<string[]> {
  const dir = resolve(projectDir);
  const html = await readFile(join(dir, composition), "utf8");
  const { spec } = parseCompositionHtml(html, { isRoot: true, path: composition });
  const fps = spec.fps ?? 30;

  // Compositions with <video> need frame overlays (.framecraft/video-map.json)
  // or snapshots show the raw element — often black at early times.
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
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    const outs: string[] = [];
    const sorted = [...times].sort((a, b) => a - b);
    for (const t of sorted) {
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

/**
 * `framecraft snapshot --contact-sheet` — tile snapshots into one labeled image
 * (17 §3.5). Each tile gets a `t=X.XXs` burn-in so an agent can read times
 * from a single image instead of N separate files.
 */
export async function contactSheet(
  outs: string[],
  times: number[],
  outPath: string,
  cols = 3,
): Promise<string> {
  const { ffmpeg } = await locateFfmpeg();
  const dir = dirname(outPath);
  const labeled: string[] = [];
  for (let i = 0; i < outs.length; i++) {
    const dst = join(dir, `.fc-labeled-${i}.png`);
    await runFfmpeg(ffmpeg, [
      "-loop",
      "1",
      "-t",
      "1",
      "-i",
      outs[i] ?? "",
      "-vf",
      `drawtext=text='t=${(times[i] ?? 0).toFixed(2)}s':x=20:y=20:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12`,
      "-frames:v",
      "1",
      dst,
    ]);
    labeled.push(dst);
  }
  const listPath = join(dir, ".fc-sheet.txt");
  await writeFile(listPath, labeled.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const rows = Math.ceil(labeled.length / cols);
  await runFfmpeg(ffmpeg, [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    `scale=540:-1,tile=${cols}x${rows}`,
    "-frames:v",
    "1",
    outPath,
  ]);
  return outPath;
}
