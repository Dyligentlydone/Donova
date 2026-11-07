import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Studio agent (17 §chat / MV6). One chat turn:
 *   user message → provider (Anthropic if ANTHROPIC_API_KEY, else rules
 *   fallback) → tool calls → executed server-side → turn recorded for undo.
 *
 * Tools are the same verbs as the CLI: check, snapshot, captions, cuts,
 * scaffold, add, probe, timeline, renderDraft, writeFile, mutateHtml,
 * updateStyle. Raw footage is never touched.
 */

export interface TurnChange {
  file: string;
  before: string | null; // null = file didn't exist
  after: string | null;
}
export interface Turn {
  id: string;
  at: string;
  message: string;
  reply: string;
  changes: TurnChange[];
  tools: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AgentContext {
  indexHtml: string;
  styleMd: string | null;
  files: string[];
  duration: number;
}

const TOOLS: AgentTool[] = [
  {
    name: "write_file",
    description: "Write a project file (index.html, style.md, …). Full content.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "mutate_html",
    description: "Targeted edits to index.html: [{op:setAttr|setText, domIndex|selector, attr?, value}]",
    inputSchema: { type: "object", properties: { mutations: { type: "array" } }, required: ["mutations"] },
  },
  {
    name: "run",
    description:
      "Run a framecraft command: check|snapshot|captions|cuts|scaffold|add|probe|timeline|renderDraft, with args object",
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string" }, args: { type: "object" } },
      required: ["cmd"],
    },
  },
  {
    name: "reply",
    description: "Final message to the user for this turn",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function systemPrompt(ctx: AgentContext): string {
  return `You are the Framecraft editing agent inside Studio. The user describes edits in natural language; you make them real by calling tools. Rules:
- Never modify source footage files under media/.
- Composition rules: timed elements use class="clip" + data-start + data-duration; no Date.now/Math.random/network fetch in compositions; one paused root timeline on window.__timelines.
- Blocks live in compositions/<name>/index.html, referenced with data-composition-src + data-composition-id on a .clip div and customized via data-var-* attributes. Run "add" first to install a block.
- Durable user preferences ("always", "never", or repeated corrections) go into style.md via write_file — describe them in words, don't restate the whole file.
- Keep replies to the user short: what changed + what to look at.
- Prefer draft renders for iteration.
Project state:
- duration: ${ctx.duration}s
- files: ${ctx.files.join(", ")}
- style.md: ${ctx.styleMd ? `present (${ctx.styleMd.length} chars)` : "absent"}
Current index.html:
${ctx.indexHtml}`;
}

/* ------------------------------ providers -------------------------------- */

type ProviderResult = { calls: Array<{ tool: string; input: Record<string, unknown> }> };

type AnthropicContent = Array<{
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}>;

async function anthropicCall(ctx: AgentContext, messages: unknown[]): Promise<{ content: AnthropicContent }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.FRAMECRAFT_MODEL ?? "claude-sonnet-4-5",
      max_tokens: 4096,
      system: systemPrompt(ctx),
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { content: AnthropicContent };
}

/** Rules fallback — works offline, covers the common vibe-edit verbs. */
async function rulesTurn(message: string, _ctx: AgentContext): Promise<ProviderResult> {
  const m = message.toLowerCase();
  const calls: ProviderResult["calls"] = [];
  const say = (text: string) => calls.push({ tool: "reply", input: { text } });

  const MEDIA_RE = /\.(mov|mp4|webm|mkv|mp3|wav|m4a)$/i;
  const footage = _ctx.files.find(
    (f) => MEDIA_RE.test(f) && !f.startsWith("media/sfx/") && !f.startsWith("media/audio/"),
  );
  const transcript = _ctx.files.find((f) => /(^|\/)transcript\.json$/.test(f)) ?? "transcript.json";
  const cuts = _ctx.files.find((f) => /(^|\/)cuts\.json$/.test(f)) ?? "cuts.json";

  if (/\b(transcribe|transcript)\b/.test(m)) {
    if (footage)
      calls.push({
        tool: "run",
        input: { cmd: "transcribe", args: { media: footage, out: "transcript.json" } },
      });
    say(
      footage
        ? `Transcribing ${footage} → transcript.json.`
        : "No footage found under assets/ or media/ — import footage first.",
    );
  } else if (/\b(cut|remove)\b.*(dead|pause|silence|air)/.test(m) || /\bdead air\b/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "cuts", args: { transcript, out: "cuts.json" } } });
    if (footage)
      calls.push({ tool: "run", input: { cmd: "scaffold", args: { media: footage, cuts: "cuts.json" } } });
    say(
      footage
        ? "Computing a dead-air cut plan and rebuilding the edit."
        : "Computing a dead-air cut plan → cuts.json.",
    );
  } else if (/\bcaption/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "captions", args: { transcript, cuts } } });
    say("Generating the caption track from the transcript.");
  } else if (/\bcheck|validate\b/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "check" } });
    say("Running contract + runtime check.");
  } else if (/\brender|export\b/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "renderDraft" } });
    say("Starting a draft render.");
  } else if (/\b(card|title|alert|stat|lower.?third|cta|caption.?strip)\b/.test(m)) {
    const block = m.includes("alert")
      ? "alert-card"
      : m.includes("stat")
        ? "stat-card"
        : m.includes("lower")
          ? "lower-third"
          : m.includes("cta")
            ? "cta"
            : m.includes("title")
              ? "title-card"
              : "card";
    calls.push({ tool: "run", input: { cmd: "add", args: { name: block } } });
    say(
      `Installed the ${block} block into compositions/${block}/ — wire it with data-composition-src and data-var-* (see compositions/${block}/index.html).`,
    );
  } else {
    say(
      "I can: transcribe footage, cut dead air, generate captions, install blocks (card/alert/stat/lower-third/cta), run check, or render a draft. Tell me what to change.",
    );
  }
  return { calls };
}

