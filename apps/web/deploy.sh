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
#   studio-gate-secret     → STUDIO_GATE_SECRET (shared HMAC secret w/ Studio)
#   stripe-secret-key      → STRIPE_SECRET_KEY (billing; live-mode key)
#   stripe-webhook-secret  → STRIPE_WEBHOOK_SECRET (signs /api/billing/webhook)
#   deepseek-api-key       → DONOVA_LLM_API_KEY (Studio chat agent; optional —
#                            without it the agent runs the rules-only fallback)
# STRIPE_PRICE_ID identifies the recurring price (not a secret):
#   price_1UbQBgL5oy3FSbVszyQ3tpD3 = Donova Creator $11.00/mo on prod_VcfWe1xAGRAQmm
ENV_VARS="DONOVA_BUCKET=donova-renders-donova-514500,DONOVA_WORKER_URL=https://donova-render-worker-2hsglzbnna-uc.a.run.app,DONOVA_LLM_BASE_URL=https://api.deepseek.com/anthropic,DONOVA_LLM_MODEL=deepseek-flash,STRIPE_PRICE_ID=price_1UbQBgL5oy3FSbVszyQ3tpD3"
[ -n "${DONOVA_OWNER_EMAILS:-}" ] && ENV_VARS="${ENV_VARS},DONOVA_OWNER_EMAILS=${DONOVA_OWNER_EMAILS}"

SECRETS="STUDIO_GATE_SECRET=studio-gate-secret:latest"
if gcloud secrets describe stripe-secret-key --project="${PROJECT_ID}" >/dev/null 2>&1; then
  SECRETS="${SECRETS},STRIPE_SECRET_KEY=stripe-secret-key:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret:latest"
else
  echo "  (stripe-secret-key secret not found — billing checkout disabled)"
fi
if gcloud secrets describe deepseek-api-key --project="${PROJECT_ID}" >/dev/null 2>&1; then
  SECRETS="${SECRETS},DONOVA_LLM_API_KEY=deepseek-api-key:latest"
else
  echo "  (deepseek-api-key secret not found — Studio agent runs rules-only fallback)"
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
