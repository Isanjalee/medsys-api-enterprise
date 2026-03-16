param(
  [switch]$NoDocker,
  [switch]$NoMigrate,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dockerDir = Join-Path $repoRoot "infra/docker"
$envFile = Join-Path $repoRoot ".env"

if (-not (Test-Path $envFile)) {
  throw "Missing .env at $envFile. Create it before starting the local stack."
}

Push-Location $repoRoot
try {
  if (-not $NoDocker) {
    Write-Host "Starting Docker services from $dockerDir ..."
    Push-Location $dockerDir
    try {
      docker compose up -d
    } finally {
      Pop-Location
    }
  } else {
    Write-Host "Skipping Docker startup because -NoDocker was provided."
  }

  if (-not $NoMigrate) {
    Write-Host "Running database migrations ..."
    npm run db:migrate
  } else {
    Write-Host "Skipping database migrations because -NoMigrate was provided."
  }

  Write-Host ""
  Write-Host "Local URLs"
  Write-Host "  API:     http://localhost:4000"
  Write-Host "  Swagger: http://localhost:4000/api/v1/docs"
  Write-Host "  DB UI:   http://localhost:8081"
  Write-Host "  Health:  http://localhost:4000/healthz"
  Write-Host ""

  if ($NoStart) {
    Write-Host "Preparation finished. Skipping API startup because -NoStart was provided."
    exit 0
  }

  Write-Host "Starting API server ..."
  npm run dev -w @medsys/api
} finally {
  Pop-Location
}
