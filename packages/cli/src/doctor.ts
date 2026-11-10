import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CACHE_DIR, ENV_PREFIX, LEGACY } from "@editnce/contract";
import { locateFfmpeg } from "@editnce/engine";
import {
  WHISPER_MODELS,
  findWhisperCli,
  parakeetModelInstalled,
  sherpaRuntimeLoadError,
  sherpaUnsupportedReason,
  whisperModelDir,
} from "@editnce/media";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** Human-readable value (version, path, size…). */
  value?: string;
  /** Actionable fix when !ok. */
  hint?: string;
  /** Required for rendering vs optional feature. */
  required: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

async function binVersion(bin: string, arg = "-version"): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, [arg], { timeout: 8000 });
    const line = (stdout || stderr).split("\n")[0] ?? "";
    return line.trim() || "present";
  } catch {
    return null;
  }
}

/**
 * `editnce doctor` — environment + project health (17 §3.1.1).
 * Every check prints an actionable hint; JSON output is machine-readable.
 */
export async function doctor(opts?: { projectDir?: string }): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // --- Node ---
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    name: "node",
    ok: nodeMajor >= 22,
    value: process.version,
    hint: nodeMajor >= 22 ? undefined : "Editnce needs Node ≥ 22.",
    required: true,
  });

  // --- ffmpeg / ffprobe ---
  let ffmpegOk = false;
  let ffmpegValue = "not found";
  try {
    const { ffmpeg, ffprobe } = await locateFfmpeg();
    const v = (await binVersion(ffmpeg)) ?? "";
    const encoders = await execFileAsync(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 8000 })
      .then((r) => r.stdout)
      .catch(() => "");
    const need = ["libx264", "libvpx-vp9", "aac"];
    const missing = need.filter((e) => !encoders.includes(e));
    ffmpegOk = missing.length === 0;
    ffmpegValue = `${v.split(" ").slice(0, 3).join(" ")} (${ffmpeg})`;
    checks.push({
      name: "ffmpeg",
      ok: ffmpegOk,
      value: ffmpegValue,
      hint: missing.length
        ? `ffmpeg lacks encoders: ${missing.join(", ")}. Install a full build (brew install ffmpeg).`
        : undefined,
      required: true,
    });
    const pv = await binVersion(ffprobe);
    checks.push({
      name: "ffprobe",
      ok: pv != null,
      value: pv ?? undefined,
      hint: pv == null ? "ffprobe not found (ships with ffmpeg: brew install ffmpeg)." : undefined,
      required: true,
    });
  } catch {
    checks.push({
      name: "ffmpeg",
      ok: false,
      value: "not found",
      hint: "Install ffmpeg (brew install ffmpeg) or set EDITNCE_FFMPEG.",
      required: true,
    });
    checks.push({
      name: "ffprobe",
      ok: false,
      value: "not found",
      hint: "Install ffmpeg (brew install ffmpeg) or set EDITNCE_FFPROBE.",
      required: true,
    });
  }

  // --- Chrome headless shell (cached download, no download attempt here) ---
  const legacyChromeDir = join(homedir(), LEGACY.cacheDir, "chrome");
  const chromeDir = existsSync(legacyChromeDir) ? legacyChromeDir : join(homedir(), CACHE_DIR, "chrome");
  const chromePresent = existsSync(chromeDir);
  let chromeVersion: string | undefined;
  if (chromePresent) {
    try {
      const { readdir } = await import("node:fs/promises");
      const browsers = await readdir(chromeDir);
      const vers: string[] = [];
      for (const b of browsers) {
        for (const v of await readdir(join(chromeDir, b)).catch(() => [] as string[])) {
          vers.push(`${b}@${v}`);
        }
      }
      chromeVersion = vers.join(", ") || "present";
    } catch {
      chromeVersion = "present";
    }
  }
  checks.push({
    name: "chrome-headless-shell",
    ok: chromePresent,
    value: chromeVersion ?? "not installed",
    hint: chromePresent
      ? undefined
      : `Will be downloaded on first render, or run any ${ENV_PREFIX}CHROME_PATH install.`,
    required: false, // system Chrome is a valid fallback
  });

  // --- whisper ---
  const whisper = await findWhisperCli();
  checks.push({
    name: "whisper-cli",
    ok: whisper != null,
    value: whisper ?? "not found",
    hint:
      whisper == null
        ? "Install whisper.cpp for `editnce transcribe` (brew install whisper-cpp)."
        : undefined,
    required: false,
  });
  const modelDir = whisperModelDir();
  const presentModels = Object.entries(WHISPER_MODELS)
    .filter(([, m]) => existsSync(join(modelDir, m.file)))
    .map(([k]) => k);
  checks.push({
    name: "whisper models",
    ok: presentModels.length > 0,
    value: presentModels.length ? presentModels.join(", ") : "none downloaded",
    hint: presentModels.length ? undefined : "Downloaded automatically on first `editnce transcribe`.",
    required: false,
  });
  const parakeetReason = sherpaUnsupportedReason();
  const parakeetRuntime = parakeetReason
    ? "unsupported"
    : (await sherpaRuntimeLoadError(10_000)) === null
      ? "ok"
      : "not-loadable";
  const parakeetModel = parakeetReason ? false : await parakeetModelInstalled();
  checks.push({
    name: "parakeet",
    ok: parakeetRuntime === "ok" && parakeetModel,
    value:
      parakeetReason ??
      (parakeetRuntime === "ok"
        ? parakeetModel
          ? "ready"
          : "runtime ok, model not downloaded"
        : `runtime ${parakeetRuntime}`),
    hint:
      parakeetRuntime === "ok" && !parakeetModel
        ? "editnce models install parakeet (downloads ~670MB, or auto-downloads on first transcribe)"
        : undefined,
    required: false,
  });

  // --- system resources ---
  try {
    const s = await statfs(homedir());
    const freeGB = (s.bavail * s.bsize) / 1e9;
    checks.push({
      name: "disk space",
      ok: freeGB > 5,
      value: `${freeGB.toFixed(1)} GB free`,
      hint: freeGB > 5 ? undefined : "Rendering needs several GB of scratch space.",
      required: true,
    });
  } catch {
    checks.push({ name: "disk space", ok: true, value: "unknown", required: true });
  }
  const ramGB = totalmem() / 1e9;
  checks.push({
    name: "memory",
    ok: ramGB >= 8,
    value: `${ramGB.toFixed(0)} GB`,
    hint: ramGB >= 8 ? undefined : "Parallel rendering needs ≥8 GB RAM.",
    required: false,
  });

  // --- write access to cache ---
  // legacy framecraft cache counts too; if neither exists yet, test the home dir
  const legacyCache = join(homedir(), LEGACY.cacheDir);
  const cacheRoot = existsSync(legacyCache) ? legacyCache : join(homedir(), CACHE_DIR);
  let writable = true;
  try {
    await access(existsSync(cacheRoot) ? cacheRoot : homedir(), constants.W_OK);
  } catch {
    writable = false;
  }
  checks.push({
    name: "cache writable",
    ok: writable,
    value: cacheRoot,
    hint: writable ? undefined : `Cannot write to ${cacheRoot} — check permissions.`,
    required: true,
  });

  // --- optional project validity ---
  if (opts?.projectDir) {
    const indexPath = join(opts.projectDir, "index.html");
    checks.push({
      name: "project index.html",
      ok: existsSync(indexPath),
      value: indexPath,
      hint: existsSync(indexPath) ? undefined : "No index.html — run `editnce init` or scaffold.",
      required: false,
    });
  }

  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  return { ok, checks };
}

export function reportDoctor(res: DoctorResult): string {
  const lines = res.checks.map((c) => {
    const icon = c.ok ? "✓" : c.required ? "✖" : "▲";
    const req = c.required ? "" : " (optional)";
    return `${icon} ${c.name}${req}: ${c.value ?? ""}${c.hint ? `\n   → ${c.hint}` : ""}`;
  });
  lines.push(res.ok ? "\n✓ environment ready" : "\n✖ required checks failed");
  return lines.join("\n");
}
