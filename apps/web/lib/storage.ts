import { Storage } from "@google-cloud/storage";

const DEFAULT_BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const WORKER_URL = process.env.DONOVA_WORKER_URL || "https://donova-render-worker-2hsglzbnna-uc.a.run.app";

/** Fetches Google Cloud Run service-to-service IAM ID token via metadata server */
async function getCloudRunIdentityToken(targetUrl: string): Promise<string | null> {
  try {
    const tokenUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(tokenUrl, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      return (await res.text()).trim();
    }
  } catch {
    // Not running inside Google Cloud or metadata server unavailable
  }
  return null;
}

export interface CloudRenderParams {
  bucket?: string;
  bundleKey?: string;
  bundleUrl?: string;
  /** GCS prefix holding an unpacked project tree — used by hosted Studio renders. */
  projectPrefix?: string;
  outputKey: string;
  composition?: string;
  fps?: number;
  quality?: "draft" | "standard" | "high";
}

export interface CloudRenderResponse {
  ok: boolean;
  jobId?: string;
  destination?: string;
  duration?: number;
  frames?: number;
  size?: number;
  error?: string;
}

export async function triggerCloudRender(params: CloudRenderParams): Promise<CloudRenderResponse> {
  const bucket = params.bucket || DEFAULT_BUCKET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const idToken = await getCloudRunIdentityToken(WORKER_URL);
  if (idToken) {
    headers.Authorization = `Bearer ${idToken}`;
  }

  const res = await fetch(`${WORKER_URL}/render`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      bucket,
      bundleKey: params.bundleKey,
      bundleUrl: params.bundleUrl,
      projectPrefix: params.projectPrefix,
      outputKey: params.outputKey,
      composition: params.composition || "index.html",
      fps: params.fps || 30,
      quality: params.quality,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: `Worker error (${res.status}): ${txt}` };
  }

  return (await res.json()) as CloudRenderResponse;
}

export interface CloudRunCmdParams {
  cmd: string;
  args?: Record<string, unknown>;
  projectPrefix: string;
  bucket?: string;
}

export interface CloudRunCmdResponse {
  ok: boolean;
  cmd: string;
  data?: unknown;
  filesWritten?: string[];
  error?: string;
}

/** The cloud agent's media verbs — POST /run on the render worker. */
export async function triggerCloudRun(params: CloudRunCmdParams): Promise<CloudRunCmdResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const idToken = await getCloudRunIdentityToken(WORKER_URL);
  if (idToken) headers.Authorization = `Bearer ${idToken}`;

  const res = await fetch(`${WORKER_URL}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      cmd: params.cmd,
      args: params.args ?? {},
      projectPrefix: params.projectPrefix,
      bucket: params.bucket ?? DEFAULT_BUCKET,
    }),
  });
  const body = (await res.json().catch(() => null)) as CloudRunCmdResponse | null;
  if (!res.ok || !body) {
    return { ok: false, cmd: params.cmd, error: body?.error ?? `Worker error (${res.status})` };
  }
  return body;
}
