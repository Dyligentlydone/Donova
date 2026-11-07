import { addBlock } from "./add.js";
import { captionsCmd } from "./captions.js";
import { checkProject } from "./check.js";
import { cutsCmd } from "./cuts.js";
import { doctor } from "./doctor.js";
import { probeCmd, timelineCmd } from "./inspect.js";
import { scaffoldCmd } from "./scaffold.js";
import { snapshotTimes } from "./snapshot.js";
import { styleCmd } from "./style.js";
import { transcribeCmd } from "./transcribe.js";

/**
 * `framecraft mcp` — a minimal MCP server over stdio (JSON-RPC 2.0, newline-
 * framed). Exposes the agent toolset so Claude Code, Cursor, or any MCP client
 * can drive Framecraft without shelling out (17 §studio, MV5).
 *
 * Tools mirror the CLI commands; every one returns a JSON text result.
 */

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (a: Record<string, unknown>) => Promise<unknown>;
}

const req = (_name: string, props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { dir: { type: "string", description: "project dir" }, ...props },
  required,
});

const TOOLS: Tool[] = [
  {
    name: "framecraft_check",
    description: "Validate a Framecraft project (contract + runtime errors, layout, contrast)",
    inputSchema: req("framecraft_check", {}, []),
    run: (a) => checkProject((a.dir as string) ?? "."),
  },
  {
    name: "framecraft_probe",
    description: "Probe a media file (codec, duration, dimensions, audio)",
    inputSchema: req("framecraft_probe", { media: { type: "string" } }, ["media"]),
    run: (a) => probeCmd(String(a.media)),
  },
  {
    name: "framecraft_timeline",
    description: "Resolved clip list with computed timings",
    inputSchema: req("framecraft_timeline", {}, []),
    run: (a) => timelineCmd((a.dir as string) ?? "."),
  },
  {
    name: "framecraft_snapshot",
    description: "Capture PNG frames at given times (visual verification)",
    inputSchema: req(
      "framecraft_snapshot",
      { times: { type: "array", items: { type: "number" } }, out: { type: "string" } },
      ["times"],
    ),
    run: (a) =>
      snapshotTimes(
        (a.dir as string) ?? ".",
        "index.html",
        a.times as number[],
        (a.out as string) ?? "snaps",
      ),
  },
  {
    name: "framecraft_transcribe",
    description: "Whisper transcription with word timings (downloads model on first use)",
    inputSchema: req(
      "framecraft_transcribe",
      {
        media: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
        prompt: { type: "string" },
        engine: { type: "string" },
        language: { type: "string" },
      },
      ["media"],
    ),
    run: (a) =>
      transcribeCmd({
        media: String(a.media),
        out: (a.out as string) ?? "transcript.json",
        model: (a.model as string) ?? "large-v3-turbo",
        prompt: a.prompt as string | undefined,
        engine: (a.engine as "auto" | "parakeet" | "whisper" | undefined) ?? "auto",
        language: a.language as string | undefined,
      }),
  },
  {
    name: "framecraft_cuts",
    description: "Transcript → dead-air cut plan",
    inputSchema: req(
      "framecraft_cuts",
      {
        transcript: { type: "string" },
        threshold: { type: "number" },
        pad: { type: "number" },
        out: { type: "string" },
      },
      ["transcript"],
    ),
    run: (a) =>
      cutsCmd({
        transcript: String(a.transcript),
        threshold: (a.threshold as number) ?? 0.35,
        pad: (a.pad as number) ?? 0.06,
        out: (a.out as string) ?? "cuts.json",
      }),
  },
  {
    name: "framecraft_scaffold",
    description: "Footage → neutral index.html (optionally applying a cut plan)",
    inputSchema: req(
      "framecraft_scaffold",
      { media: { type: "string" }, cuts: { type: "string" }, transcript: { type: "string" } },
      ["media"],
    ),
    run: (a) =>
      scaffoldCmd({
        media: String(a.media),
        cuts: a.cuts as string | undefined,
        transcript: a.transcript as string | undefined,
        dir: (a.dir as string) ?? ".",
      }),
  },
  {
    name: "framecraft_captions",
    description: "Generate a caption track in index.html from a transcript",
    inputSchema: req(
      "framecraft_captions",
      {
        transcript: { type: "string" },
        cuts: { type: "string" },
        mode: { type: "string", enum: ["word", "phrase"] },
        emphasis: { type: "array", items: { type: "string" } },
      },
      ["transcript"],
    ),
    run: (a) =>
      captionsCmd({
        dir: (a.dir as string) ?? ".",
        transcript: String(a.transcript),
        cuts: a.cuts as string | undefined,
        mode: (a.mode as "word" | "phrase") ?? "word",
        emphasis: (a.emphasis as string[]) ?? [],
      }),
  },
  {
    name: "framecraft_add",
    description: "Install a registry block or SFX into the project",
    inputSchema: req("framecraft_add", { name: { type: "string" } }, ["name"]),
    run: (a) => addBlock((a.dir as string) ?? ".", String(a.name)),
  },
  {
    name: "framecraft_style",
    description: "Style file ops: init | show | path",
    inputSchema: req("framecraft_style", { action: { type: "string", enum: ["init", "show", "path"] } }, [
      "action",
    ]),
    run: (a) => styleCmd({ action: a.action as "init" | "show" | "path", dir: (a.dir as string) ?? "." }),
  },
  {
    name: "framecraft_doctor",
    description: "Environment check (node, ffmpeg, chrome, disk, model)",
    inputSchema: req("framecraft_doctor", {}, []),
    run: (a) => doctor({ projectDir: a.dir as string | undefined }),
  },
];

/* ------------------------------ stdio loop ------------------------------- */

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}
function err(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    try {
      switch (method) {
        case "initialize":
          ok(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "framecraft", version: "0.1.0" },
          });
          break;
        case "notifications/initialized":
        case "ping":
          if (method === "ping") ok(id, {});
          break;
        case "tools/list":
          ok(id, {
            tools: TOOLS.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
          break;
        case "tools/call": {
          const tool = TOOLS.find((t) => t.name === params?.name);
          if (!tool) {
            err(id, -32602, `unknown tool ${params?.name}`);
            break;
          }
          const result = await tool.run((params?.arguments as Record<string, unknown>) ?? {});
          ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
          break;
        }
        default:
          if (id !== undefined) err(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      err(id, -32603, e instanceof Error ? e.message : String(e));
    }
  }
});
