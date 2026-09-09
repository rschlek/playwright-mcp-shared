param(
    [string]$RuntimeRoot = "",
    [string]$ProfilePath = "",
    [int]$Port = 8931,
    [switch]$Start
)

$ErrorActionPreference = "Stop"
$RunValueName = "PlaywrightMCPShared"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is unavailable."
    }
    $RuntimeRoot = Join-Path $env:LOCALAPPDATA "playwright-mcp-shared"
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)

if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
    $ProfilePath = Join-Path $RuntimeRoot "profiles\shared"
}
$ProfilePath = [IO.Path]::GetFullPath($ProfilePath)

$ServerScript = Join-Path $RuntimeRoot "bin\playwright-mcp-shared.ps1"
if (-not [IO.File]::Exists($ServerScript)) {
    throw "The installed shared-server launcher is missing at '$ServerScript'."
}

$PowerShellPath = Join-Path $PSHOME "powershell.exe"
$ArgumentList = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", ('"{0}"' -f $ServerScript),
    "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
    "-ProfilePath", ('"{0}"' -f $ProfilePath),
    "-Port", [string]$Port
) -join " "
$RunCommand = ('"{0}" {1}' -f $PowerShellPath, $ArgumentList)

$null = New-Item -Path $RunKey -Force
$null = New-ItemProperty `
    -Path $RunKey `
    -Name $RunValueName `
    -Value $RunCommand `
    -PropertyType String `
    -Force

if ($Start) {
    Start-Process `
        -FilePath $PowerShellPath `
        -ArgumentList $ArgumentList `
        -WindowStyle Hidden
}

[pscustomobject]@{
    RunValue = $RunValueName
    ProfilePath = $ProfilePath
    Port = $Port
    Started = [bool]$Start
}
