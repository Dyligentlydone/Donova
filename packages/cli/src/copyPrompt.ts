import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `editnce copy-prompt` — print a ready-made prompt a user can paste into
 * any AI agent (Claude, ChatGPT, Devin) to start a vibe-edit session on this
 * project. Includes the installed skills path, tool commands, and the project
 * layout so the agent can work without discovering anything (MV5).
 */
export async function copyPrompt(opts: { dir: string }): Promise<string> {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  let skillsHint = "";
  try {
    const skillsDir = join(pkgRoot, "../../skills");
    skillsHint = (await readFile(join(skillsDir, "editnce/SKILL.md"), "utf8")).slice(0, 4000);
  } catch {
    /* skills not shipped in this build — omit */
  }

  return `You are editing an Editnce project at ${opts.dir}.

Editnce renders HTML/CSS/JS compositions to video deterministically.
Workflow (vibe edit):
1. Run \`editnce doctor ${opts.dir} --json\` — fix anything it flags.
2. \`editnce probe <media> --json\` per footage file; \`editnce timeline ${opts.dir} --json\` for the current edit state.
3. \`editnce transcribe <media> --json\` → \`editnce cuts transcript.json --json\` → \`editnce scaffold <media> --cuts cuts.json --dir ${opts.dir} --json\` for footage-first edits.
4. \`editnce captions transcript.json --cuts cuts.json --dir ${opts.dir} --json\` for the caption track.
5. \`editnce check ${opts.dir} --json\` — MUST pass before render. \`editnce snapshot ${opts.dir} --times <t1,t2,...>\` to look at frames.
6. Iterate with natural-language feedback; persist durable preferences to ${opts.dir}/style.md (see \`editnce style\`).

Rules: never modify source footage; no Date.now/Math.random/network in compositions; timed elements use class="clip" + data-start + data-duration; media clips carry their own data-start/data-duration/data-media-start + a unique id (e.g. <video id="vid-1" class="clip">); retimed clips write BOTH data-speed and data-playback-rate (editnce + Studio preview each read one); sub-composition blocks live in compositions/ and are referenced via data-composition-src + data-composition-id on the host, with data-var-* customization; only class="clip" elements cut the render segments.
${skillsHint ? `\n--- installed editnce skill ---\n${skillsHint}` : ""}`;
}
