import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `framecraft copy-prompt` — print a ready-made prompt a user can paste into
 * any AI agent (Claude, ChatGPT, Devin) to start a vibe-edit session on this
 * project. Includes the installed skills path, tool commands, and the project
 * layout so the agent can work without discovering anything (MV5).
 */
export async function copyPrompt(opts: { dir: string }): Promise<string> {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  let skillsHint = "";
  try {
    const skillsDir = join(pkgRoot, "../../skills");
    skillsHint = (await readFile(join(skillsDir, "framecraft/SKILL.md"), "utf8")).slice(0, 4000);
  } catch {
    /* skills not shipped in this build — omit */
  }

  return `You are editing a Framecraft project at ${opts.dir}.

Framecraft renders HTML/CSS/JS compositions to video deterministically.
Workflow (vibe edit):
1. Run \`framecraft doctor ${opts.dir} --json\` — fix anything it flags.
2. \`framecraft probe <media> --json\` per footage file; \`framecraft timeline ${opts.dir} --json\` for the current edit state.
3. \`framecraft transcribe <media> --json\` → \`framecraft cuts transcript.json --json\` → \`framecraft scaffold <media> --cuts cuts.json --dir ${opts.dir} --json\` for footage-first edits.
4. \`framecraft captions transcript.json --cuts cuts.json --dir ${opts.dir} --json\` for the caption track.
5. \`framecraft check ${opts.dir} --json\` — MUST pass before render. \`framecraft snapshot ${opts.dir} --times <t1,t2,...>\` to look at frames.
6. Iterate with natural-language feedback; persist durable preferences to ${opts.dir}/style.md (see \`framecraft style\`).

Rules: never modify source footage; no Date.now/Math.random/network in compositions; timed elements use class="clip" + data-start + data-duration; sub-composition blocks live in compositions/ and are referenced via data-composition-src with data-var-* customization; only class="clip" elements cut the render segments.
${skillsHint ? `\n--- installed framecraft skill ---\n${skillsHint}` : ""}`;
}
