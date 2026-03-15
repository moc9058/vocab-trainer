#!/usr/bin/env bash
set -euo pipefail

# Migrate local DB files to Firestore
# Usage: ./migrate.sh <GCP_PROJECT_ID> [DATABASE_ID]

PROJECT_ID="${1:?Usage: ./migrate.sh <GCP_PROJECT_ID> [DATABASE_ID]}"
DATABASE_ID="${2:-vocab-database}"

echo "==> Migrating to Firestore (project: ${PROJECT_ID}, database: ${DATABASE_ID})..."
FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID="${DATABASE_ID}" \
  npx --prefix ./backend tsx backend/scripts/migrate-to-firestore.ts

echo "==> Migration complete!"
