import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  { name: "write_file", description: "Write a project file (index.html, style.md, …). Full content.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "mutate_html", description: "Targeted edits to index.html: [{op:setAttr|setText, domIndex|selector, attr?, value}]", inputSchema: { type: "object", properties: { mutations: { type: "array" } }, required: ["mutations"] } },
  { name: "run", description: "Run a framecraft command: check|snapshot|captions|cuts|scaffold|add|probe|timeline|renderDraft, with args object", inputSchema: { type: "object", properties: { cmd: { type: "string" }, args: { type: "object" } }, required: ["cmd"] } },
  { name: "reply", description: "Final message to the user for this turn", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

function systemPrompt(ctx: AgentContext): string {
  return `You are the Framecraft editing agent inside Studio. The user describes edits in natural language; you make them real by calling tools. Rules:
- Never modify source footage files under media/.
- Composition rules: timed elements use class="clip" + data-start + data-duration; no Date.now/Math.random/network fetch in compositions; one paused root timeline on window.__timelines.
- Blocks live in compositions/<name>/index.html, referenced with data-composition-src on a .clip div and customized via data-var-* attributes. Run "add" first to install a block.
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

async function anthropicTurn(message: string, ctx: AgentContext, history: unknown[]): Promise<ProviderResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.FRAMECRAFT_MODEL ?? "claude-sonnet-4-5",
      max_tokens: 4096,
      system: systemPrompt(ctx),
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      messages: [...history, { role: "user", content: message }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }> };
  const calls: ProviderResult["calls"] = [];
  for (const c of data.content ?? []) {
    if (c.type === "tool_use" && c.name) calls.push({ tool: c.name, input: c.input ?? {} });
    else if (c.type === "text" && c.text) calls.push({ tool: "reply", input: { text: c.text } });
  }
  return { calls };
}

/** Rules fallback — works offline, covers the common vibe-edit verbs. */
async function rulesTurn(message: string, _ctx: AgentContext): Promise<ProviderResult> {
  const m = message.toLowerCase();
  const calls: ProviderResult["calls"] = [];
  const say = (text: string) => calls.push({ tool: "reply", input: { text } });

  if (/\b(transcribe|transcript)\b/.test(m)) {
    const media = _ctx.files.find((f) => f.startsWith("media/") && /\.(mov|mp4|webm|mp3|wav|m4a)$/i.test(f));
    if (media) calls.push({ tool: "run", input: { cmd: "transcribe", args: { media } } });
    say(media ? `Transcribing ${media} → media/transcript.json.` : "No media file found under media/ — import footage first.");
  } else if (/\b(cut|remove)\b.*(dead|pause|silence|air)/.test(m) || /\bdead air\b/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "cuts", args: { transcript: "media/transcript.json" } } });
    say("Computing a dead-air cut plan → cuts.json. Apply with scaffold to rebuild the edit.");
  } else if (/\bcaption/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "captions", args: { transcript: "media/transcript.json", cuts: "cuts.json" } } });
    say("Generating the caption track from the transcript.");
  } else if (/\bcheck|validate\b/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "check" } });
    say("Running contract + runtime check.");
  } else if (/\brender|export\b/.test(m)) {
    calls.push({ tool: "run", input: { cmd: "renderDraft" } });
    say("Starting a draft render.");
  } else if (/\b(card|title|alert|stat|lower.?third|cta|caption.?strip)\b/.test(m)) {
    const block = m.includes("alert") ? "alert-card" : m.includes("stat") ? "stat-card" : m.includes("lower") ? "lower-third" : m.includes("cta") ? "cta" : m.includes("title") ? "title-card" : "card";
    calls.push({ tool: "run", input: { cmd: "add", args: { name: block } } });
    say(`Installed the ${block} block into compositions/${block}/ — wire it with data-composition-src and data-var-* (see compositions/${block}/index.html).`);
  } else {
    say("I can: transcribe footage, cut dead air, generate captions, install blocks (card/alert/stat/lower-third/cta), run check, or render a draft. Tell me what to change.");
  }
  return { calls };
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

  async chat(message: string): Promise<Turn> {
    const ctx = await this.exec.readContext();
    const provider = process.env.ANTHROPIC_API_KEY ? anthropicTurn : rulesTurn;
    const { calls } = await provider(message, ctx, this.history);

    const changes: TurnChange[] = [];
    const toolsUsed: string[] = [];
    const replies: string[] = [];

    for (const call of calls) {
      toolsUsed.push(call.tool);
      if (call.tool === "reply") {
        replies.push(String(call.input.text ?? ""));
      } else if (call.tool === "write_file") {
        const p = String(call.input.path ?? "");
        const content = String(call.input.content ?? "");
        if (p && !p.startsWith("media/") && !p.includes("..")) {
          const before = await this.snapshot(p);
          await writeFile(join(this.root, p), content);
          changes.push({ file: p, before, after: content });
        }
      } else if (call.tool === "mutate_html") {
        const before = await this.snapshot("index.html");
        await this.exec.mutateHtml(call.input.mutations as Array<Record<string, unknown>>);
        const after = await this.snapshot("index.html");
        changes.push({ file: "index.html", before, after });
      } else if (call.tool === "run") {
        const cmd = String(call.input.cmd ?? "");
        const before = await this.snapshot("index.html");
        try {
          await this.exec.runCmd(cmd, (call.input.args as Record<string, unknown>) ?? {});
        } catch (e) {
          replies.push(`(${cmd} failed: ${e instanceof Error ? e.message.split("\n")[0] : e})`);
        }
        const after = await this.snapshot("index.html");
        if (after !== before) changes.push({ file: "index.html", before, after });
      }
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
    const turn = this.turns.pop();
    if (!turn) return { ok: false, restored: [] };
    for (const c of turn.changes) {
      if (c.before == null) continue; // created file — leave it (non-destructive)
      await writeFile(join(this.root, c.file), c.before);
    }
    await this.saveTurns();
    this.history = this.history.slice(0, -2);
    return { ok: true, restored: turn.changes.map((c) => c.file) };
  }

  get historyTurns(): Turn[] {
    return this.turns;
  }
}
