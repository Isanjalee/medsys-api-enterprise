param(
  [string]$OutputRoot = ".\\rotated-jwt-keys"
)

$ErrorActionPreference = "Stop"

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDir = Join-Path $OutputRoot $timestamp

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$accessPriv = Join-Path $targetDir "access.priv.pem"
$accessPub = Join-Path $targetDir "access.pub.pem"
$refreshPriv = Join-Path $targetDir "refresh.priv.pem"
$refreshPub = Join-Path $targetDir "refresh.pub.pem"

openssl genrsa -out $accessPriv 2048 | Out-Null
openssl rsa -in $accessPriv -pubout -out $accessPub | Out-Null
openssl genrsa -out $refreshPriv 2048 | Out-Null
openssl rsa -in $refreshPriv -pubout -out $refreshPub | Out-Null

Write-Host "Generated JWT key rotation set in: $targetDir"
Write-Host ""
Write-Host "PowerShell env snippet:"
Write-Host ('$env:JWT_ACCESS_PRIVATE_KEY=(Get-Content "{0}" -Raw)' -f $accessPriv)
Write-Host ('$env:JWT_ACCESS_PUBLIC_KEY=(Get-Content "{0}" -Raw)' -f $accessPub)
Write-Host ('$env:JWT_REFRESH_PRIVATE_KEY=(Get-Content "{0}" -Raw)' -f $refreshPriv)
Write-Host ('$env:JWT_REFRESH_PUBLIC_KEY=(Get-Content "{0}" -Raw)' -f $refreshPub)
