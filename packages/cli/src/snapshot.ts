import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCompositionHtml } from "@framecraft/contract";
import { CaptureSession, ensureChrome, startFileServer } from "@framecraft/engine";
import { getRuntimeSource } from "@framecraft/runtime";
import puppeteer from "puppeteer-core";
import { writeFile } from "node:fs/promises";

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

  const chrome = await ensureChrome({ headlessShell: true });
  const server = await startFileServer(dir);
  let browser;
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
    const cap = new CaptureSession(page, { width: spec.width, height: spec.height, fps, disableBeginFrame: true });
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
