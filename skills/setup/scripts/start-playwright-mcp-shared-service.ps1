$ErrorActionPreference = "Stop"

$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$ConfigPath = Join-Path $RuntimeRoot "state\windows-service-config.json"
$StoppedMarkerPath = Join-Path $RuntimeRoot "state\service-stopped"
$LauncherPath = Join-Path $PSScriptRoot "playwright-mcp-shared.ps1"

if (-not [IO.File]::Exists($ConfigPath)) {
    throw "The shared-browser Windows service configuration is missing at '$ConfigPath'."
}
if (-not [IO.File]::Exists($LauncherPath)) {
    throw "The shared-browser launcher is missing at '$LauncherPath'."
}

# The task relaunches this wrapper on a repeating trigger. A managed stop leaves
# a marker so the service stays down until the installer runs again; a reboot
# clears the hold so logon autostart still works.
if ([IO.File]::Exists($StoppedMarkerPath)) {
    $LastBoot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    if ([IO.File]::GetLastWriteTime($StoppedMarkerPath) -gt $LastBoot) {
        exit 0
    }
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$LauncherArguments = @{
    RuntimeRoot = [string]$Config.RuntimeRoot
    ProfilePath = [string]$Config.ProfilePath
    NodePath = [string]$Config.NodePath
    Port = [int]$Config.Port
}
# Optional keys used by disposable test runtimes.
if (-not [string]::IsNullOrWhiteSpace([string]$Config.McpCli)) {
    $LauncherArguments.McpCli = [string]$Config.McpCli
}
if ($Config.Headless -eq $true) {
    $LauncherArguments.Headless = $true
}
# Dashboard settings; an older configuration without them keeps the defaults.
if ($null -ne $Config.DashboardPort) {
    $LauncherArguments.DashboardPort = [int]$Config.DashboardPort
}
if (-not [string]::IsNullOrWhiteSpace([string]$Config.DashboardAttach)) {
    $LauncherArguments.DashboardAttach = [string]$Config.DashboardAttach
}

& $LauncherPath @LauncherArguments
exit $LASTEXITCODE
