import { Storage } from "@google-cloud/storage";

const DEFAULT_BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const WORKER_URL =
  process.env.DONOVA_WORKER_URL || "https://donova-render-worker-2hsglzbnna-uc.a.run.app";

let gcsInstance: Storage | null = null;
function getStorage(): Storage {
  if (!gcsInstance) {
    gcsInstance = new Storage();
  }
  return gcsInstance;
}

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
  outputKey: string;
  composition?: string;
  fps?: number;
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

export async function triggerCloudRender(
  params: CloudRenderParams,
): Promise<CloudRenderResponse> {
  const bucket = params.bucket || DEFAULT_BUCKET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const idToken = await getCloudRunIdentityToken(WORKER_URL);
  if (idToken) {
    headers["Authorization"] = `Bearer ${idToken}`;
  }

  const res = await fetch(`${WORKER_URL}/render`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      bucket,
      bundleKey: params.bundleKey,
      bundleUrl: params.bundleUrl,
      outputKey: params.outputKey,
      composition: params.composition || "index.html",
      fps: params.fps || 30,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: `Worker error (${res.status}): ${txt}` };
  }

  return (await res.json()) as CloudRenderResponse;
}
