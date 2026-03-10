param(
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

$requiredFiles = @(
  (Join-Path $repoRoot "access.priv.pem"),
  (Join-Path $repoRoot "access.pub.pem"),
  (Join-Path $repoRoot "refresh.priv.pem"),
  (Join-Path $repoRoot "refresh.pub.pem")
)

$missingFiles = $requiredFiles | Where-Object { -not (Test-Path $_) }
if ($missingFiles.Count -gt 0) {
  $missingList = $missingFiles -join ", "
  throw "Missing required key files: $missingList"
}

$env:NODE_ENV = "development"
$env:HOST = "0.0.0.0"
$env:PORT = "4000"

$env:DATABASE_URL = "postgres://medsys:medsys@localhost:5432/medsys"
$env:DATABASE_READ_URL = "postgres://medsys:medsys@localhost:5432/medsys"
$env:REDIS_URL = "redis://localhost:6379"
$env:ICD10_API_BASE_URL = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search"
$env:AUDIT_TRANSPORT = "auto"
$env:AUDIT_QUEUE_KEY = "medsys:audit:events"
$env:AUDIT_WORKER_BLOCK_SECONDS = "5"
$env:ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111"

$env:JWT_ACCESS_PRIVATE_KEY = Get-Content (Join-Path $repoRoot "access.priv.pem") -Raw
$env:JWT_ACCESS_PUBLIC_KEY = Get-Content (Join-Path $repoRoot "access.pub.pem") -Raw
$env:JWT_REFRESH_PRIVATE_KEY = Get-Content (Join-Path $repoRoot "refresh.priv.pem") -Raw
$env:JWT_REFRESH_PUBLIC_KEY = Get-Content (Join-Path $repoRoot "refresh.pub.pem") -Raw

$env:ACCESS_TOKEN_TTL_SECONDS = "900"
$env:REFRESH_TOKEN_TTL_SECONDS = "604800"
$env:REQUEST_ID_HEADER = "x-request-id"

Write-Host "Loaded API development environment for $repoRoot"

if ($NoStart) {
  Write-Host "Skipping API startup because -NoStart was provided."
  exit 0
}

Push-Location $repoRoot
try {
  npm run dev -w @medsys/api
} finally {
  Pop-Location
}
