# ClipForge - setup automatico per Windows (worker su un nuovo PC).
# Uso: apri PowerShell in questa cartella e lancia:
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1
#
# Installa (solo se mancano): Git, Node.js LTS, FFmpeg, yt-dlp.
# Clona il repo, abilita pnpm, installa le dipendenze.
# Dopo lo script vanno comunque copiati a mano i file apps/worker/.env
# (e apps/web/.env.local se serve) - non generati/scaricati da qui.

$ErrorActionPreference = "Stop"

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Install-IfMissing {
    param(
        [string]$Command,
        [string]$WingetId,
        [string]$DisplayName
    )
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        Write-Host "OK: $DisplayName gia' presente" -ForegroundColor Green
        return
    }
    Write-Host "Installo $DisplayName..." -ForegroundColor Yellow
    winget install --id $WingetId -e --accept-package-agreements --accept-source-agreements --silent
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Write-Warning "$DisplayName installato ma non ancora rilevato in PATH in questa finestra. Se i passi successivi falliscono, chiudi e riapri PowerShell e rilancia lo script."
    }
}

Write-Host "=== ClipForge setup ===" -ForegroundColor Cyan

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Error "winget non trovato. Serve Windows 10/11 aggiornato con App Installer (Microsoft Store). Installalo e rilancia lo script."
    exit 1
}

Install-IfMissing -Command "git" -WingetId "Git.Git" -DisplayName "Git"
Install-IfMissing -Command "node" -WingetId "OpenJS.NodeJS.LTS" -DisplayName "Node.js"
Install-IfMissing -Command "ffmpeg" -WingetId "Gyan.FFmpeg" -DisplayName "FFmpeg"
Install-IfMissing -Command "yt-dlp" -WingetId "yt-dlp.yt-dlp" -DisplayName "yt-dlp"

if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Git o Node.js non rilevati dopo l'installazione. Chiudi questa finestra PowerShell, riapri una nuova finestra, e rilancia lo script (serve a volte per far ricomparire il PATH aggiornato)."
    exit 1
}

Write-Host "Abilito corepack/pnpm..." -ForegroundColor Yellow
corepack enable
corepack prepare pnpm@latest --activate

$repoUrl = "https://github.com/aurasimo676767/aiclip.git"
$targetDir = Join-Path (Get-Location) "clipforge"

if (Test-Path $targetDir) {
    Write-Host "La cartella '$targetDir' esiste gia', salto il clone." -ForegroundColor Yellow
} else {
    Write-Host "Clono il repository in '$targetDir'..." -ForegroundColor Yellow
    git clone $repoUrl $targetDir
}

Set-Location $targetDir

Write-Host "Installo le dipendenze (pnpm install)..." -ForegroundColor Yellow
pnpm install

Write-Host ""
Write-Host "=== Fatto! ===" -ForegroundColor Cyan
Write-Host "Ora copia (a mano, ricevuto in modo sicuro, non generato da questo script):"
Write-Host "  $targetDir\apps\worker\.env"
Write-Host "  $targetDir\apps\web\.env.local   (solo se ti serve anche il frontend in locale)"
Write-Host ""
Write-Host "Poi, per avviare il worker:"
Write-Host "  cd $targetDir"
Write-Host "  pnpm dev:worker"
