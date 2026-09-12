# encoding: UTF-8 BOM
$ErrorActionPreference = "Stop"
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ("="*44) -ForegroundColor Cyan
Write-Host " WebTerm Pro - Desktop App Installer" -ForegroundColor Cyan
Write-Host ("="*44) -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = & node --version
    Write-Host "[OK]  Node.js " ($nodeVersion) -ForegroundColor Green
}
catch {
    Write-Host "[ERROR] Node.js not found" -ForegroundColor Red
    Write-Host "Download: https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Generate start.vbs
$serverPath = Join-Path $installDir 'server.js'
$vbsPath = Join-Path $installDir 'start.vbs'
$vbsContent = 'CreateObject("WScript.Shell").Run "node ""' + $serverPath + '""", 0, False'
Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII
Write-Host "[OK]  start.vbs generated" -ForegroundColor Green

# Add to registry autostart
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
try {
    Set-ItemProperty -Path $regPath -Name "WebTermPro" -Value ('wscript.exe "' + $vbsPath + '"') -Type String -ErrorAction Stop
    Write-Host "[OK]  Auto-start added" -ForegroundColor Green
}
catch {
    Write-Host "[WARN] Cannot write to registry" -ForegroundColor Yellow
}

# Start server
Start-Process -FilePath "wscript.exe" -ArgumentList ('"' + $installDir + 'start.vbs"') -WindowStyle Hidden
Write-Host "[OK]  Server started" -ForegroundColor Green

# Wait for server ready
$maxWait = 10
$serverReady = $false
for ($i = 1; $i -le $maxWait; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:1982" -TimeoutSec 1 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            $serverReady = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 1
    }
}

if ($serverReady) {
    Write-Host "[OK]  Server ready at http://localhost:1982" -ForegroundColor Green
}
else {
    Write-Host "[WARN] Server start timeout" -ForegroundColor Yellow
}

# Open browser
Start-Process "http://localhost:1982"

Write-Host ""
Write-Host ("="*44) -ForegroundColor Cyan
Write-Host " Installation Complete!" -ForegroundColor Cyan
Write-Host ""
Write-Host " In the browser window:" -ForegroundColor White
Write-Host " 1. Click install prompt at bottom-right" -ForegroundColor White
Write-Host " 2. Or click install icon in address bar" -ForegroundColor White
Write-Host " 3. Pin to taskbar after installation" -ForegroundColor White
Write-Host ("="*44) -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to exit"
