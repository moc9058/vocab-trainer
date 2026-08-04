# Deploy vocab-trainer to Google Cloud Run
# Usage: .\deploy.ps1 [<GCP_PROJECT_ID>] [<REGION>] [-Llm] [-Auth] [-Prompts] [-NoPrune]
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
# Every deploy also PRUNES what the previous one superseded (skip with -NoPrune):
# the local <none> image the rebuild orphaned, Artifact Registry versions past
# -KeepImages, Cloud Run revisions past -KeepRevisions, and build cache past
# -BuildCacheLimit. Without it all four grow without bound — this repo reached 53
# local images / 31GB of build cache and 888 inactive Cloud Run revisions before the
# retention below existed.
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
    [switch]$Prompts,

    # Skip the post-deploy cleanup entirely.
    [switch]$NoPrune,

    # How much history each deploy leaves behind. Images and revisions are kept in
    # step on purpose: a revision is only rollback-able while the digest it pins
    # still exists, so retaining more revisions than images would just leave dead
    # entries in the list.
    [int]$KeepImages = 5,
    [int]$KeepRevisions = 5,
    [string]$BuildCacheLimit = "10GB"
)

function Invoke-Checked {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Description failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

# --- retention helpers -------------------------------------------------------

# `docker build -t X` reuses the tag, so the build it replaces survives as an
# untagged <none> image that nothing ever collects. Capture the id beforehand and
# drop it once the replacement is safely pushed.
function Get-ImageId {
    param([string]$Image)
    # "${Image}:latest", never "$Image:latest" — PowerShell reads the latter as a
    # SCOPED variable reference and silently yields nothing. Querying the tag rather
    # than the bare repository also avoids matching every tag in it.
    $id = docker images -q "${Image}:latest"
    if ($LASTEXITCODE -ne 0) { return "" }
    return ($id | Select-Object -First 1)
}

function Remove-SupersededImage {
    param([string]$Previous, [string]$Current)
    if ($Previous -and $Previous -ne $Current) {
        Write-Host "==> Removing superseded local image $Previous"
        docker rmi $Previous | Out-Null
    }
}

# Keep the newest $KeepImages versions of an image; delete the rest. Called AFTER
# the Cloud Run deploy, so position 1 is always the digest now serving.
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
function Invoke-PruneRegistry {
    param([string]$Image, [string]$ProjectId, [int]$Keep)
    Write-Host "==> Pruning $Image (keeping newest $Keep)"
    $versions = @(gcloud artifacts docker images list $Image `
                    --project=$ProjectId --format="value(version)" --sort-by=~createTime)
    if ($versions.Count -le $Keep) { Write-Host "    nothing to prune"; return }
    foreach ($digest in $versions[$Keep..($versions.Count - 1)]) {
        if (-not $digest) { continue }
        gcloud artifacts docker images delete "$Image@$digest" `
          --project=$ProjectId --delete-tags --quiet | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "    deleted $($digest.Substring(0,19))" }
        else { Write-Host "    skipped $($digest.Substring(0,19)) (still referenced)" }
    }
}

# Inactive revisions are free, but they are capped at 1000 per service and this
# repo had already burned 451 of them. gcloud refuses to delete a revision that is
# serving traffic, which is the backstop for the newest one.
function Invoke-PruneRevisions {
    param([string]$Service, [string]$ProjectId, [string]$Region, [int]$Keep)
    Write-Host "==> Pruning $Service revisions (keeping newest $Keep)"
    $revs = @(gcloud run revisions list --service=$Service `
                --project=$ProjectId --region=$Region `
                --format="value(metadata.name)" --sort-by=~metadata.creationTimestamp)
    if ($revs.Count -le $Keep) { Write-Host "    nothing to prune"; return }
    foreach ($rev in $revs[$Keep..($revs.Count - 1)]) {
        if (-not $rev) { continue }
        gcloud run revisions delete $rev --project=$ProjectId --region=$Region --quiet | Out-Null
    }
    Write-Host "    deleted $($revs.Count - $Keep)"
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
$PrevBackendId = Get-ImageId $BackendImage
# --provenance=false: see Invoke-PruneRegistry. Without it every push writes an index
# plus two untagged children, tripling the registry and making "untagged" unsafe to sweep.
docker build --platform linux/amd64 --provenance=false -t "$BackendImage" ./backend
Invoke-Checked "docker build (backend)"
docker push "$BackendImage"
Invoke-Checked "docker push (backend)"
Remove-SupersededImage $PrevBackendId (Get-ImageId $BackendImage)

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
$PrevFrontendId = Get-ImageId $FrontendImage
docker build --platform linux/amd64 --provenance=false -t "$FrontendImage" ./frontend
Invoke-Checked "docker build (frontend)"
docker push "$FrontendImage"
Invoke-Checked "docker push (frontend)"
Remove-SupersededImage $PrevFrontendId (Get-ImageId $FrontendImage)

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

# Prune only after BOTH services are up: the retention counts assume the newest
# image and revision are the ones now serving, which is only true once the deploy
# above has actually succeeded. Invoke-Checked exits earlier on any failure.
if (-not $NoPrune) {
    Write-Host ""
    Write-Host "==> Cleaning up superseded artifacts..."
    Invoke-PruneRegistry  -Image $BackendImage  -ProjectId $ProjectId -Keep $KeepImages
    Invoke-PruneRegistry  -Image $FrontendImage -ProjectId $ProjectId -Keep $KeepImages
    Invoke-PruneRevisions -Service "vocab-trainer-backend"  -ProjectId $ProjectId -Region $Region -Keep $KeepRevisions
    Invoke-PruneRevisions -Service "vocab-trainer-frontend" -ProjectId $ProjectId -Region $Region -Keep $KeepRevisions

    # Cap the local build cache. --max-used-space is the current flag; --keep-storage
    # is its pre-Docker-28 spelling, so try the modern one and fall back.
    Write-Host "==> Trimming build cache to $BuildCacheLimit"
    docker builder prune --force --max-used-space=$BuildCacheLimit | Out-Null
    if ($LASTEXITCODE -ne 0) {
        docker builder prune --force --keep-storage=$BuildCacheLimit | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host "    (build cache prune unsupported by this Docker; skipped)" }
    }
} else {
    Write-Host ""
    Write-Host "==> Prune skipped (-NoPrune)"
}

Write-Host ""
Write-Host "==> Deployment complete!"
Write-Host "    Frontend: $FrontendUrl"
Write-Host "    Backend:  $BackendUrl"
