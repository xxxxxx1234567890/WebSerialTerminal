# encoding: UTF-8 BOM
$ErrorActionPreference = "Stop"
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ("="*44) -ForegroundColor Cyan
Write-Host " WebTerm Pro - Uninstaller" -ForegroundColor Cyan
Write-Host ("="*44) -ForegroundColor Cyan
Write-Host ""

# Remove registry autostart
$regPath = "HKCU:SoftwareMicrosoftWindowsCurrentVersionRun"
try {
    Remove-ItemProperty -Path $regPath -Name "WebTermPro" -ErrorAction Stop
    Write-Host "[OK]  Auto-start removed" -ForegroundColor Green
}
catch {
    Write-Host "[INFO] No autostart entry found" -ForegroundColor DarkGray
}

# Kill running Node.js server
Write-Host "Stopping WebTerm Pro server..." -ForegroundColor Yellow
try {
    $procs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        try {
            if ($p.CommandLine -match "server.js") {
                $p.Kill()
                Write-Host ("[OK]  Terminated PID " + $p.Id) -ForegroundColor Green
            }
        }
        catch { }
    }
}
catch {
    Write-Host "[INFO] No server process found" -ForegroundColor DarkGray
}

# Remove start.vbs
$vbsPath = $installDir + 'start.vbs'
if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force
    Write-Host "[OK]  start.vbs deleted" -ForegroundColor Green
}

Write-Host ""
Write-Host ("="*44) -ForegroundColor Cyan
Write-Host " Uninstall Complete!" -ForegroundColor Cyan
Write-Host ""
Write-Host " To fully remove the PWA app:" -ForegroundColor White
Write-Host " Chrome: chrome://apps -> right-click WebTerm Pro -> Remove" -ForegroundColor White
Write-Host " Edge:   edge://apps -> right-click WebTerm Pro -> Uninstall" -ForegroundColor White
Write-Host ("="*44) -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to exit"
