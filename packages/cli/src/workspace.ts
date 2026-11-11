import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initProject } from "./init.js";

const STYLE_MD = `# Style

Your editing style — the agent fills this in from your inspo/ and reads it
before every edit. Edit it yourself anytime to steer.

- vibe:
- colors:
- fonts:
- captions:
- pacing:
- music:

inspo/: drop clips or screenshots of videos whose style you want.
Ask the agent to "learn my style" — it studies inspo/ and writes this file.
`;

function readMe(ws: string): string {
  const project = join(ws, "02 Projects", "my-first-edit");
  return `DONOVA STUDIO — your editing workspace

01 Style Guide    1. drop clips/screenshots of styles you like into inspo/
                  2. ask the agent to "learn my style" — it writes style.md
                  3. from then on, every edit follows that style

02 Projects       the everyday loop:
                    raw footage/    drop a clip you want edited
                    donova videos/  the finished video lands here
                    my-first-edit/  the project Studio has open

So: teach the style once with inspo — then it's just
drop a clip → get a donova video back.

Tip: flip "auto" (top bar in Studio, left of Export) and clips dropped in
raw footage edit themselves in the background — no Studio needed.

Reopen Studio anytime, from a terminal:
  cd "${project}"
  donova studio
`;
}

/**
 * \`donova setup\` — build the "Donova Studio" workspace (style guide, inspo,
 * shared footage/exports pools, starter project). Cross-platform twin of the
 * macOS installer's workspace step; never overwrites existing files.
 */
export async function setupWorkspace(dir?: string): Promise<{ workspace: string; project: string }> {
  const ws = resolve(dir ?? join(homedir(), "Downloads", "Donova Studio"));
  const projects = join(ws, "02 Projects");
  for (const d of [join(ws, "01 Style Guide", "inspo"), join(projects, "raw footage"), join(projects, "donova videos")])
    await mkdir(d, { recursive: true });
  const write = async (path: string, body: string) => {
    if (!existsSync(path)) await writeFile(path, body);
  };
  await write(join(ws, "01 Style Guide", "style.md"), STYLE_MD);
  await write(join(ws, "READ ME.txt"), readMe(ws));
  const project = join(projects, "my-first-edit");
  if (!existsSync(project)) await initProject(project, { name: "my-first-edit" });
  return { workspace: ws, project };
}
