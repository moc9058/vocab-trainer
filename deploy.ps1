# Deploy vocab-trainer to Google Cloud Run
# Usage: .\deploy.ps1 [<GCP_PROJECT_ID>] [<REGION>] [-Word] [-WipeGrammar] [-Llm] [-Auth] [-Prompts] [-Archives] [-ExampleSentences] [-GrammarExamples]
#
# Options:
#   -Word               Run Firestore word data migration after deploying backend
#   -WipeGrammar        Wipe all grammar collections in Firestore (destructive)
#   -Llm                Upload LLM config (OpenAI key/model names) from .env to Firestore
#   -Auth               Upload Google OAuth config from .env to Firestore (config/auth)
#   -Prompts            Upload speaking/writing + translation config to Firestore
#   -Archives           Upload backup + original archive data to Firestore
#   -ExampleSentences   Migrate embedded examples to example_sentences collection
#   -GrammarExamples    Normalize inline Grammar.examples into example_sentences + back-refs
#
# Flags can be used together.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Artifact Registry API and Cloud Run API enabled

param(
    [Parameter(Position = 0)]
    [string]$ProjectId = "vocab-trainer-490014",

    [Parameter(Position = 1)]
    [string]$Region = "asia-northeast1",

    [switch]$Word,
    [switch]$WipeGrammar,
    [switch]$Llm,
    [switch]$Auth,
    [switch]$Prompts,
    [switch]$Archives,
    [switch]$ExampleSentences,
    [switch]$GrammarExamples
)

function Invoke-Checked {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Description failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

if (-not ($Word -or $WipeGrammar -or $Llm -or $Auth -or $Prompts -or $Archives -or $ExampleSentences -or $GrammarExamples)) {
    Write-Host "==> Skipping Firestore migration (use -Word, -WipeGrammar, -Llm, -Auth, -Prompts, -Archives, -ExampleSentences, and/or -GrammarExamples to run)"
}

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

# Optionally seed Firestore with data from local files (before deploy so configs are available on startup)
if ($Word -or $WipeGrammar -or $Llm -or $Auth -or $Prompts -or $Archives -or $ExampleSentences -or $GrammarExamples) {
    Write-Host "==> Installing backend dependencies for migration..."
    Push-Location backend
    try {
        npm install --silent
        Invoke-Checked "npm install"
    } finally {
        Pop-Location
    }
}

if ($Word) {
    Write-Host "==> Running Firestore word migration..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-to-firestore.ts
        Invoke-Checked "migrate-to-firestore.ts"
    } finally {
        Pop-Location
    }
}

if ($WipeGrammar) {
    Write-Host "==> Wiping grammar collections in Firestore..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/wipe-grammar-firestore.ts
        Invoke-Checked "wipe-grammar-firestore.ts"
    } finally {
        Pop-Location
    }
}

if ($Llm) {
    Write-Host "==> Uploading LLM config to Firestore..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-llm-config-to-firestore.ts
        Invoke-Checked "migrate-llm-config-to-firestore.ts"
    } finally {
        Pop-Location
    }
}

if ($Auth) {
    Write-Host "==> Uploading Google OAuth config to Firestore..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-auth-config-to-firestore.ts
        Invoke-Checked "migrate-auth-config-to-firestore.ts"
    } finally {
        Pop-Location
    }
}

if ($Prompts) {
    Write-Host "==> Uploading speaking/writing + translation config to Firestore..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-db-config-to-firestore.ts --prompts
        Invoke-Checked "migrate-db-config-to-firestore.ts --prompts"
    } finally {
        Pop-Location
    }
}

if ($Archives) {
    Write-Host "==> Uploading backup + original archives to Firestore..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-db-config-to-firestore.ts --archives
        Invoke-Checked "migrate-db-config-to-firestore.ts --archives"
    } finally {
        Pop-Location
    }
}

if ($ExampleSentences) {
    Write-Host "==> Migrating embedded examples to example_sentences collection..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-example-sentences.ts
        Invoke-Checked "migrate-example-sentences.ts"
    } finally {
        Pop-Location
    }
}

if ($GrammarExamples) {
    Write-Host "==> Migrating inline grammar examples to example_sentences collection..."
    Push-Location backend
    try {
        $env:FIRESTORE_PROJECT = $ProjectId
        $env:FIRESTORE_DATABASE_ID = "vocab-database"
        npx tsx scripts/migrate-grammar-examples.ts
        Invoke-Checked "migrate-grammar-examples.ts"
    } finally {
        Pop-Location
    }
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
