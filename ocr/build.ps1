# Build TotemMapWatcher.exe with PyInstaller.
# Run from the ocr/ folder:  .\build.ps1
# Output:  dist\TotemMapWatcher\   (zip this whole folder to share)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host "Cleaning previous build..." -ForegroundColor Cyan
Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue

Write-Host "Running PyInstaller..." -ForegroundColor Cyan
python -m PyInstaller --noconfirm --onedir --name TotemMapWatcher `
  --collect-all easyocr `
  --collect-all torch `
  --collect-all torchvision `
  --add-data "totems.json;." `
  watcher.py

Write-Host ""
Write-Host "Done. Output: $PSScriptRoot\dist\TotemMapWatcher\" -ForegroundColor Green
Write-Host "Zip that folder and share." -ForegroundColor Green
