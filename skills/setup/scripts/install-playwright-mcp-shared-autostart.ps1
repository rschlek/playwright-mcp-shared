param(
    [string]$RuntimeRoot = "",
    [string]$ProfilePath = "",
    [string]$NodePath = "",
    [int]$Port = 8931,
    # Loopback port of the live dashboard shown in the launch tab; 0 turns it off.
    [ValidateRange(0, 65535)]
    [int]$DashboardPort = 8932,
    [switch]$Start,
    [string]$TaskName = "PlaywrightMCPSharedService",
    [string]$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
    [string]$RunValueName = "PlaywrightMCPShared",
    [ValidateRange(1, 1440)]
    [int]$RelaunchIntervalMinutes = 5
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
    $InstalledRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT)) {
        $RuntimeRoot = $env:PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT
    }
    elseif ((Split-Path -Leaf $PSScriptRoot) -eq "bin" -and
        [IO.File]::Exists((Join-Path $InstalledRoot "state\windows-service-config.json"))) {
        # An installed copy manages the runtime it lives in.
        $RuntimeRoot = $InstalledRoot
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $RuntimeRoot = Join-Path $env:LOCALAPPDATA "playwright-mcp-shared"
    }
    else {
        throw "LOCALAPPDATA is unavailable and PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT is not set."
    }
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

if ($DashboardPort -ne 0 -and ($DashboardPort -lt 1024 -or $DashboardPort -eq $Port)) {
    throw "The dashboard port must be 0 (off) or a port between 1024 and 65535 other than the service port."
}

$StateRoot = Join-Path $RuntimeRoot "state"
$null = [IO.Directory]::CreateDirectory($StateRoot)
$ServiceConfigPath = Join-Path $StateRoot "windows-service-config.json"
$ServiceConfig = [ordered]@{
    RuntimeRoot = $RuntimeRoot
    ProfilePath = $ProfilePath
    NodePath = $NodePath
    Port = $Port
    DashboardPort = $DashboardPort
} | ConvertTo-Json
[IO.File]::WriteAllText(
    $ServiceConfigPath,
    $ServiceConfig,
    [Text.UTF8Encoding]::new($false)
)

$PowerShellArguments = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", ('"{0}"' -f $ServiceScript)
) -join " "

# When Windows Terminal is the default console host, -WindowStyle Hidden does
# not hide the console: a terminal window opens for the service's lifetime, and
# closing it kills the supervisor. A headless console host never creates a
# window and keeps the task running in the interactive session.
$ConsoleHostPath = ""
if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
    $ConsoleHostPath = Join-Path $env:SystemRoot "System32\conhost.exe"
}
if (-not [string]::IsNullOrWhiteSpace($ConsoleHostPath) -and [IO.File]::Exists($ConsoleHostPath)) {
    $TaskExecute = $ConsoleHostPath
    $TaskArguments = '--headless "{0}" {1}' -f $PowerShellPath, $PowerShellArguments
}
else {
    $TaskExecute = $PowerShellPath
    $TaskArguments = $PowerShellArguments
}

$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction `
    -Execute $TaskExecute `
    -Argument $TaskArguments
# Logon starts the service. The repeating trigger relaunches the wrapper so a
# supervisor that died is replaced; while one is alive the task instance is
# still running and IgnoreNew skips the tick, and a launch outside the task
# finds the singleton lock held and exits quietly.
$Triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $UserId),
    (New-ScheduledTaskTrigger `
        -Once `
        -At ([DateTime]::Now.AddMinutes($RelaunchIntervalMinutes)) `
        -RepetitionInterval (New-TimeSpan -Minutes $RelaunchIntervalMinutes))
)
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
    -Trigger $Triggers `
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

# Registering the task is the intent to run it again after a managed stop.
$StoppedMarkerPath = Join-Path $StateRoot "service-stopped"
if ([IO.File]::Exists($StoppedMarkerPath)) {
    [IO.File]::Delete($StoppedMarkerPath)
}

if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
}

[pscustomobject]@{
    TaskName = $TaskName
    UserId = $UserId
    RuntimeRoot = $RuntimeRoot
    PowerShellPath = $PowerShellPath
    TaskExecute = $TaskExecute
    TaskArguments = $TaskArguments
    NodePath = $NodePath
    ProfilePath = $ProfilePath
    Port = $Port
    DashboardPort = $DashboardPort
    ServiceConfigPath = $ServiceConfigPath
    Started = [bool]$Start
}
