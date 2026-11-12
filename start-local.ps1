# Sobe o Mini DM local (painel de postagens) em http://localhost:3781
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$tmp = Join-Path $env:TEMP "minidm-local-env"
New-Item -ItemType Directory -Force $tmp | Out-Null
Push-Location $tmp
shardcloud app env pull --app 9dc7249b-814e-4098-b024-17b5b7cbd293 | Out-Null
Pop-Location
$lines = Get-Content (Join-Path $tmp ".env")
function Get-EnvVar($name) { (($lines | Where-Object { $_ -match "^$name=" }) -replace "^$name=",'').Trim('"') }
$env:INSTAGRAM_ACCESS_TOKEN = Get-EnvVar "INSTAGRAM_ACCESS_TOKEN"
$env:INSTAGRAM_ACCOUNT = Get-EnvVar "INSTAGRAM_ACCOUNT"
$env:INSTAGRAM_BUSINESS_ID = Get-EnvVar "INSTAGRAM_BUSINESS_ID"
$env:LOGIN_DISABLED = "true"
$env:MINI_DM_NO_OPEN = "1"
$env:PORT = "3781"
$env:MINI_DM_DATA = Join-Path $env:TEMP "minidm-posts-data"
Write-Host "Mini DM local em http://localhost:3781  (Ctrl+C para parar)"
node server.js
