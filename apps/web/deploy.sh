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
# Secrets live in Google Secret Manager — referenced by name so deploys can
# never drop them and values never touch the shell env or git:
#   studio-gate-secret  → STUDIO_GATE_SECRET (shared HMAC secret w/ Studio)
#   helcim-api-token    → HELCIM_API_TOKEN (billing; referenced only if the
#                         secret exists — create with:
#                         printf '<token>' | gcloud secrets create helcim-api-token \
#                           --replication-policy=automatic --data-file=-)
ENV_VARS="DONOVA_BUCKET=donova-renders-donova-514500,DONOVA_WORKER_URL=https://donova-render-worker-2hsglzbnna-uc.a.run.app"
[ -n "${DONOVA_OWNER_EMAILS:-}" ] && ENV_VARS="${ENV_VARS},DONOVA_OWNER_EMAILS=${DONOVA_OWNER_EMAILS}"

SECRETS="STUDIO_GATE_SECRET=studio-gate-secret:latest"
if gcloud secrets describe helcim-api-token --project="${PROJECT_ID}" >/dev/null 2>&1; then
  SECRETS="${SECRETS},HELCIM_API_TOKEN=helcim-api-token:latest"
else
  echo "  (helcim-api-token secret not found — billing checkout disabled)"
fi

gcloud run deploy donova-web \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_TAG}" \
  --cpu=1 \
  --memory=2Gi \
  --timeout=300 \
  --allow-unauthenticated \
  --set-env-vars="${ENV_VARS}" \
  --set-secrets="${SECRETS}"

echo
echo "✓ Done! Donova Web App is live on Google Cloud Run."
SERVICE_URL=$(gcloud run services describe donova-web --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')
echo "Public Web App URL: ${SERVICE_URL}"
