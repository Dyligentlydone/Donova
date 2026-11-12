import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCompositionHtml } from "@donova/contract";
import { lintHtml } from "@donova/lint";
import { Agent, type Turn } from "@donova/studio-server/agent";
import { getJob, startRenderJob } from "./jobs";
import { applyMutation } from "./mutation";
import {
  deleteProjectFile,
  ensureProjectSeeded,
  listProjectFiles,
  localRoot,
  localStream,
  materializeProject,
  projectFileExists,
  readProjectFile,
  writeProjectFile,
} from "./project";

/**
 * Cloud adapter for the Studio agent. Same Agent class as the local server,
 * but project state lives in GCS: text files are materialized to /tmp for the
 * agent's fs I/O, then changed files are pushed back after each turn/undo.
 */

const TURNS_FILE = ".donova/turns.json";

let agent: Agent | null = null;
let mutex: Promise<void> = Promise.resolve();
let synced = false;

/** Serialize agent ops — the /tmp mirror is shared mutable state. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = mutex.then(fn, fn);
  mutex = p.then(
    () => {},
    () => {},
  );
  return p;
}

/** Read from the already-materialized local mirror (never re-syncs). */
async function readLocal(rel: string): Promise<string | null> {
  try {
    return await readFile(join(localRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

/** Commands the agent can run server-side in the cloud container. */
async function cloudRunCmd(cmd: string, _args: Record<string, unknown>): Promise<unknown> {
  if (cmd === "check") {
    const html = (await readLocal("index.html")) ?? "";
    const { issues } = lintHtml(html, { path: "index.html", isRoot: true });
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warn");
    return { ok: errors.length === 0, errors, warnings };
  }
  if (cmd === "render" || cmd === "renderDraft") {
    const job = await startRenderJob({ quality: cmd === "renderDraft" ? "draft" : "standard" });
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const j = await getJob(job.id);
      if (j?.status === "done") return { out: j.out, frames: j.progress?.[1] };
      if (j?.status === "error") throw new Error(j.error ?? "cloud render failed");
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("cloud render timed out");
  }
  if (cmd === "timeline") {
    const html = (await readLocal("index.html")) ?? "";
    const { spec } = parseCompositionHtml(html, { path: "index.html", isRoot: true });
    return { duration: spec.duration, clips: spec.clips.length };
  }
  // Media-processing commands (transcribe, cuts, captions, scaffold, probe,
  // snapshot, add) need the CLI toolchain — run locally via `donova <cmd>`.
  throw new Error(`${cmd} is not available in Donova Cloud yet — run it locally via \`donova ${cmd}\``);
}

async function buildAgent(): Promise<Agent> {
  const root = await materializeProject();
  const a = new Agent(root, {
    runCmd: cloudRunCmd,
    mutateHtml: async (mutations) => {
      const fp = join(root, "index.html");
      const out = await applyMutation(await readFile(fp, "utf8"), mutations);
      await writeFile(fp, out);
    },
    readContext: async () => {
      const indexHtml = (await readProjectFile("index.html")) ?? "";
      let duration = 0;
      try {
        duration = parseCompositionHtml(indexHtml, { path: "index.html", isRoot: true }).spec.duration;
      } catch {
        /* leave 0 */
      }
      return {
        indexHtml,
        styleMd: await readProjectFile("style.md"),
        files: await listProjectFiles(),
        duration,
      };
    },
  });
  await a.load();
  return a;
}

export interface CloudAgent {
  chat(message: string): Promise<Turn>;
  undo(): Promise<{ ok: boolean; restored: string[] }>;
  syncDown(): Promise<void>;
  syncUp(): Promise<void>;
  readonly historyTurns: Turn[];
}

/** Push agent-mutated files + turn history back to GCS. */
async function syncUp(files?: string[]): Promise<void> {
  const rels = new Set(files ?? []);
  rels.add(TURNS_FILE);
  for (const rel of rels) {
    const stream = localStream(rel);
    if (stream) {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
      await writeProjectFile(rel, Buffer.concat(chunks));
    } else if (await projectFileExists(rel)) {
      await deleteProjectFile(rel);
    }
  }
}

let cloud: CloudAgent | null = null;

export function cloudAgent(): CloudAgent {
  if (cloud) return cloud;
  cloud = {
    async chat(message: string) {
      return withLock(async () => {
        await ensureProjectSeeded();
        agent = await buildAgent();
        synced = true;
        const turn = await agent.chat(message);
        await syncUp(turn.changes.map((c) => c.file));
        return turn;
      });
    },
    async undo() {
      return withLock(async () => {
        await ensureProjectSeeded();
        agent = await buildAgent();
        synced = true;
        const result = await agent.undo();
        await syncUp(result.restored);
        return result;
      });
    },
    async syncDown() {
      return withLock(async () => {
        await ensureProjectSeeded();
        agent = await buildAgent();
        synced = true;
      });
    },
    async syncUp() {
      return withLock(async () => {
        if (!synced) return;
        await syncUp();
      });
    },
    get historyTurns() {
      return agent?.historyTurns ?? [];
    },
  };
  return cloud;
}
