#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-donova-514500}"
REGION="${2:-us-central1}"
REPO="${3:-donova-images}"
IMAGE_NAME="studio-service"
SERVICE_NAME="donova-studio"

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}:latest"

echo "======================================================"
echo " Donova Studio — Google Cloud Run Deploy"
echo " Project:  ${PROJECT_ID}"
echo " Region:   ${REGION}"
echo " Image:    ${IMAGE_TAG}"
echo "======================================================"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "Step 1/2: Submitting Docker build to Google Cloud Build (E2_HIGHCPU_8)..."
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --config=apps/studio-service/cloudbuild.yaml \
  --substitutions=_IMAGE_TAG="${IMAGE_TAG}" \
  .

echo "Step 2/2: Deploying Cloud Run Service (${SERVICE_NAME})..."
# max-instances=1: all edits land in ONE synced project tree — a second
# instance would fork project state. min-instances=1 avoids the cold
# materialize + preview boot per visit.
# STUDIO_GATE_SECRET — shared HMAC secret with the web app (env, not committed)
ENV_VARS="DONOVA_BUCKET=${DONOVA_BUCKET:-donova-renders-${PROJECT_ID}},PROJECT_PREFIX=${PROJECT_PREFIX:-projects/default/}"
[ -n "${STUDIO_GATE_SECRET:-}" ] && ENV_VARS="${ENV_VARS},STUDIO_GATE_SECRET=${STUDIO_GATE_SECRET}"

gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_TAG}" \
  --cpu=4 \
  --memory=8Gi \
  --timeout=3600 \
  --concurrency=80 \
  --min-instances=1 \
  --max-instances=1 \
  --set-env-vars="${ENV_VARS}" \
  --allow-unauthenticated

echo
echo "Done."
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)
echo "Studio URL: ${SERVICE_URL}"
