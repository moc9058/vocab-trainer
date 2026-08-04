#!/usr/bin/env bash
set -euo pipefail

# Let gcloud find Python automatically (override with CLOUDSDK_PYTHON env var if needed)
# macOS/Linux use python3; Windows (Git Bash) uses python
case "$(uname -s)" in
  Darwin*|Linux*) export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-python3}" ;;
  *)              export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-python}" ;;
esac

# Deploy vocab-trainer to Google Cloud Run
# Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--llm] [--auth] [--prompts] [--no-prune]
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
# Every deploy also PRUNES what the previous one superseded (skip with --no-prune):
# the local <none> image the rebuild orphaned, Artifact Registry versions past
# KEEP_IMAGES, Cloud Run revisions past KEEP_REVISIONS, and build cache past
# BUILD_CACHE_LIMIT. Without it all four grow without bound — this repo reached 53
# local images / 31GB of build cache and 888 inactive Cloud Run revisions before the
# retention below existed. Override any of the four via the environment.
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

USAGE="Usage: ./deploy.sh <GCP_PROJECT_ID> [REGION] [--llm] [--auth] [--prompts] [--no-prune]"

# How much history each deploy leaves behind. Images and revisions are kept in step
# on purpose: a revision is only rollback-able while the digest it pins still exists,
# so retaining more revisions than images would just leave dead entries in the list.
KEEP_IMAGES="${KEEP_IMAGES:-5}"
KEEP_REVISIONS="${KEEP_REVISIONS:-5}"
BUILD_CACHE_LIMIT="${BUILD_CACHE_LIMIT:-10GB}"
PRUNE=1

# Each entry is "label|script and its arguments".
UPLOADS=()
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --llm)     UPLOADS+=("LLM config|migrate-llm-config-to-firestore.ts") ;;
    --auth)    UPLOADS+=("Google OAuth config|migrate-auth-config-to-firestore.ts") ;;
    --prompts) UPLOADS+=("prompt & schema config|migrate-db-config-to-firestore.ts --prompts") ;;
    --no-prune) PRUNE=0 ;;
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

# --- retention helpers -------------------------------------------------------

# `docker build -t X` reuses the tag, so the build it replaces survives as an
# untagged <none> image that nothing ever collects. Capture the id beforehand and
# drop it once the replacement is safely pushed.
# Query the tag, not the bare repository: `docker images -q repo/name` matches EVERY
# tag in that repository and would return several ids.
current_image_id() { docker images -q "$1:latest" 2>/dev/null | head -n 1 || true; }

drop_superseded_image() {
  local previous="$1" current="$2"
  if [ -n "${previous}" ] && [ "${previous}" != "${current}" ]; then
    echo "==> Removing superseded local image ${previous}"
    docker rmi "${previous}" >/dev/null 2>&1 || true
  fi
}

# Keep the newest ${KEEP_IMAGES} versions of an image; delete the rest. Called
# AFTER the Cloud Run deploy, so position 1 is always the digest now serving.
#
# Two traps this is deliberately written around:
#   * NEVER pass --limit. gcloud applies it server-side BEFORE --sort-by, so it
#     returns an unsorted page — and you delete whatever happened to be on it.
#   * NEVER "delete everything untagged". With buildx provenance ON, ONE push
#     writes THREE versions: an OCI index (which carries the tag) plus an amd64
#     child and an attestation child, both untagged. Cloud Run pins the CHILD
#     digest, so an untagged-sweep deletes the image production is running.
#     The --provenance=false on the builds below collapses a push back to a single
#     tagged manifest, which is what makes plain count-based retention correct.
prune_registry() {
  local image="$1" digest
  echo "==> Pruning ${image} (keeping newest ${KEEP_IMAGES})"
  gcloud artifacts docker images list "${image}" \
    --project="${PROJECT_ID}" \
    --format='value(version)' \
    --sort-by=~createTime 2>/dev/null \
  | tail -n +"$((KEEP_IMAGES + 1))" \
  | while read -r digest; do
      [ -z "${digest}" ] && continue
      gcloud artifacts docker images delete "${image}@${digest}" \
        --project="${PROJECT_ID}" --delete-tags --quiet >/dev/null 2>&1 \
        && echo "    deleted ${digest:0:19}" \
        || echo "    skipped ${digest:0:19} (still referenced)"
    done
}

