import { cpSync, existsSync, readdirSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, ERR } from "./errors.js";

/**
 * `donova skills update [dir]` — install Donova's skill set into the
 * agent skill directories of a project (17 §6.3).
 *
 * Writes <dir>/.claude/skills/<name> and <dir>/.agents/skills/<name> for
 * every skills/<name> shipped with the CLI. Idempotent (overwrites in place).
 */
export async function skillsUpdateCmd(opts: {
  dir?: string;
  /** Only these skill names (default: all shipped). */
  only?: string[];
  /** Also install user-global under ~/.claude/skills. */
  global?: boolean;
}): Promise<{ installed: string[]; targets: string[] }> {
  // Resolve the shipped skills dir: packaged layout or repo layout.
  const candidates = [
    fileURLToPath(new URL("../skills", import.meta.url)), // packaged: <pkg>/skills
    fileURLToPath(new URL("../../skills", import.meta.url)), // repo: packages/cli/skills -> repo/skills
    fileURLToPath(new URL("../../../skills", import.meta.url)), // repo from dist/
    fileURLToPath(new URL("../../../../skills", import.meta.url)), // repo from src/
  ];
  const src = candidates.find((d) => existsSync(join(d, "donova", "SKILL.md")));
  if (!src) {
    throw new CliError(ERR.FILE_NOT_FOUND, "shipped skills/ directory not found next to CLI");
  }

  const names = (await readdir(src)).filter((n) => {
    if (!existsSync(join(src, n, "SKILL.md"))) return false;
    return !opts.only?.length || opts.only.includes(n);
  });
  if (!names.length) throw new CliError(ERR.FILE_NOT_FOUND, "no skills found to install");

  const root = resolve(opts.dir ?? ".");
  const targetRoots = [join(root, ".claude", "skills"), join(root, ".agents", "skills")];
  if (opts.global) targetRoots.push(join(homedir(), ".claude", "skills"));

  const targets: string[] = [];
  for (const tr of targetRoots) {
    await mkdir(tr, { recursive: true });
    for (const n of names) {
      cpSync(join(src, n), join(tr, n), { recursive: true });
      targets.push(join(tr, n));
    }
  }
  return { installed: names, targets };
}
