# generate-image.ps1 — free, keyless image generation via Pollinations.ai (flux model)
# Windows PowerShell 5.1 compatible.
# Usage: powershell -File generate-image.ps1 -prompt "a red door" -out "C:\path\img.jpg" [-w 768] [-h 768]

param(
    [Parameter(Mandatory = $true)][string]$prompt,
    [Parameter(Mandatory = $true)][string]$out,
    [int]$w = 768,
    [int]$h = 768
)

$ErrorActionPreference = 'Stop'

# Ensure the output directory exists
$outDir = Split-Path -Parent $out
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$encoded = [uri]::EscapeDataString($prompt)
$url = "https://image.pollinations.ai/prompt/$encoded" + "?width=$w&height=$h&model=flux&nologo=true"

# TLS 1.2 for older .NET defaults on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$maxAttempts = 3
$success = $false

for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Write-Host "Attempt $attempt of $maxAttempts : generating image (20-60s typical)..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $out -TimeoutSec 120 -UseBasicParsing
    } catch {
        Write-Host "  Request failed: $($_.Exception.Message)"
    }

    if ((Test-Path $out) -and ((Get-Item $out).Length -gt 20KB) ) {
        $kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
        Write-Host "  OK: $out ($kb KB)"
        $success = $true
        break
    }

    # Remove undersized/partial file before retrying
    if (Test-Path $out) { Remove-Item $out -Force -Confirm:$false }
    Write-Host "  File missing or too small (<20KB); retrying..."
}

if (-not $success) {
    Write-Error "Failed to generate image after $maxAttempts attempts: $out"
    exit 1
}

exit 0
