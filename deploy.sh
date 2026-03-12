#!/usr/bin/env bash
set -euo pipefail

# Deploy vocab-trainer to Google Cloud Run
# Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION]
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Artifact Registry API and Cloud Run API enabled

PROJECT_ID="${1:?Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION]}"
REGION="${2:-us-central1}"
BACKEND_REPO="vocab-test-backend"
FRONTEND_REPO="vocab-test-frontend"
BACKEND_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${BACKEND_REPO}/backend"
FRONTEND_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${FRONTEND_REPO}/frontend"

echo "==> Project: ${PROJECT_ID}, Region: ${REGION}"

# Configure Docker auth for Artifact Registry
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# Build and push backend
echo "==> Building and pushing backend..."
docker build -t "${BACKEND_IMAGE}" ./backend
docker push "${BACKEND_IMAGE}"

# Deploy backend to Cloud Run
echo "==> Deploying backend to Cloud Run..."
gcloud run deploy vocab-trainer-backend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${BACKEND_IMAGE}" \
  --platform=managed \
  --port=3000 \
  --allow-unauthenticated \
  --set-env-vars="PORT=3000,FIRESTORE_DATABASE_ID=vocab-database"

# Get backend URL
BACKEND_URL=$(gcloud run services describe vocab-trainer-backend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(status.url)")
echo "==> Backend deployed at: ${BACKEND_URL}"

# Build and push frontend
echo "==> Building and pushing frontend..."
docker build -t "${FRONTEND_IMAGE}" ./frontend
docker push "${FRONTEND_IMAGE}"

# Deploy frontend to Cloud Run with backend URL
echo "==> Deploying frontend to Cloud Run..."
gcloud run deploy vocab-trainer-frontend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${FRONTEND_IMAGE}" \
  --platform=managed \
  --port=5173 \
  --allow-unauthenticated \
  --set-env-vars="BACKEND_URL=${BACKEND_URL}"

FRONTEND_URL=$(gcloud run services describe vocab-trainer-frontend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(status.url)")

echo ""
echo "==> Deployment complete!"
echo "    Frontend: ${FRONTEND_URL}"
echo "    Backend:  ${BACKEND_URL}"
