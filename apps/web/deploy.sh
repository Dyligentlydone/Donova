#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-donova-514500}"
REGION="${2:-us-central1}"
REPO="${3:-donova-images}"
IMAGE_NAME="donova-web"

IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}:latest"

echo "======================================================"
echo " Donova Web App — Google Cloud Run Deploy"
echo " Project:  ${PROJECT_ID}"
echo " Region:   ${REGION}"
echo " Image:    ${IMAGE_TAG}"
echo "======================================================"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "Step 1/2: Submitting Docker build to Google Cloud Build (E2_HIGHCPU_8)..."
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --config=apps/web/cloudbuild.yaml \
  --substitutions=_IMAGE_TAG="${IMAGE_TAG}" \
  .

echo "Step 2/2: Deploying Cloud Run Service (donova-web)..."
# Secrets come from the environment (never committed):
#   HELCIM_API_TOKEN    — Helcim API access token (billing)
#   STUDIO_GATE_SECRET  — shared HMAC secret with the Studio service
#   DONOVA_OWNER_EMAILS — optional comma-separated owner allowlist
ENV_VARS="DONOVA_BUCKET=donova-renders-donova-514500,DONOVA_WORKER_URL=https://donova-render-worker-2hsglzbnna-uc.a.run.app"
[ -n "${HELCIM_API_TOKEN:-}" ] && ENV_VARS="${ENV_VARS},HELCIM_API_TOKEN=${HELCIM_API_TOKEN}"
[ -n "${STUDIO_GATE_SECRET:-}" ] && ENV_VARS="${ENV_VARS},STUDIO_GATE_SECRET=${STUDIO_GATE_SECRET}"
[ -n "${DONOVA_OWNER_EMAILS:-}" ] && ENV_VARS="${ENV_VARS},DONOVA_OWNER_EMAILS=${DONOVA_OWNER_EMAILS}"

gcloud run deploy donova-web \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_TAG}" \
  --cpu=1 \
  --memory=2Gi \
  --timeout=300 \
  --allow-unauthenticated \
  --set-env-vars="${ENV_VARS}"

echo
echo "✓ Done! Donova Web App is live on Google Cloud Run."
SERVICE_URL=$(gcloud run services describe donova-web --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')
echo "Public Web App URL: ${SERVICE_URL}"
