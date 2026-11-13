import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { triggerCloudRun } from "./storage";

/**
 * Cloud adapter for the Studio agent — one Agent per user, scoped to their
 * GCS prefix. Text files are materialized to the user's own /tmp mirror for
 * the agent's fs I/O, then changed files are pushed back after each turn/undo.
 */

const TURNS_FILE = ".donova/turns.json";

interface Session {
  agent: Agent | null;
  mutex: Promise<void>;
  synced: boolean;
}

const sessions = new Map<string, Session>();

function sessionFor(uid: string): Session {
  let s = sessions.get(uid);
  if (!s) {
    s = { agent: null, mutex: Promise.resolve(), synced: false };
    sessions.set(uid, s);
  }
  return s;
}

/** Serialize agent ops per user — their /tmp mirror is mutable state. */
function withLock<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const p = s.mutex.then(fn, fn);
  s.mutex = p.then(
    () => {},
    () => {},
  );
  return p;
}

export interface CloudAgent {
  chat(message: string): Promise<Turn>;
  undo(): Promise<{ ok: boolean; restored: string[] }>;
  syncDown(): Promise<void>;
  syncUp(): Promise<void>;
  readonly historyTurns: Turn[];
}

const agents = new Map<string, CloudAgent>();

/** The caller's own agent — uid/prefix from the signed account cookie. */
export function cloudAgent(uid: string, prefix: string): CloudAgent {
  const cached = agents.get(uid);
  if (cached) return cached;

  const s = sessionFor(uid);

  /** Read from the already-materialized local mirror (never re-syncs). */
  async function readLocal(rel: string): Promise<string | null> {
    try {
      return await readFile(join(localRoot(prefix), rel), "utf8");
    } catch {
      return null;
    }
  }

  /** Verbs executed on the render worker (it has ffmpeg + chrome + models). */
  const WORKER_CMDS = new Set(["probe", "transcribe", "cuts", "captions", "scaffold", "add", "snapshot"]);
  // Mirror only holds text files — worker outputs that aren't text never
  // need materializing (the iframe/worker stream binaries from GCS directly).
  const TEXT_EXT = /\.(html?|css|m?js|json|md|txt|svg|xml|ts|tsx|map)$/i;

  /** Pull worker-written outputs into the local mirror (text only). */
  async function pullWritten(rels: string[]): Promise<void> {
    const root = localRoot(prefix);
    for (const rel of rels) {
      if (!TEXT_EXT.test(rel)) continue;
      const content = await readProjectFile(prefix, rel);
      if (content == null) continue;
      const fp = join(root, rel);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, content);
    }
  }

  /** Commands the agent can run server-side in the cloud container. */
  async function cloudRunCmd(
    cmd: string,
    _args: Record<string, unknown>,
    ctx?: { changed?: string[] },
  ): Promise<unknown> {
    if (cmd === "check") {
      const html = (await readLocal("index.html")) ?? "";
      const { issues } = lintHtml(html, { path: "index.html", isRoot: true });
      const errors = issues.filter((i) => i.severity === "error");
      const warnings = issues.filter((i) => i.severity === "warn");
      return { ok: errors.length === 0, errors, warnings };
    }
    if (cmd === "timeline") {
      const html = (await readLocal("index.html")) ?? "";
      const { spec } = parseCompositionHtml(html, { path: "index.html", isRoot: true });
      return { duration: spec.duration, clips: spec.clips.length };
    }
    // Worker-side verbs read GCS, not the mirror — flush this turn's local
    // writes first or they operate on stale files (e.g. captions after edits).
    if (ctx?.changed?.length) await syncUpFiles(ctx.changed);
    if (cmd === "render" || cmd === "renderDraft") {
      const job = await startRenderJob({
        quality: cmd === "renderDraft" ? "draft" : "standard",
        prefix,
        owner: uid,
      });
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const j = await getJob(job.id);
        if (j?.status === "done") return { out: j.out, frames: j.progress?.[1] };
        if (j?.status === "error") throw new Error(j.error ?? "cloud render failed");
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("cloud render timed out");
    }
    if (WORKER_CMDS.has(cmd)) {
      const res = await triggerCloudRun({ cmd, args: _args, projectPrefix: prefix });
      if (!res.ok) throw new Error(res.error ?? `${cmd} failed on worker`);
      await pullWritten(res.filesWritten ?? []);
      return res.data;
    }
    throw new Error(`unknown command: ${cmd}`);
  }

  async function buildAgent(): Promise<Agent> {
    const root = await materializeProject(prefix);
    const a = new Agent(root, {
      runCmd: cloudRunCmd,
      mutateHtml: async (mutations) => {
        const fp = join(root, "index.html");
        const out = await applyMutation(await readFile(fp, "utf8"), mutations);
        await writeFile(fp, out);
      },
      readContext: async () => {
        const indexHtml = (await readProjectFile(prefix, "index.html")) ?? "";
        let duration = 0;
        try {
          duration = parseCompositionHtml(indexHtml, { path: "index.html", isRoot: true }).spec.duration;
        } catch {
          /* leave 0 */
        }
        return {
          indexHtml,
          styleMd: await readProjectFile(prefix, "style.md"),
          files: await listProjectFiles(prefix),
          duration,
        };
      },
    });
    await a.load();
    return a;
  }

  /** Push agent-mutated files + turn history back to GCS. */
  async function syncUpFiles(files?: string[]): Promise<void> {
    const rels = new Set(files ?? []);
    rels.add(TURNS_FILE);
    const root = localRoot(prefix);
    for (const rel of rels) {
      const stream = localStream(root, rel);
      if (stream) {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
        await writeProjectFile(prefix, rel, Buffer.concat(chunks));
      } else if (await projectFileExists(prefix, rel)) {
        await deleteProjectFile(prefix, rel);
      }
    }
  }

  const cloud: CloudAgent = {
    async chat(message: string) {
      return withLock(s, async () => {
        await ensureProjectSeeded(prefix);
        s.agent = await buildAgent();
        s.synced = true;
        const turn = await s.agent.chat(message);
        await syncUpFiles(turn.changes.map((c) => c.file));
        return turn;
      });
    },
    async undo() {
      return withLock(s, async () => {
        await ensureProjectSeeded(prefix);
        s.agent = await buildAgent();
        s.synced = true;
        const result = await s.agent.undo();
        await syncUpFiles(result.restored);
        return result;
      });
    },
    async syncDown() {
      return withLock(s, async () => {
        await ensureProjectSeeded(prefix);
        s.agent = await buildAgent();
        s.synced = true;
      });
    },
    async syncUp() {
      return withLock(s, async () => {
        if (!s.synced) return;
        await syncUpFiles();
      });
    },
    get historyTurns() {
      return s.agent?.historyTurns ?? [];
    },
  };
  agents.set(uid, cloud);
  return cloud;
}
