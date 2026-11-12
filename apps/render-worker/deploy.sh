#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
REPO="${3:-donova-images}"
IMAGE_NAME="render-worker"

if [ -z "$PROJECT_ID" ]; then
  echo "Usage: $0 <PROJECT_ID> [REGION] [REPO_NAME]"
  echo "Example: $0 donova-cloud-12345 us-central1 donova-images"
  exit 1
fi

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}:latest"

echo "======================================================"
echo " Donova Render Worker — Google Cloud Run Deploy"
echo " Project:  ${PROJECT_ID}"
echo " Region:   ${REGION}"
echo " Image:    ${IMAGE_TAG}"
echo "======================================================"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "Step 1/3: Submitting Docker build to Google Cloud Build (E2_HIGHCPU_8)..."
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --config=apps/render-worker/cloudbuild.yaml \
  --substitutions=_IMAGE_TAG="${IMAGE_TAG}" \
  .

echo "Step 2/3: Deploying Cloud Run Service (donova-render-worker)..."
gcloud run deploy donova-render-worker \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_TAG}" \
  --cpu=2 \
  --memory=4Gi \
  --timeout=3600 \
  --concurrency=1 \
  --set-env-vars="DONOVA_BUCKET=${DONOVA_BUCKET:-donova-renders-${PROJECT_ID}}" \
  --no-allow-unauthenticated

echo "Step 3/3: Creating/Updating Cloud Run Job (donova-render-job)..."
if gcloud run jobs describe donova-render-job --project="${PROJECT_ID}" --region="${REGION}" >/dev/null 2>&1; then
  gcloud run jobs update donova-render-job \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${IMAGE_TAG}" \
    --cpu=4 \
    --memory=8Gi \
    --task-timeout=86400
else
  gcloud run jobs create donova-render-job \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${IMAGE_TAG}" \
    --cpu=4 \
    --memory=8Gi \
    --task-timeout=86400
fi

echo
echo "✓ Done! Cloud Run service & job are deployed and ready."
SERVICE_URL=$(gcloud run services describe donova-render-worker --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)
echo "Service URL: ${SERVICE_URL}"
