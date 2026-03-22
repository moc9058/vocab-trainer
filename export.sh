#!/usr/bin/env bash
set -euo pipefail

# Export Firestore data back to local JSON files
# Usage: ./export.sh <GCP_PROJECT_ID>
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Node.js and npm installed

PROJECT_ID="${1:?Usage: ./export.sh <GCP_PROJECT_ID>}"

echo "==> Exporting Firestore data from project: ${PROJECT_ID}"

echo "==> Installing backend dependencies..."
(cd backend && npm install --silent)

echo "==> Running Firestore export..."
(cd backend && FIRESTORE_PROJECT="${PROJECT_ID}" FIRESTORE_DATABASE_ID=vocab-database \
  npx tsx scripts/export-from-firestore.ts)

echo ""
echo "==> Export complete! Files written to backend/DB/ and backend/data/"
