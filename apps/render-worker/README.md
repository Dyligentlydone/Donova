# Donova Cloud Render Worker

Headless, deterministic render worker container for **Google Cloud Run** and **Google Cloud Run Jobs**.

## Architecture

- **Base**: Debian Bookworm slim + Node 22 + pinned FFmpeg + Google Chrome headless shell + Linux emoji & multilingual fonts.
- **Engines**: `@donova/producer` + Puppeteer CDP `HeadlessExperimental.beginFrame` capture.
- **I/O**: Google Cloud Storage (`@google-cloud/storage`) or presigned HTTP URLs.
- **Execution Modes**:
  1. **HTTP Service** (`Cloud Run`): Listens on `$PORT` (default 8080). Responds to `POST /render`.
  2. **Batch Job** (`Cloud Run Jobs`): Triggered via CLI `--job` or `--bundleKey=...` to render long videos (up to 24h per job).

---

## API Endpoints (Service Mode)

### `GET /health`
Returns service status:
```json
{
  "status": "ok",
  "service": "donova-render-worker",
  "version": "0.1.0",
  "time": "2026-11-12T00:43:54.707Z"
}
```

### `POST /render`
Renders a project bundle and uploads the output video to GCS.

**Request Body (GCS Native)**:
```json
{
  "bucket": "my-donova-renders",
  "bundleKey": "projects/proj_abc123/bundle.zip",
  "outputKey": "projects/proj_abc123/renders/video.mp4",
  "composition": "index.html",
  "fps": 30,
  "quality": "standard"
}
```

**Request Body (Presigned URLs / Webhook Mode)**:
```json
{
  "bundleUrl": "https://storage.googleapis.com/.../bundle.zip?X-Goog-Signature=...",
  "uploadUrl": "https://storage.googleapis.com/.../video.mp4?X-Goog-Signature=...",
  "composition": "index.html",
  "fps": 30
}
```

**Success Response**:
```json
{
  "ok": true,
  "jobId": "job_1731372200_abc123",
  "destination": "gs://my-donova-renders/projects/proj_abc123/renders/video.mp4",
  "size": 4210982,
  "frames": 900,
  "fps": 30,
  "duration": 30.0,
  "width": 1080,
  "height": 1920,
  "totalTimeMs": 14200
}
```

---

## Deployment to Google Cloud

### Prerequisites
- Project created with Cloud Run, Cloud Build, and Artifact Registry enabled.
- Artifact Registry repo `donova-images` created in your chosen region (e.g. `us-central1`).

### 1. Build and push image with Google Cloud Build
Run from the root of the monorepo:
```bash
PROJECT_ID="YOUR_PROJECT_ID"
REGION="us-central1"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/donova-images/render-worker:latest"

gcloud builds submit --project="${PROJECT_ID}" --tag="${IMAGE}" -f apps/render-worker/Dockerfile .
```

### 2. Deploy as a Cloud Run Service
```bash
gcloud run deploy donova-render-worker \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --cpu=2 \
  --memory=4Gi \
  --timeout=3600 \
  --concurrency=1 \
  --no-allow-unauthenticated
```

### 3. (Optional) Deploy as a Cloud Run Job (Batch/Long-running)
```bash
gcloud run jobs create donova-render-job \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --cpu=4 \
  --memory=8Gi \
  --task-timeout=86400
```
