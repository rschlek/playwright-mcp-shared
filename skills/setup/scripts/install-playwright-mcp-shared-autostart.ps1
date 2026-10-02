param(
    [string]$RuntimeRoot = "",
    [string]$ProfilePath = "",
    [string]$NodePath = "",
    [int]$Port = 8931,
    [switch]$Start,
    [string]$TaskName = "PlaywrightMCPSharedService",
    [string]$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
    [string]$RunValueName = "PlaywrightMCPShared"
)

$ErrorActionPreference = "Stop"

function Resolve-NodeExecutable {
    param([string]$PreferredPath)

    $Candidates = [Collections.Generic.List[string]]::new()
    foreach ($Candidate in @(
        $PreferredPath,
        $env:PLAYWRIGHT_MCP_SHARED_NODE,
        $(if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
            Join-Path $env:ProgramFiles "nodejs\node.exe"
        }),
        $(if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
            Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"
        }),
        $(if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
        })
    )) {
        if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
            $Candidates.Add($Candidate)
        }
    }

    $Command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Command) {
        $Candidates.Add($Command.Source)
    }

    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $CodexRuntimes = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
        if ([IO.Directory]::Exists($CodexRuntimes)) {
            Get-ChildItem -LiteralPath $CodexRuntimes -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending |
                ForEach-Object {
                    $Candidates.Add((Join-Path $_.FullName "dependencies\node\bin\node.exe"))
                }
        }
    }

    foreach ($Candidate in $Candidates) {
        $FullPath = [IO.Path]::GetFullPath($Candidate)
        if ([IO.File]::Exists($FullPath)) {
            return $FullPath
        }
    }

    throw "Node.js could not be resolved. Install Node.js or re-run playwright-mcp-shared:setup from Codex."
}

function Resolve-TaskVisiblePath {
    param([string]$Path)

    $FullPath = [IO.Path]::GetFullPath($Path)
    $PackageFamily = $env:CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY
    if ([string]::IsNullOrWhiteSpace($PackageFamily) -or [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        return $FullPath
    }

    $LocalAppDataRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd("\") + "\"
    if (-not $FullPath.StartsWith($LocalAppDataRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $FullPath
    }

    $RelativePath = $FullPath.Substring($LocalAppDataRoot.Length)
    $PhysicalRoot = Join-Path $env:LOCALAPPDATA "Packages\$PackageFamily\LocalCache\Local"
    $PhysicalPath = [IO.Path]::GetFullPath((Join-Path $PhysicalRoot $RelativePath))
    if (Test-Path -LiteralPath $PhysicalPath) {
        return $PhysicalPath
    }

    return $FullPath
}

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

# Codex Desktop redirects user-writable LocalAppData into its MSIX LocalCache.
# A scheduled task is outside that package identity, so register physical paths
# that both the task and the interactive Codex process can resolve.
$RuntimeRoot = Resolve-TaskVisiblePath -Path $RuntimeRoot
$ProfilePath = Resolve-TaskVisiblePath -Path $ProfilePath

$ServerScript = Join-Path $RuntimeRoot "bin\playwright-mcp-shared.ps1"
if (-not [IO.File]::Exists($ServerScript)) {
    throw "The installed shared-server launcher is missing at '$ServerScript'."
}
$ServiceScript = Join-Path $RuntimeRoot "bin\start-playwright-mcp-shared-service.ps1"
if (-not [IO.File]::Exists($ServiceScript)) {
    throw "The installed shared-server service wrapper is missing at '$ServiceScript'."
}

$WindowsPowerShellPath = ""
if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
    $WindowsPowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
}
if ([string]::IsNullOrWhiteSpace($WindowsPowerShellPath) -or -not [IO.File]::Exists($WindowsPowerShellPath)) {
    $WindowsPowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
}
$PowerShellPath = [IO.Path]::GetFullPath($WindowsPowerShellPath)

$NodePath = Resolve-NodeExecutable -PreferredPath $NodePath

$StateRoot = Join-Path $RuntimeRoot "state"
$null = [IO.Directory]::CreateDirectory($StateRoot)
$ServiceConfigPath = Join-Path $StateRoot "windows-service-config.json"
$ServiceConfig = [ordered]@{
    RuntimeRoot = $RuntimeRoot
    ProfilePath = $ProfilePath
    NodePath = $NodePath
    Port = $Port
} | ConvertTo-Json
[IO.File]::WriteAllText(
    $ServiceConfigPath,
    $ServiceConfig,
    [Text.UTF8Encoding]::new($false)
)

$ArgumentList = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", ('"{0}"' -f $ServiceScript)
) -join " "

$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction `
    -Execute $PowerShellPath `
    -Argument $ArgumentList
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

$null = Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Owns the loopback-only shared Playwright MCP service; performs no scheduled browsing." `
    -Force

# Remove the legacy Run entry only after the replacement task is registered.
if (Test-Path -LiteralPath $RunKey) {
    Remove-ItemProperty `
        -LiteralPath $RunKey `
        -Name $RunValueName `
        -ErrorAction SilentlyContinue
}

if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
}

[pscustomobject]@{
    TaskName = $TaskName
    UserId = $UserId
    RuntimeRoot = $RuntimeRoot
    PowerShellPath = $PowerShellPath
    NodePath = $NodePath
    ProfilePath = $ProfilePath
    Port = $Port
    ServiceConfigPath = $ServiceConfigPath
    Started = [bool]$Start
}
