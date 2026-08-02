# Local verification environment for vocab-trainer — one command per workflow.
# Usage: .\local.ps1 [<command>] [-Download]
#
#   up (default)  Start the Firestore emulator, seed it (auto-downloads a sample
#                 from production on first run), then build & start the full stack
#                 with the SAME Dockerfiles deploy.ps1 uses. Open http://localhost:5173
#   dev           Hot-reload mode: emulator in Docker, backend (npm run dev:local)
#                 and frontend (npm run dev) each in a new window. Close them to stop.
#   seed          Force-reload the snapshot into the emulator (wipes it first)
#   down          Stop all containers
#
#   -Download     With up/dev/seed: refresh the sample from PRODUCTION first
#                 (read-only; needs `gcloud auth application-default login`)
#
# Nothing here touches production Firestore except seed:download, which is
# read-only. See README.md "Local Development & Verification" for details.

param(
    [Parameter(Position = 0)]
    [ValidateSet("up", "dev", "seed", "down")]
    [string]$Command = "up",

    [switch]$Download
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ProjectId  = if ($env:FIRESTORE_PROJECT)     { $env:FIRESTORE_PROJECT }     else { "vocab-trainer-490014" }
$DatabaseId = if ($env:FIRESTORE_DATABASE_ID) { $env:FIRESTORE_DATABASE_ID } else { "vocab-database" }
$Emulator   = "localhost:8080"
$Snapshot   = "backend\data\local-seed\manifest.json"

function Invoke-Checked {
    param([string]$Description)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$Description failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

function Ensure-Env {
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
        Write-Host "NOTE: created .env from .env.example — OPENAI_* keys are empty, so LLM"
        Write-Host "      features (smart-add, translation, ...) are disabled until you fill them in."
    }
}

function Ensure-Deps {
    if (-not (Test-Path "backend\node_modules")) {
        Write-Host "Installing backend deps..."
        Push-Location backend; npm install --silent; Invoke-Checked "backend npm install"; Pop-Location
    }
    if (-not (Test-Path "frontend\node_modules")) {
        Write-Host "Installing frontend deps..."
        Push-Location frontend; npm install --silent; Invoke-Checked "frontend npm install"; Pop-Location
    }
}

function Wait-Emulator {
    Write-Host "Waiting for the Firestore emulator at $Emulator..."
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -Uri "http://$Emulator/" -UseBasicParsing -TimeoutSec 3 | Out-Null
            return
        } catch { Start-Sleep -Seconds 2 }
    }
    Write-Error "Emulator did not become ready. Check: docker compose logs firestore"
    exit 1
}

function Test-EmulatorEmpty {
    # The emulator serves the Firestore REST API; an empty database returns {}.
    try {
        $resp = Invoke-WebRequest -Uri "http://$Emulator/v1/projects/$ProjectId/databases/$DatabaseId/documents/languages?pageSize=1" -UseBasicParsing -TimeoutSec 5
        return ($resp.Content -notmatch '"documents"')
    } catch { return $true }
}

function Invoke-Seed {
    param([bool]$Force)
    if ($Download -or -not (Test-Path $Snapshot)) {
        if (-not (Test-Path $Snapshot)) {
            Write-Host "No snapshot yet — downloading a sample from production (read-only)..."
        }
        Push-Location backend; npm run seed:download; Invoke-Checked "seed:download"; Pop-Location
    }
    if ($Force -or (Test-EmulatorEmpty)) {
        Push-Location backend; npm run seed:load; Invoke-Checked "seed:load"; Pop-Location
    } else {
        Write-Host "Emulator already has data — keeping it (run '.\local.ps1 seed' to force a reload)."
    }
}

switch ($Command) {
    "down" {
        docker compose down
        Invoke-Checked "docker compose down"
    }

    "seed" {
        Ensure-Env; Ensure-Deps
        docker compose up -d firestore; Invoke-Checked "starting emulator"
        Wait-Emulator
        Invoke-Seed -Force $true
    }

    "up" {
        Ensure-Env; Ensure-Deps
        docker compose up -d firestore; Invoke-Checked "starting emulator"
        Wait-Emulator
        Invoke-Seed -Force $false
        Write-Host "Building and starting the full stack (same Dockerfiles as deploy.ps1)..."
        docker compose up --build -d; Invoke-Checked "docker compose up"
        Write-Host "Waiting for the backend (through the nginx proxy)..."
        for ($i = 0; $i -lt 45; $i++) {
            try {
                Invoke-WebRequest -Uri "http://localhost:5173/api/languages" -UseBasicParsing -TimeoutSec 3 | Out-Null
                Write-Host ""
                Write-Host "Ready:  http://localhost:5173   (API: http://localhost:3000)"
                Write-Host "Logs:   docker compose logs -f backend"
                Write-Host "Stop:   .\local.ps1 down"
                exit 0
            } catch { Start-Sleep -Seconds 2 }
        }
        Write-Error "Backend did not come up. Check: docker compose logs backend"
        exit 1
    }

    "dev" {
        Ensure-Env; Ensure-Deps
        docker compose up -d firestore; Invoke-Checked "starting emulator"
        # Free :3000/:5173 in case the full stack is running.
        docker compose stop backend frontend 2>$null | Out-Null
        Wait-Emulator
        Invoke-Seed -Force $false
        Write-Host ""
        Write-Host "Opening backend (dev:local) and frontend (vite) in two windows — close them to stop."
        Write-Host "Open http://localhost:5173 once vite is up."
        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\backend'; npm run dev:local"
        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot\frontend'; npm run dev"
    }
}
