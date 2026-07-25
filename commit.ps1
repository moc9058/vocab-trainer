# Usage: .\commit.ps1 <message> [branch]

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Message,

    [Parameter(Position = 1)]
    [string]$Branch = "master"
)

$ErrorActionPreference = "Stop"

git show-ref --verify --quiet "refs/heads/$Branch"
if ($LASTEXITCODE -ne 0) {
    git checkout -b $Branch
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

git add .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git commit -m $Message
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git push origin $Branch
exit $LASTEXITCODE
