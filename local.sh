#!/bin/bash
# Local verification environment for vocab-trainer — one command per workflow.
# Usage: ./local.sh [command] [--download]
#
#   up (default)  Start the Firestore emulator, seed it (auto-downloads a sample
#                 from production on first run), then build & start the full stack
#                 with the SAME Dockerfiles deploy.sh uses. Open http://localhost:5173
#   dev           Hot-reload mode: emulator in Docker, backend (npm run dev:local)
#                 and frontend (npm run dev) on the host. Ctrl-C stops both.
#   seed          Force-reload the snapshot into the emulator (wipes it first)
#   down          Stop all containers
#
#   --download    With up/dev/seed: refresh the sample from PRODUCTION first
#                 (read-only; needs `gcloud auth application-default login`)
#
# Nothing here touches production Firestore except seed:download, which is
# read-only. See README.md "Local Development & Verification" for details.

set -euo pipefail
cd "$(dirname "$0")"

PROJECT_ID="${FIRESTORE_PROJECT:-vocab-trainer-490014}"
DATABASE_ID="${FIRESTORE_DATABASE_ID:-vocab-database}"
EMULATOR="localhost:8080"
SNAPSHOT="backend/data/local-seed/manifest.json"

COMMAND="up"
DOWNLOAD=false
for arg in "$@"; do
  case "$arg" in
    up|dev|seed|down) COMMAND="$arg" ;;
    --download)       DOWNLOAD=true ;;
    *) echo "Unknown argument: $arg"; sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  esac
done

ensure_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "NOTE: created .env from .env.example — OPENAI_* keys are empty, so LLM"
    echo "      features (smart-add, translation, …) are disabled until you fill them in."
  fi
}

ensure_deps() {
  [ -d backend/node_modules ]  || (echo "Installing backend deps...";  cd backend  && npm install --silent)
  [ -d frontend/node_modules ] || (echo "Installing frontend deps..."; cd frontend && npm install --silent)
}

wait_emulator() {
  echo "Waiting for the Firestore emulator at ${EMULATOR}..."
  for _ in $(seq 1 30); do
    if curl -fsS "http://${EMULATOR}/" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "ERROR: emulator did not become ready. Check: docker compose logs firestore"
  exit 1
}

emulator_empty() {
  # The emulator serves the Firestore REST API; an empty database returns {}.
  ! curl -fsS "http://${EMULATOR}/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/languages?pageSize=1" 2>/dev/null \
    | grep -q '"documents"'
}

seed() {
  local force="$1"
  if $DOWNLOAD || [ ! -f "$SNAPSHOT" ]; then
    [ -f "$SNAPSHOT" ] || echo "No snapshot yet — downloading a sample from production (read-only)..."
    (cd backend && npm run seed:download)
  fi
  if [ "$force" = force ] || emulator_empty; then
    (cd backend && npm run seed:load)
  else
    echo "Emulator already has data — keeping it (run './local.sh seed' to force a reload)."
  fi
}

case "$COMMAND" in
  down)
    docker compose down
    ;;

  seed)
    ensure_env; ensure_deps
    docker compose up -d firestore
    wait_emulator
    seed force
    ;;

  up)
    ensure_env; ensure_deps
    docker compose up -d firestore
    wait_emulator
    seed keep
    echo "Building and starting the full stack (same Dockerfiles as deploy.sh)..."
    docker compose up --build -d
    echo "Waiting for the backend (through the nginx proxy)..."
    for _ in $(seq 1 45); do
      if curl -fsS http://localhost:5173/api/languages >/dev/null 2>&1; then
        echo ""
        echo "Ready:  http://localhost:5173   (API: http://localhost:3000)"
        echo "Logs:   docker compose logs -f backend"
        echo "Stop:   ./local.sh down"
        exit 0
      fi
      sleep 2
    done
    echo "ERROR: backend did not come up. Check: docker compose logs backend"
    exit 1
    ;;

  dev)
    ensure_env; ensure_deps
    docker compose up -d firestore
    # Free :3000/:5173 in case the full stack is running.
    docker compose stop backend frontend >/dev/null 2>&1 || true
    wait_emulator
    seed keep
    echo ""
    echo "Starting backend (dev:local) + frontend (vite) — Ctrl-C stops both."
    echo "Open http://localhost:5173 once vite is up."
    echo ""
    # npm held directly (no subshell wrapper): npm forwards SIGTERM to its script
    # child and tsx/vite forward it on, so killing these two PIDs stops the whole
    # tree — a killed subshell would orphan npm and leave the servers running.
    npm --prefix backend run dev:local &
    BACK_PID=$!
    npm --prefix frontend run dev &
    FRONT_PID=$!
    trap 'trap - INT TERM; kill "$BACK_PID" "$FRONT_PID" 2>/dev/null' INT TERM
    wait
    ;;
esac
