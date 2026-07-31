#!/usr/bin/env bash
set -euo pipefail

# Let gcloud find Python automatically (override with CLOUDSDK_PYTHON env var if needed)
# macOS/Linux use python3; Windows (Git Bash) uses python
case "$(uname -s)" in
  Darwin*|Linux*) export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-python3}" ;;
  *)              export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-python}" ;;
esac

# Deploy vocab-trainer to Google Cloud Run
# Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--llm] [--auth] [--prompts]
#
# The optional flags push LOCAL CONFIG into Firestore just before the new revision
# rolls. That timing is the only reason they belong in a deploy script at all: every
# config document is read once and memoized for the life of the process
# (`routes/import.ts:169`) or read straight at boot (`auth-config.ts`), so an edit
# does not reach a running instance until one is replaced.
#
#   --llm      OpenAI key + model names from .env  -> config/llm
#   --auth     Google OAuth client from .env       -> config/auth
#   --prompts  Prompts + schemas from backend/DB/  -> config/{speaking_writing,
#              translation,vocabulary,grammar,import}
#
# Flags can be combined.
#
# NOT here, on purpose: one-off data migrations and destructive maintenance. They
# are not tied to a release, and burying a wipe behind a deploy flag invites running
# it by reflex. Invoke them directly instead:
#   cd backend && npx tsx scripts/migrate-example-sentences.ts
#   cd backend && npx tsx scripts/migrate-grammar-examples.ts
#   cd backend && npx tsx scripts/wipe-grammar-firestore.ts          # destructive
#   cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts --archives
# (`migrate-to-firestore.ts`, the old word import, reads backend/DB/word/ — now
#  empty, since Firestore is the source of truth for words.)
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Artifact Registry API and Cloud Run API enabled

USAGE="Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--llm] [--auth] [--prompts]"

# Each entry is "label|script and its arguments".
UPLOADS=()
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --llm)     UPLOADS+=("LLM config|migrate-llm-config-to-firestore.ts") ;;
    --auth)    UPLOADS+=("Google OAuth config|migrate-auth-config-to-firestore.ts") ;;
    --prompts) UPLOADS+=("prompt & schema config|migrate-db-config-to-firestore.ts --prompts") ;;
    # Without this, a typo like `--promts` falls through to POSITIONAL and is used
    # as the PROJECT_ID — deploying, silently, somewhere nobody meant.
    -*)
      echo "Unknown option: $arg" >&2
      echo "$USAGE" >&2
      exit 1
      ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

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

# Upload config BEFORE the new revision starts, so it is already in place when the
# fresh instance reads it.
if [ "${#UPLOADS[@]}" -gt 0 ]; then
  echo "==> Installing backend dependencies for the config upload..."
  (cd backend && npm install --silent)
  for entry in "${UPLOADS[@]}"; do
    label="${entry%%|*}"
    # Unquoted on purpose: the value may carry its own flag (`… --prompts`), and
    # every one of them is a literal defined above.
    script="${entry#*|}"
    echo "==> Uploading ${label} to Firestore..."
    (cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
      npx tsx scripts/${script})
  done
else
  echo "==> No config upload requested (use --llm, --auth and/or --prompts)"
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
