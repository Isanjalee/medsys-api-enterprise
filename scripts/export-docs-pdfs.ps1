param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$exportScript = Join-Path $PSScriptRoot "export-db-dictionary-pdf.ps1"

$exports = @(
  @{ InputHtml = "docs/MEDSYS_Backend_Client_Specification.html"; OutputPdf = "docs/MEDSYS_Backend_Client_Specification.pdf" },
  @{ InputHtml = "docs/MEDSYS_Backend_Developer_Tracker.html"; OutputPdf = "docs/MEDSYS_Backend_Developer_Tracker.pdf" },
  @{ InputHtml = "docs/MEDSYS_Database_Dictionary.html"; OutputPdf = "docs/MEDSYS_Database_Dictionary.pdf" }
)

foreach ($export in $exports) {
  & $exportScript -InputHtml $export.InputHtml -OutputPdf $export.OutputPdf
}

Write-Host "All documentation PDFs exported successfully."
