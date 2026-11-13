import { Storage } from "@google-cloud/storage";
import { signedReadUrl } from "./project";
import { triggerCloudRender } from "./storage";

/**
 * Render job tracking. In-memory for live status; a small JSON record is
 * written to GCS on completion so polls survive instance changes.
 */

const BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const PROJECT_PREFIX = process.env.DONOVA_PROJECT_PREFIX || "projects/default/";

export interface Job {
  id: string;
  status: "queued" | "rendering" | "done" | "error";
  out?: string;
  error?: string;
  outputKey?: string;
  progress?: [number, number];
}

const jobs = new Map<string, Job>();

let storage: Storage | null = null;
function gcs(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

export async function startRenderJob(opts: {
  composition?: string;
  fps?: number;
  quality?: "draft" | "standard" | "high";
  /** Per-user project prefix — defaults to the shared tree. */
  prefix?: string;
}): Promise<Job> {
  const prefix = opts.prefix || PROJECT_PREFIX;
  const id = `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const outputKey = `${prefix}donova videos/${id}.mp4`;
  const job: Job = { id, status: "queued", outputKey };
  jobs.set(id, job);

  void (async () => {
    job.status = "rendering";
    try {
      const res = await triggerCloudRender({
        projectPrefix: prefix,
        outputKey,
        composition: opts.composition || "index.html",
        fps: opts.fps,
        quality: opts.quality,
      });
      if (!res.ok) throw new Error(res.error ?? "render worker failed");
      job.status = "done";
      job.out = await signedReadUrl(outputKey, 60 * 60 * 1000);
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    }
    try {
      await gcs()
        .bucket(BUCKET)
        .file(`renders/jobs/${id}.json`)
        .save(JSON.stringify({ status: job.status, outputKey, error: job.error }));
    } catch {
      /* non-fatal: in-memory status still available on this instance */
    }
  })();

  return job;
}

export async function getJob(id: string): Promise<Job | null> {
  const live = jobs.get(id);
  if (live) return live;
  // Fall back to the GCS record written at completion (other instances).
  const [buf] = await gcs()
    .bucket(BUCKET)
    .file(`renders/jobs/${id}.json`)
    .download()
    .catch(() => [null]);
  if (!buf) return null;
  const rec = JSON.parse(buf.toString("utf8")) as {
    status: Job["status"];
    outputKey?: string;
    error?: string;
  };
  return {
    id,
    status: rec.status,
    outputKey: rec.outputKey,
    error: rec.error,
    out: rec.outputKey ? await signedReadUrl(rec.outputKey, 60 * 60 * 1000) : undefined,
  };
}