/** One-line summary of a run-cmd result, appended to the turn reply. */
function summarize(cmd: string, res: unknown): string {
  const r = (res as Record<string, unknown>) ?? {};
  const d = (r.data as Record<string, unknown>) ?? r;
  if (cmd === "check")
    return `ok=${d.ok}, errors=${(d.errors as unknown[])?.length ?? 0}, warnings=${(d.warnings as unknown[])?.length ?? 0}`;
  if (cmd === "transcribe") return `transcript → ${d.out ?? d.path ?? "transcript.json"}`;
  if (cmd === "cuts")
    return `${d.segments ?? (d.plan as Record<string, unknown>)?.segments ?? "?"} segments kept`;
  if (cmd === "scaffold") return `composition → ${d.path ?? "index.html"} (${d.segments ?? "?"} clips)`;
  if (cmd === "captions") return `${d.captions ?? "?"} captions written`;
  if (cmd === "add")
    return `installed ${d.name ?? ""} → ${(d.files as string[])?.join(", ") ?? d.path ?? ""}`;
  if (cmd === "renderDraft" || cmd === "render") return `rendered → ${d.out ?? d.path ?? "draft.mp4"}`;
  return JSON.stringify(d).slice(0, 160);
}

/* ------------------------------ turn engine ------------------------------ */

export class Agent {
  private turnsFile: string;
  private turns: Turn[] = [];
  private history: unknown[] = [];

  constructor(
    private root: string,
    private exec: {
      runCmd: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
      mutateHtml: (mutations: Array<Record<string, unknown>>) => Promise<void>;
      readContext: () => Promise<AgentContext>;
    },
  ) {
    this.turnsFile = join(root, ".framecraft", "turns.json");
  }

  async load(): Promise<void> {
    if (existsSync(this.turnsFile)) {
      try {
        this.turns = JSON.parse(await readFile(this.turnsFile, "utf8")) as Turn[];
      } catch {
        this.turns = [];
      }
    }
  }

  private async saveTurns(): Promise<void> {
    await mkdir(join(this.root, ".framecraft"), { recursive: true });
    await writeFile(this.turnsFile, JSON.stringify(this.turns, null, 2));
  }

  private async snapshot(path: string): Promise<string | null> {
    const fp = join(this.root, path);
    return existsSync(fp) ? readFile(fp, "utf8") : null;
  }

