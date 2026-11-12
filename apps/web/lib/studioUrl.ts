/**
 * URL of the dedicated Studio Cloud Run service (real rebranded Studio —
 * `donova studio` → hyperframes preview backed by a GCS-synced project tree).
 * The web app's own /studio page is the legacy single-file editor; Studio
 * links should send users here. Same-origin "/studio" fallback keeps local
 * `next dev` usable without the service.
 */
export const STUDIO_URL =
  process.env.NEXT_PUBLIC_STUDIO_URL ??
  "https://donova-studio-712078215622.us-central1.run.app";
