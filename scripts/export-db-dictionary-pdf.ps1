param(
  [string]$InputHtml = "docs/MEDSYS_Database_Dictionary.html",
  [string]$OutputPdf = "docs/MEDSYS_Database_Dictionary.pdf"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$inputPath = Join-Path $repoRoot $InputHtml
$outputPath = Join-Path $repoRoot $OutputPdf
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$userDataDir = Join-Path $repoRoot ".edge-pdf"

if (-not (Test-Path $edgePath)) {
  throw "Microsoft Edge was not found at $edgePath"
}

if (-not (Test-Path $inputPath)) {
  throw "Input HTML file was not found at $inputPath"
}

New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
$inputUri = "file:///" + ($inputPath -replace "\\", "/")

if (Test-Path $outputPath) {
  Remove-Item $outputPath -Force
}

$edgeArgs = @(
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=$userDataDir",
  "--print-to-pdf=$outputPath",
  "--print-to-pdf-no-header",
  $inputUri
)

$edgeProcess = Start-Process -FilePath $edgePath -ArgumentList $edgeArgs -PassThru

$pdfReady = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  if (Test-Path $outputPath) {
    Start-Sleep -Milliseconds 300
    $item = Get-Item $outputPath
    if ($item.Length -gt 0) {
      $pdfReady = $true
      break
    }
  }

  if ($edgeProcess.HasExited -and -not (Test-Path $outputPath)) {
    Start-Sleep -Milliseconds 500
  } else {
    Start-Sleep -Milliseconds 500
  }
}

if ($pdfReady -and -not $edgeProcess.HasExited) {
  try {
    Stop-Process -Id $edgeProcess.Id -Force -ErrorAction Stop
  } catch {
    # Ignore cleanup issues; the PDF is already present.
  }
}

if (-not $pdfReady) {
  throw "PDF export did not create $outputPath"
}

Write-Host "Created PDF at $outputPath"