# Inactive revisions are free, but they are capped at 1000 per service and this
# repo had already burned 451 of them. gcloud refuses to delete a revision that is
# serving traffic, which is the backstop for the newest one.
prune_revisions() {
  local service="$1" rev
  echo "==> Pruning ${service} revisions (keeping newest ${KEEP_REVISIONS})"
  gcloud run revisions list --service="${service}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --format='value(metadata.name)' \
    --sort-by=~metadata.creationTimestamp 2>/dev/null \
  | tail -n +"$((KEEP_REVISIONS + 1))" \
  | while read -r rev; do
      [ -z "${rev}" ] && continue
      gcloud run revisions delete "${rev}" \
        --project="${PROJECT_ID}" --region="${REGION}" --quiet >/dev/null 2>&1 || true
    done
}

# Configure Docker auth for Artifact Registry
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# Build and push backend
echo "==> Building and pushing backend..."
PREV_BACKEND_ID="$(current_image_id "${BACKEND_IMAGE}")"
# --provenance=false: see prune_registry. Without it every push writes an index plus
# two untagged children, tripling the registry and making "untagged" unsafe to sweep.
docker build --platform linux/amd64 --provenance=false -t "${BACKEND_IMAGE}" ./backend
docker push "${BACKEND_IMAGE}"
drop_superseded_image "${PREV_BACKEND_ID}" "$(current_image_id "${BACKEND_IMAGE}")"

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
PREV_FRONTEND_ID="$(current_image_id "${FRONTEND_IMAGE}")"
docker build --platform linux/amd64 --provenance=false -t "${FRONTEND_IMAGE}" ./frontend
docker push "${FRONTEND_IMAGE}"
drop_superseded_image "${PREV_FRONTEND_ID}" "$(current_image_id "${FRONTEND_IMAGE}")"

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

# Prune only after BOTH services are up: the retention counts assume the newest
# image and revision are the ones now serving, which is only true once the deploy
# above has actually succeeded. `set -e` means a failure earlier never reaches here.
if [ "${PRUNE}" -eq 1 ]; then
  echo ""
  echo "==> Cleaning up superseded artifacts..."
  # `|| true` on each: the deploy has already SUCCEEDED by this point, so a registry
  # hiccup during cleanup must not make `set -e` abort and report the release as
  # failed. Bash also suspends `set -e` inside a function invoked in a `||` list,
  # which is what keeps a mid-loop failure from killing the run.
  prune_registry "${BACKEND_IMAGE}"  || true
  prune_registry "${FRONTEND_IMAGE}" || true
  prune_revisions "vocab-trainer-backend"  || true
  prune_revisions "vocab-trainer-frontend" || true

  # Cap the local build cache. --max-used-space is the current flag; --keep-storage
  # is its pre-Docker-28 spelling, so try the modern one and fall back.
  echo "==> Trimming build cache to ${BUILD_CACHE_LIMIT}"
  docker builder prune --force --max-used-space="${BUILD_CACHE_LIMIT}" >/dev/null 2>&1 \
    || docker builder prune --force --keep-storage="${BUILD_CACHE_LIMIT}" >/dev/null 2>&1 \
    || echo "    (build cache prune unsupported by this Docker; skipped)"
else
  echo ""
  echo "==> Prune skipped (--no-prune)"
fi

echo ""
echo "==> Deployment complete!"
echo "    Frontend: ${FRONTEND_URL}"
echo "    Backend:  ${BACKEND_URL}"
