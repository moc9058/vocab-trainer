#!/usr/bin/env bash
set -euo pipefail

# Let gcloud find Python automatically (override with CLOUDSDK_PYTHON env var if needed)
# macOS/Linux use python3; Windows (Git Bash) uses python
case "$(uname -s)" in
  Darwin*|Linux*) export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-python3}" ;;
  *)              export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-python}" ;;
esac

# Deploy vocab-trainer to Google Cloud Run
# Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--word] [--wipe-grammar] [--llm] [--prompts] [--archives] [--example-sentences] [--grammar-examples]
#
# Options:
#   --word               Run Firestore word data migration after deploying backend
#   --wipe-grammar       Wipe all grammar collections in Firestore (destructive)
#   --llm                Upload LLM config (OpenAI key/model names) from .env to Firestore
#   --prompts            Upload speaking/writing + translation config to Firestore
#   --archives           Upload backup + original archive data to Firestore
#   --example-sentences  Migrate embedded examples to example_sentences collection
#   --grammar-examples   Normalize inline Grammar.examples into example_sentences + back-refs
#
# Flags can be used together.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Artifact Registry API and Cloud Run API enabled

MIGRATE_WORD=false
WIPE_GRAMMAR=false
MIGRATE_LLM=false
MIGRATE_PROMPTS=false
MIGRATE_ARCHIVES=false
MIGRATE_EXAMPLE_SENTENCES=false
MIGRATE_GRAMMAR_EXAMPLES=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --word) MIGRATE_WORD=true ;;
    --wipe-grammar) WIPE_GRAMMAR=true ;;
    --llm) MIGRATE_LLM=true ;;
    --prompts) MIGRATE_PROMPTS=true ;;
    --archives) MIGRATE_ARCHIVES=true ;;
    --example-sentences) MIGRATE_EXAMPLE_SENTENCES=true ;;
    --grammar-examples) MIGRATE_GRAMMAR_EXAMPLES=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

if [ "$MIGRATE_WORD" = false ] && [ "$WIPE_GRAMMAR" = false ] && [ "$MIGRATE_LLM" = false ] && [ "$MIGRATE_PROMPTS" = false ] && [ "$MIGRATE_ARCHIVES" = false ] && [ "$MIGRATE_EXAMPLE_SENTENCES" = false ] && [ "$MIGRATE_GRAMMAR_EXAMPLES" = false ]; then
  echo "==> Skipping Firestore migration (use --word, --wipe-grammar, --llm, --prompts, --archives, --example-sentences, and/or --grammar-examples to run)"
fi

PROJECT_ID="${POSITIONAL[0]:-vocab-trainer-490014}"
REGION="${POSITIONAL[1]:-asia-northeast1}"
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
if [ "$MIGRATE_WORD" = true ] || [ "$WIPE_GRAMMAR" = true ] || [ "$MIGRATE_LLM" = true ] || [ "$MIGRATE_PROMPTS" = true ] || [ "$MIGRATE_ARCHIVES" = true ] || [ "$MIGRATE_EXAMPLE_SENTENCES" = true ] || [ "$MIGRATE_GRAMMAR_EXAMPLES" = true ]; then
  echo "==> Installing backend dependencies for migration..."
  (cd backend && npm install --silent)
fi
if [ "$MIGRATE_WORD" = true ]; then
  echo "==> Running Firestore word migration..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-to-firestore.ts)
fi
if [ "$WIPE_GRAMMAR" = true ]; then
  echo "==> Wiping grammar collections in Firestore..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/wipe-grammar-firestore.ts)
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
if [ "$MIGRATE_EXAMPLE_SENTENCES" = true ]; then
  echo "==> Migrating embedded examples to example_sentences collection..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-example-sentences.ts)
fi
if [ "$MIGRATE_GRAMMAR_EXAMPLES" = true ]; then
  echo "==> Migrating inline grammar examples to example_sentences collection..."
  (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
    npx tsx scripts/migrate-grammar-examples.ts)
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
  --timeout=3600 \
  --set-env-vars="BACKEND_URL=${BACKEND_URL}"

FRONTEND_URL=$(gcloud run services describe vocab-trainer-frontend \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(status.url)")

echo ""
echo "==> Deployment complete!"
echo "    Frontend: ${FRONTEND_URL}"
echo "    Backend:  ${BACKEND_URL}"
