# CHLOE local dev server — no install needed beyond Node OR Python.
# Usage: ./dev.ps1  (serves this folder on http://localhost:8080)
$port = 8080
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "CHLOE dev server -> http://localhost:$port/  (game: /game/)  Ctrl+C stops." -ForegroundColor Red
$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx -and (Test-Path "$env:ProgramFiles\nodejs\npx.cmd")) { $npx = @{ Source = "$env:ProgramFiles\nodejs\npx.cmd" } }
if ($npx) {
  & $npx.Source --yes http-server -p $port -c-1 $here
} else {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if ($py) { Push-Location $here; python -m http.server $port; Pop-Location }
  else { Write-Host "Install Node.js (winget install OpenJS.NodeJS.LTS) or Python, then re-run." -ForegroundColor Yellow }
}
