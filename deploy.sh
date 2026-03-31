#!/usr/bin/env bash
set -euo pipefail

# Deploy vocab-trainer to Google Cloud Run
# Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--word] [--grammer] [--llm] [--prompts] [--archives]
#
# Options:
#   --word      Run Firestore word data migration after deploying backend
#   --grammer   Run Firestore grammar data migration after deploying backend
#   --llm       Upload LLM config (Azure OpenAI keys) from .env to Firestore
#   --prompts   Upload speaking/writing + translation config to Firestore
#   --archives  Upload backup + original archive data to Firestore
#
# Flags can be used together.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Artifact Registry API and Cloud Run API enabled

MIGRATE_WORD=false
MIGRATE_GRAMMER=false
MIGRATE_LLM=false
MIGRATE_PROMPTS=false
MIGRATE_ARCHIVES=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --word) MIGRATE_WORD=true ;;
    --grammer) MIGRATE_GRAMMER=true ;;
    --llm) MIGRATE_LLM=true ;;
    --prompts) MIGRATE_PROMPTS=true ;;
    --archives) MIGRATE_ARCHIVES=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

PROJECT_ID="${POSITIONAL[0]:?Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--migrate]}"
REGION="${POSITIONAL[1]:-us-central1}"
BACKEND_REPO="vocab-test-backend"
FRONTEND_REPO="vocab-test-frontend"
BACKEND_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${BACKEND_REPO}/backend"
FRONTEND_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${FRONTEND_REPO}/frontend"

echo "==> Project: ${PROJECT_ID}, Region: ${REGION}"

# Configure Docker auth for Artifact Registry
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# Build and push backend
echo "==> Building and pushing backend..."
docker build --platform linux/amd64 -t "${BACKEND_IMAGE}" ./backend
docker push "${BACKEND_IMAGE}"

# Optionally seed Firestore with data from local files (before deploy so configs are available on startup)
if [ "$MIGRATE_WORD" = true ] || [ "$MIGRATE_GRAMMER" = true ] || [ "$MIGRATE_LLM" = true ] || [ "$MIGRATE_PROMPTS" = true ] || [ "$MIGRATE_ARCHIVES" = true ]; then
  echo "==> Installing backend dependencies for migration..."
  (cd backend && npm install --silent)
fi
if [ "$MIGRATE_WORD" = true ]; then
  echo "==> Running Firestore word migration..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-to-firestore.ts)
fi
if [ "$MIGRATE_GRAMMER" = true ]; then
  echo "==> Running Firestore grammar migration..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-grammar-to-firestore.ts)
fi
if [ "$MIGRATE_LLM" = true ]; then
  echo "==> Uploading LLM config to Firestore..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-llm-config-to-firestore.ts)
fi
if [ "$MIGRATE_PROMPTS" = true ]; then
  echo "==> Uploading speaking/writing + translation config to Firestore..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-db-config-to-firestore.ts --prompts)
fi
if [ "$MIGRATE_ARCHIVES" = true ]; then
  echo "==> Uploading backup + original archives to Firestore..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-db-config-to-firestore.ts --archives)
fi
if [ "$MIGRATE_WORD" = false ] && [ "$MIGRATE_GRAMMER" = false ] && [ "$MIGRATE_LLM" = false ] && [ "$MIGRATE_PROMPTS" = false ] && [ "$MIGRATE_ARCHIVES" = false ]; then
  echo "==> Skipping Firestore migration (use --word, --grammer, --llm, --prompts, and/or --archives to run)"
fi

# Deploy backend to Cloud Run
echo "==> Deploying backend to Cloud Run..."
gcloud run deploy vocab-trainer-backend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${BACKEND_IMAGE}" \
  --platform=managed \
  --port=3000 \
  --allow-unauthenticated \
  --min-instances=1 \
  --cpu-boost \
  --timeout=3600 \
  --set-env-vars="FIRESTORE_DATABASE_ID=vocab-database"

# Get backend URL
BACKEND_URL=$(gcloud run services describe vocab-trainer-backend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(status.url)")
echo "==> Backend deployed at: ${BACKEND_URL}"

# Build and push frontend
echo "==> Building and pushing frontend..."
docker build --platform linux/amd64 -t "${FRONTEND_IMAGE}" ./frontend
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
  --min-instances=1 \
  --cpu-boost \
  --set-env-vars="BACKEND_URL=${BACKEND_URL}"

FRONTEND_URL=$(gcloud run services describe vocab-trainer-frontend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(status.url)")

echo ""
echo "==> Deployment complete!"
echo "    Frontend: ${FRONTEND_URL}"
echo "    Backend:  ${BACKEND_URL}"
