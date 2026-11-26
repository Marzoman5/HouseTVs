<#
  HouseTVs one-shot installer (Windows house server).
  Run from the repo root:   powershell -ExecutionPolicy Bypass -File .\setup.ps1
  Does: npm install -> discover TV -> firewall rule -> boot auto-start task -> start server.
  Re-running is safe (idempotent).
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,
  [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

# Re-launch elevated so the firewall rule + scheduled task can be created.
if (-not (Test-Admin)) {
  Write-Host "Requesting administrator rights (firewall + auto-start)..." -ForegroundColor Yellow
  $argList = @('-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-Port',$Port)
  if ($NoAutoStart) { $argList += '-NoAutoStart' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
  exit
}

Write-Host "== HouseTVs setup ==" -ForegroundColor Cyan

# 1) Node check
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "Node.js not found. Install Node 18+ from https://nodejs.org and re-run." }
Write-Host ("Node: " + (node -v))

# 2) Dependencies
Write-Host "Installing dependencies..."
npm install --no-fund --no-audit | Out-Null

# 3) Discover the TV (skip if config.json already present)
if (Test-Path (Join-Path $Root 'config.json')) {
  Write-Host "config.json already exists - leaving it as is."
} else {
  Write-Host "Discovering the TV on your network..."
  node scripts/discover.js
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Auto-discovery failed. Copy config.example.json to config.json and fill in tvIp/tvMac, then re-run."
    exit 1
  }
}

# 4) Firewall rule (LAN only)
$ruleName = 'HouseTVs Controller ' + $Port
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Any -RemoteAddress LocalSubnet | Out-Null
  Write-Host "Firewall rule added (TCP $Port, LocalSubnet)."
} else {
  Write-Host "Firewall rule already present."
}

# 4b) Alexa (WeMo emulation) needs SSDP (UDP 1900) + device ports (TCP 4000-4015)
if (-not (Get-NetFirewallRule -DisplayName 'HouseTVs Alexa SSDP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'HouseTVs Alexa SSDP' -Direction Inbound -Action Allow `
    -Protocol UDP -LocalPort 1900 -Profile Any -RemoteAddress LocalSubnet | Out-Null
  New-NetFirewallRule -DisplayName 'HouseTVs Alexa Devices' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 4000-4015 -Profile Any -RemoteAddress LocalSubnet | Out-Null
  Write-Host "Alexa firewall rules added (UDP 1900, TCP 4000-4015)."
} else {
  Write-Host "Alexa firewall rules already present."
}

# 5) Auto-start at boot via Scheduled Task (always-on house server)
if (-not $NoAutoStart) {
  $taskName = 'HouseTVs'
  $nodePath = $node.Source
  $action = New-ScheduledTaskAction -Execute $nodePath -Argument 'server.js' -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Auto-start task '$taskName' registered (runs at boot)."
}

# 6) Start it now (background)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden
Start-Sleep -Seconds 2

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } |
  Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "Done. Open the controller at:  http://${ip}:$Port" -ForegroundColor Green
Write-Host "First use: click 'Pair', then accept the Allow prompt ON the TV." -ForegroundColor Green
