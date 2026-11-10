import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `donova add <block>` — install a registry block into the project's
 * compositions/ dir as editable source (11 §install).
 */
export async function addBlock(projectDir: string, name: string): Promise<{ dest: string; files: string[] }> {
  const dir = resolve(projectDir);
  const regRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../registry");
  const catalog = JSON.parse(await readFile(join(regRoot, "catalog.json"), "utf8")) as {
    items: Array<{ name: string; path: string; type?: string }>;
  };
  const catalogEntry = catalog.items.find((i) => i.name === name);
  const blockDir = join(regRoot, catalogEntry?.path ?? `blocks/${name}`);
  if (!catalogEntry && !existsSync(blockDir)) {
    throw new Error(
      `block "${name}" not in registry. Available: ${catalog.items.map((i) => i.name).join(", ")}`,
    );
  }

  if (catalogEntry?.type === "sfx") {
    const sfxDir = join(regRoot, catalogEntry.path);
    const dest = join(dir, "media", "sfx", name);
    await mkdir(dest, { recursive: true });
    const copied: string[] = [];
    for (const f of await readdir(sfxDir)) {
      if (!/\.(wav|mp3|m4a|ogg)$/.test(f)) continue;
      await cp(join(sfxDir, f), join(dest, f));
      copied.push(join("media", "sfx", name, f));
    }
    return { dest, files: copied };
  }

  const meta = JSON.parse(await readFile(join(blockDir, "block.json"), "utf8")) as { files?: string[] };
  const dest = join(dir, "compositions", name);
  await mkdir(dest, { recursive: true });
  const copied: string[] = [];
  for (const f of meta.files ?? (await readdir(blockDir))) {
    if (f === "block.json") continue;
    await cp(join(blockDir, f), join(dest, f), { recursive: true });
    copied.push(join("compositions", name, f));
  }
  return { dest, files: copied };
}
