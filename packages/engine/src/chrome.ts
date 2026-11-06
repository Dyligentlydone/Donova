import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR, ENV_PREFIX } from "@framecraft/contract";

/** Deterministic flags (03 §2). Order matters to nothing, but keep stable. */
export function deterministicFlags(): string[] {
  return [
    "--deterministic-mode",
    "--enable-begin-frame-control",
    "--run-all-compositor-stages-before-draw",
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--disable-checker-imaging",
    "--disable-features=PaintHolding",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "--disable-font-subpixel-positioning",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
  ];
}

export interface ChromeInfo {
  executablePath: string;
  version: string;
  headless: "shell" | "new" | "system";
}

let cachedChrome: ChromeInfo | null = null;

function cacheDir(): string {
  const d = join(homedir(), CACHE_DIR, "chrome");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Resolve a Chrome executable: env → system Chrome → @puppeteer/browsers install. */
export async function ensureChrome(opts?: { headlessShell?: boolean }): Promise<ChromeInfo> {
  if (cachedChrome) return cachedChrome;

  const envPath = process.env[`${ENV_PREFIX}CHROME_PATH`];
  if (envPath && existsSync(envPath)) {
    cachedChrome = { executablePath: envPath, version: "env", headless: "system" };
    return cachedChrome;
  }

  const { install, canDownload, getInstalledBrowsers, computeExecutablePath, detectBrowserPlatform } =
    await import("@puppeteer/browsers");

  // 1) Previously downloaded chrome-headless-shell / chrome. headless-shell is
  //    required for HeadlessExperimental.beginFrame (03 §3) — prefer it.
  const browsers = (await getInstalledBrowsers({ cacheDir: cacheDir() })) as Array<{
    browser: string;
    buildId: string;
    platform: string;
  }>;
  const preferred = opts?.headlessShell === false ? "chrome" : "chrome-headless-shell";
  const found = browsers.find((b) => b.browser === preferred) ?? browsers.find((b) => b.browser === "chrome");
  if (found) {
    const platform = detectBrowserPlatform();
    const executablePath = computeExecutablePath({
      browser: found.browser as never,
      buildId: found.buildId,
      cacheDir: cacheDir(),
      platform: platform as never,
    });
    if (existsSync(executablePath)) {
      cachedChrome = { executablePath, version: found.buildId, headless: preferred === "chrome-headless-shell" ? "shell" : "new" };
      return cachedChrome;
    }
  }

  // 2) System Chrome (no beginFrame → capture falls back to screenshots).
  const { computeSystemExecutablePath } = await import("@puppeteer/browsers");
  try {
    const p = computeSystemExecutablePath({ browser: "chrome" as never, channel: "stable" as never });
    if (existsSync(p)) {
      cachedChrome = { executablePath: p, version: "system", headless: "system" };
      return cachedChrome;
    }
  } catch {
    /* no system chrome */
  }

  // 3) Download a pinned build.
  const buildId = process.env[`${ENV_PREFIX}CHROME_BUILD`] ?? "stable";
  if (!(await canDownload({ browser: "chrome-headless-shell" as never, buildId, cacheDir: cacheDir() }))) {
    throw new Error(`Cannot download chrome-headless-shell ${buildId}.`);
  }
  const installed = await install({ browser: "chrome-headless-shell" as never, buildId, cacheDir: cacheDir() });
  cachedChrome = {
    executablePath: installed.executablePath,
    version: installed.buildId,
    headless: "shell",
  };
  return cachedChrome;
}

export function profileDirFor(runId: string): string {
  const h = createHash("sha1").update(runId).digest("hex").slice(0, 12);
  const d = join(homedir(), CACHE_DIR, "profiles", h);
  mkdirSync(d, { recursive: true });
  return d;
}
