import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ContractIssue } from "@donova/contract";
import { ensureChrome, startFileServer } from "@donova/engine";
import { formatIssues, lintHtml, summarize } from "@donova/lint";
import { getRuntimeSource } from "@donova/runtime";
import puppeteer from "puppeteer-core";
import { type EngineDecision, decideEngine, describeDecision } from "./engineRoute.js";

export interface CheckResult {
  issues: ContractIssue[];
  runtimeErrors: string[];
  ok: boolean;
  engine: EngineDecision;
}

/**
 * `donova check` — static lint + headless browser gate (07 §4).
 * Browser pass: boot the page, run runtime, seek through the timeline,
 * collect pageerror/console.error + overflow findings.
 */
export async function checkProject(
  projectDir: string,
  composition = "index.html",
  opts?: { browser?: boolean },
): Promise<CheckResult> {
  const dir = resolve(projectDir);
  const html = await readFile(join(dir, composition), "utf8");
  const { issues } = lintHtml(html, { path: composition, isRoot: true });
  const runtimeErrors: string[] = [];

  if (opts?.browser !== false) {
    const chrome = await ensureChrome({ headlessShell: true });
    const server = await startFileServer(dir);
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    try {
      browser = await puppeteer.launch({
        executablePath: chrome.executablePath,
        headless: chrome.headless === "shell" ? ("shell" as never) : true,
        args: [
          "--mute-audio",
          "--no-first-run",
          "--force-color-profile=srgb",
          // containers run as root — chromium refuses to start without these
          ...(process.platform === "linux"
            ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            : []),
        ],
        defaultViewport: { width: 640, height: 360 },
      });
      const page = await browser.newPage();
      page.on("pageerror", (e) =>
        runtimeErrors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`),
      );
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        // Browsers auto-request /favicon.ico; a missing one is not a defect.
        const loc = m.location()?.url ?? "";
        if (loc.endsWith("/favicon.ico")) return;
        runtimeErrors.push(`console.error: ${m.text()}`);
      });
      await page.goto(`${server.url}/${composition}`, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(getRuntimeSource());
      await page.waitForFunction("window.__playerReady === true", { timeout: 10_000 });

      const { spec } = lintHtml(html, { path: composition, isRoot: true });
      const dur = spec.duration || 2;
      const fps = spec.fps ?? 30;
      const steps = Math.min(Math.ceil(dur * 4), 60); // sample ~4 probes/sec, max 60
      const seek = (tt: number) =>
        (window as unknown as { __fc?: { renderSeek(t: number): Promise<void> } }).__fc?.renderSeek?.(tt);
      for (let i = 0; i <= steps; i++) {
        const t = (dur * i) / steps;
        await page.evaluate(seek, t);
      }

      // Layout probe at mid-point: elements clipped outside the composition root.
      const tMid = dur / 2;
      await page.evaluate(seek, tMid);
      const overflow = await page.evaluate(() => {
        const root = document.querySelector("[data-composition-id]");
        if (!root) return [];
        const r = root.getBoundingClientRect();
        const bad: string[] = [];
        for (const el of document.querySelectorAll("[data-start]")) {
          const e = el.getBoundingClientRect();
          if (e.width === 0) continue;
          const over =
            e.right > r.right + 2 || e.bottom > r.bottom + 2 || e.left < r.left - 2 || e.top < r.top - 2;
          if (over && getComputedStyle(el).display !== "none") {
            bad.push(`<${el.tagName.toLowerCase()}> overflows composition bounds`);
          }
        }
        return bad.slice(0, 10);
      });
      for (const o of overflow) {
        issues.push({ rule: "layout-overflow", severity: "warn", message: o });
      }
      void fps;
    } finally {
      await browser?.close().catch(() => {});
      await server.close();
    }
  }

  const engine = decideEngine(dir, composition);
  for (const r of engine.reasons) {
    issues.push({
      rule: "render-engine-hyperframes",
      severity: "info",
      message: `${r.label} renders via the hyperframes engine (fc render routes automatically)`,
      file: r.file,
    });
  }
  const s = summarize(issues);
  return { issues, runtimeErrors, ok: s.errors === 0 && runtimeErrors.length === 0, engine };
}

export function reportCheck(res: CheckResult): string {
  const parts: string[] = [];
  if (res.issues.length) parts.push(formatIssues(res.issues));
  if (res.runtimeErrors.length) {
    parts.push(res.runtimeErrors.map((e) => `✖ runtime: ${e}`).join("\n"));
  }
  const s = summarize(res.issues);
  parts.push(
    `\n${s.errors} errors, ${s.warnings} warnings, ${s.info} info, ${res.runtimeErrors.length} runtime errors`,
  );
  parts.push(describeDecision(res.engine));
  parts.push(res.ok ? "✓ check passed" : "✖ check failed");
  return parts.join("\n");
}
