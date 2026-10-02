$ErrorActionPreference = "Stop"

$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$ConfigPath = Join-Path $RuntimeRoot "state\windows-service-config.json"
$LauncherPath = Join-Path $PSScriptRoot "playwright-mcp-shared.ps1"

if (-not [IO.File]::Exists($ConfigPath)) {
    throw "The shared-browser Windows service configuration is missing at '$ConfigPath'."
}
if (-not [IO.File]::Exists($LauncherPath)) {
    throw "The shared-browser launcher is missing at '$LauncherPath'."
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$LauncherArguments = @{
    RuntimeRoot = [string]$Config.RuntimeRoot
    ProfilePath = [string]$Config.ProfilePath
    NodePath = [string]$Config.NodePath
    Port = [int]$Config.Port
}

& $LauncherPath @LauncherArguments
exit $LASTEXITCODE
