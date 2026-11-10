import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, ERR } from "./errors.js";

/**
 * `editnce style` — the user-owned style.md (17 §5).
 *
 * Resolution order (first hit wins):
 *   1. <project>/style.md
 *   2. <project>/STYLE.md
 *   3. ~/.config/editnce/style.md  (user-global)
 * The app ships NO default style — the file belongs to the user.
 */

export function globalStylePath(): string {
  return join(homedir(), ".config", "editnce", "style.md");
}

export function resolveStylePath(projectDir?: string): string | null {
  if (projectDir) {
    for (const name of ["style.md", "STYLE.md"]) {
      const p = join(resolve(projectDir), name);
      if (existsSync(p)) return p;
    }
  }
  const g = globalStylePath();
  return existsSync(g) ? g : null;
}

const STARTER = `# Style guide

Describe your editing style in your own words. The agent reads this file
before every edit and updates it when you give feedback like "always X" or
"never Y".

## Look
<!-- colors, grade, fonts, mood -->

## Captions
<!-- style, position, casing, emphasis -->

## Pacing
<!-- cuts, zooms, transitions -->

## Sound
<!-- music, sfx, ducking -->
`;

export async function styleCmd(opts: {
  action: "init" | "show" | "path";
  dir?: string;
  global?: boolean;
}): Promise<{ path: string | null; content?: string; created?: boolean }> {
  if (opts.action === "init") {
    const target = opts.global ? globalStylePath() : join(resolve(opts.dir ?? "."), "style.md");
    if (existsSync(target)) return { path: target, created: false };
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, STARTER);
    return { path: target, created: true };
  }
  const p = resolveStylePath(opts.dir);
  if (opts.action === "path") return { path: p };
  // show
  if (!p) {
    throw new CliError(
      ERR.FILE_NOT_FOUND,
      "no style.md found",
      `Run \`editnce style init\` in your project, or write one at ${globalStylePath()}`,
    );
  }
  return { path: p, content: await readFile(p, "utf8") };
}