  /** Execute one provider call, recording changes; returns text for the reply. */
  private async execCall(
    call: { tool: string; input: Record<string, unknown> },
    changes: TurnChange[],
  ): Promise<string> {
    if (call.tool === "reply") return String(call.input.text ?? "");
    if (call.tool === "write_file") {
      const p = String(call.input.path ?? "");
      const content = String(call.input.content ?? "");
      // Never overwrite imported footage/media binaries — raw inputs are sacred.
      const mediaExt = /\.(mov|mp4|webm|mkv|avi|mp3|wav|m4a|ogg|png|jpe?g|webp|heic|aiff?|flac)$/i;
      const protectedPath = p.startsWith("assets/") || p.startsWith("media/") || mediaExt.test(p);
      if (p && !protectedPath && !p.includes("..")) {
        const before = await this.snapshot(p);
        await writeFile(join(this.root, p), content);
        changes.push({ file: p, before, after: content });
        return `(wrote ${p})`;
      }
      return p ? `(write_file to ${p} refused — media/asset files are read-only)` : "";
    }
    if (call.tool === "mutate_html") {
      const before = await this.snapshot("index.html");
      await this.exec.mutateHtml(call.input.mutations as Array<Record<string, unknown>>);
      const after = await this.snapshot("index.html");
      changes.push({ file: "index.html", before, after });
      return "(mutated index.html)";
    }
    if (call.tool === "run") {
      const cmd = String(call.input.cmd ?? "");
      const before = await this.snapshot("index.html");
      const notes: string[] = [];
      try {
        const res = await this.exec.runCmd(cmd, (call.input.args as Record<string, unknown>) ?? {});
        notes.push(`(${cmd}: ${summarize(cmd, res)})`);
        // After installing a block, wire a reference clip into index.html so
        // the user sees it immediately instead of an invisible install.
        if (cmd === "add") {
          const name = String((call.input.args as Record<string, unknown>)?.name ?? "");
          const idxPath = join(this.root, "index.html");
          if (name && existsSync(idxPath)) {
            const html = await readFile(idxPath, "utf8");
            const ref = `compositions/${name}/index.html`;
            if (!html.includes(ref)) {
              const rootClose = html.lastIndexOf("</div>");
              if (rootClose >= 0) {
                const clip = `\n  <div id="${name}-auto" class="clip" data-composition-id="${name}-auto" data-start="0" data-duration="3" data-composition-src="${ref}"></div>\n`;
                await writeFile(idxPath, html.slice(0, rootClose) + clip + html.slice(rootClose));
                notes.push(`(added a ${name} clip at 0s — retime/move it as needed)`);
              }
            }
          }
        }
      } catch (e) {
        notes.push(`(${cmd} failed: ${e instanceof Error ? e.message.split("\n")[0] : e})`);
      }
      const after = await this.snapshot("index.html");
      if (after !== before) changes.push({ file: "index.html", before, after });
      return notes.join(" ");
    }
    return "";
  }

  async chat(message: string): Promise<Turn> {
    const ctx = await this.exec.readContext();
    const changes: TurnChange[] = [];
    const toolsUsed: string[] = [];
    const replies: string[] = [];
    const runCall = async (call: { tool: string; input: Record<string, unknown> }) => {
      toolsUsed.push(call.tool);
      const note = await this.execCall(call, changes);
      if (note) replies.push(note);
      return note;
    };

    if (process.env.ANTHROPIC_API_KEY) {
      // Real tool loop: model gets tool results back and can keep going.
      const messages: unknown[] = [...this.history, { role: "user", content: message }];
      for (let round = 0; round < 8; round++) {
        const data = await anthropicCall(ctx, messages);
        const textParts: string[] = [];
        const toolUses: Array<{ id?: string; name?: string; input?: Record<string, unknown> }> = [];
        for (const c of data.content ?? []) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "tool_use") toolUses.push(c);
        }
        if (textParts.length) replies.push(textParts.join(" "));
        if (!toolUses.length) break;
        messages.push({ role: "assistant", content: data.content });
        const results: unknown[] = [];
        for (const tu of toolUses) {
          const note = await runCall({ tool: String(tu.name ?? "reply"), input: tu.input ?? {} });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: note || "done" });
        }
        messages.push({ role: "user", content: results });
      }
    } else {
      const { calls } = await rulesTurn(message, ctx);
      for (const call of calls) await runCall(call);
    }

    const turn: Turn = {
      id: `turn-${this.turns.length + 1}`,
      at: new Date().toISOString(),
      message,
      reply: replies.join(" ") || "Done.",
      changes,
      tools: toolsUsed,
    };
    this.turns.push(turn);
    await this.saveTurns();
    this.history.push({ role: "user", content: message }, { role: "assistant", content: turn.reply });
    this.history = this.history.slice(-20);
    return turn;
  }

  async undo(): Promise<{ ok: boolean; restored: string[] }> {
    // Undo the last turn that actually changed files — a chat-only turn has
    // nothing to undo and shouldn't consume the user's undo.
    const idx = this.turns.map((t) => t.changes.length > 0).lastIndexOf(true);
    if (idx < 0) return { ok: false, restored: [] };
    const [turn] = this.turns.splice(idx, 1);
    if (!turn) return { ok: false, restored: [] };
    for (const c of turn.changes) {
      const fp = join(this.root, c.file);
      if (c.before == null) {
        await unlink(fp).catch(() => {}); // file created by the turn — remove it
      } else {
        await writeFile(fp, c.before);
      }
    }
    await this.saveTurns();
    this.history = this.history.slice(0, -2);
    return { ok: true, restored: turn.changes.map((c) => c.file) };
  }

  get historyTurns(): Turn[] {
    return this.turns;
  }
}
