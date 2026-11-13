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
# STUDIO_GATE_SECRET comes from Google Secret Manager (studio-gate-secret) —
# referenced by name so deploys can never drop it. Rotate with:
#   printf '<new>' | gcloud secrets versions add studio-gate-secret --data-file=-
ENV_VARS="DONOVA_BUCKET=${DONOVA_BUCKET:-donova-renders-${PROJECT_ID}},PROJECT_PREFIX=${PROJECT_PREFIX:-projects/default/}"
# In-Studio agent chat (the bottom-right pill → sidecar /agent/* → OpenAI-
# compatible tool loop against the user's tree). DONOVA_CLOUD=1 pins the
# endpoint + disables setup/select/auto so nothing user-controlled can reach
# a shell or a cross-user key store inside the shared container.
ENV_VARS="${ENV_VARS},DONOVA_CLOUD=1,DONOVA_AGENT_URL=https://openrouter.ai/api/v1/chat/completions,DONOVA_AGENT_MODEL=deepseek/deepseek-v4.1-flash,DONOVA_AGENT_KEY_ENV=DONOVA_LLM_API_KEY"
[ -n "${DONOVA_OWNER_EMAILS:-}" ] && ENV_VARS="${ENV_VARS},DONOVA_OWNER_EMAILS=${DONOVA_OWNER_EMAILS}"

SECRETS="STUDIO_GATE_SECRET=studio-gate-secret:latest"
if gcloud secrets describe openrouter-api-key --project="${PROJECT_ID}" >/dev/null 2>&1; then
  SECRETS="${SECRETS},DONOVA_LLM_API_KEY=openrouter-api-key:latest"
else
  echo "  (openrouter-api-key secret not found — Studio agent chat disabled)"
fi

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
  --set-secrets="${SECRETS}" \
  --allow-unauthenticated

echo
echo "Done."
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)
echo "Studio URL: ${SERVICE_URL}"
