# Deploy vocab-trainer to Google Cloud Run
# Usage: .\deploy.ps1 [<GCP_PROJECT_ID>] [<REGION>] [-Llm] [-Auth] [-Prompts]
#
# The optional switches push LOCAL CONFIG into Firestore just before the new
# revision rolls. That timing is the only reason they belong in a deploy script at
# all: every config document is read once and memoized for the life of the process
# (routes/import.ts:169) or read straight at boot (auth-config.ts), so an edit does
# not reach a running instance until one is replaced.
#
#   -Llm      OpenAI key + model names from .env  -> config/llm
#   -Auth     Google OAuth client from .env       -> config/auth
#   -Prompts  Prompts + schemas from backend/DB/  -> config/{speaking_writing,
#             translation,vocabulary,grammar,import}
#
# Switches can be combined.
#
# NOT here, on purpose: one-off data migrations and destructive maintenance. They
# are not tied to a release, and burying a wipe behind a deploy switch invites
# running it by reflex. Invoke them directly instead:
#   cd backend; npx tsx scripts/migrate-example-sentences.ts
#   cd backend; npx tsx scripts/migrate-grammar-examples.ts
#   cd backend; npx tsx scripts/wipe-grammar-firestore.ts          # destructive
#   cd backend; npx tsx scripts/migrate-db-config-to-firestore.ts --archives
# (migrate-to-firestore.ts, the old word import, reads backend/DB/word/ — now
#  empty, since Firestore is the source of truth for words.)
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Artifact Registry API and Cloud Run API enabled

param(
    [Parameter(Position = 0)]
    [string]$ProjectId = "vocab-trainer-490014",

    [Parameter(Position = 1)]
    [string]$Region = "asia-northeast1",

    [switch]$Llm,
    [switch]$Auth,
    [switch]$Prompts
)

function Invoke-Checked {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Description failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

$Uploads = @()
if ($Llm)     { $Uploads += @{ Label = "LLM config";             Script = "migrate-llm-config-to-firestore.ts";  Args = @() } }
if ($Auth)    { $Uploads += @{ Label = "Google OAuth config";    Script = "migrate-auth-config-to-firestore.ts"; Args = @() } }
if ($Prompts) { $Uploads += @{ Label = "prompt & schema config"; Script = "migrate-db-config-to-firestore.ts";   Args = @("--prompts") } }

$BackendRepo = "vocab-test-backend"
$FrontendRepo = "vocab-test-frontend"
$BackendImage = "$Region-docker.pkg.dev/$ProjectId/$BackendRepo/backend"
$FrontendImage = "$Region-docker.pkg.dev/$ProjectId/$FrontendRepo/frontend"

Write-Host "==> Project: $ProjectId, Region: $Region"

# Configure Docker auth for Artifact Registry
gcloud auth configure-docker "$Region-docker.pkg.dev" --quiet
Invoke-Checked "gcloud auth configure-docker"

# Build and push backend
Write-Host "==> Building and pushing backend..."
docker build --platform linux/amd64 -t "$BackendImage" ./backend
Invoke-Checked "docker build (backend)"
docker push "$BackendImage"
Invoke-Checked "docker push (backend)"

# Upload config BEFORE the new revision starts, so it is already in place when the
# fresh instance reads it.
if ($Uploads.Count -gt 0) {
    Write-Host "==> Installing backend dependencies for the config upload..."
    Push-Location backend
    try {
        npm install --silent
        Invoke-Checked "npm install"

        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        foreach ($upload in $Uploads) {
            Write-Host "==> Uploading $($upload.Label) to Firestore..."
            $cmdArgs = @("tsx", "scripts/$($upload.Script)") + $upload.Args
            npx @cmdArgs
            Invoke-Checked $upload.Script
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "==> No config upload requested (use -Llm, -Auth and/or -Prompts)"
}

# Deploy backend to Cloud Run
Write-Host "==> Deploying backend to Cloud Run..."
gcloud run deploy vocab-trainer-backend `
  --project="$ProjectId" `
  --region="$Region" `
  --image="$BackendImage" `
  --platform=managed `
  --port=3000 `
  --allow-unauthenticated `
  --min-instances=1 `
  --cpu-boost `
  --timeout=3600 `
  --set-env-vars="FIRESTORE_DATABASE_ID=vocab-database"
Invoke-Checked "gcloud run deploy vocab-trainer-backend"

# Get backend URL
$BackendUrl = gcloud run services describe vocab-trainer-backend `
  --project="$ProjectId" `
  --region="$Region" `
  --format="value(status.url)"
Invoke-Checked "gcloud run services describe vocab-trainer-backend"
Write-Host "==> Backend deployed at: $BackendUrl"

# Build and push frontend
Write-Host "==> Building and pushing frontend..."
docker build --platform linux/amd64 -t "$FrontendImage" ./frontend
Invoke-Checked "docker build (frontend)"
docker push "$FrontendImage"
Invoke-Checked "docker push (frontend)"

# Deploy frontend to Cloud Run with backend URL
Write-Host "==> Deploying frontend to Cloud Run..."
gcloud run deploy vocab-trainer-frontend `
  --project="$ProjectId" `
  --region="$Region" `
  --image="$FrontendImage" `
  --platform=managed `
  --port=5173 `
  --allow-unauthenticated `
  --min-instances=1 `
  --cpu-boost `
  --timeout=3600 `
  --set-env-vars="BACKEND_URL=$BackendUrl"
Invoke-Checked "gcloud run deploy vocab-trainer-frontend"

$FrontendUrl = gcloud run services describe vocab-trainer-frontend `
  --project="$ProjectId" `
  --region="$Region" `
  --format="value(status.url)"
Invoke-Checked "gcloud run services describe vocab-trainer-frontend"

Write-Host ""
Write-Host "==> Deployment complete!"
Write-Host "    Frontend: $FrontendUrl"
Write-Host "    Backend:  $BackendUrl"
