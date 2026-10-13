param(
    [string]$RuntimeRoot = "",
    [string]$McpCli = "",
    [string]$ProfilePath = "",
    [string]$NodePath = "",
    [int]$Port = 0,
    [switch]$Headless,
    [ValidateRange(0, 300)]
    [int]$RestartDelaySeconds = 3,
    [ValidateRange(-1, 1000000)]
    [int]$MaxRestarts = -1,
    # Loopback port of the live dashboard shown in the launch tab: -1 uses
    # PLAYWRIGHT_MCP_SHARED_DASHBOARD_PORT or 8932, and 0 turns it off.
    [ValidateRange(-1, 65535)]
    [int]$DashboardPort = -1,
    [ValidateSet("", "when-running", "always")]
    [string]$DashboardAttach = ""
)

$ErrorActionPreference = "Stop"

function Write-DiagnosticError {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
}

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

function Write-OwnedPidFile {
    param([string]$Path, [int]$Value)
    [IO.File]::WriteAllText($Path, [string]$Value, [Text.UTF8Encoding]::new($false))
}

function Remove-OwnedPidFile {
    # Delete a PID file only while it still records this launcher's value, so a
    # failed or superseded launcher never erases another supervisor's state.
    param([string]$Path, [int]$Value)
    if ($Value -le 0 -or -not [IO.File]::Exists($Path)) {
        return
    }
    try {
        if ([IO.File]::ReadAllText($Path).Trim() -eq [string]$Value) {
            [IO.File]::Delete($Path)
        }
    }
    catch {
        # Leave an unreadable PID file in place rather than guess its owner.
    }
}

function Get-LoopbackListenerPid {
    param([int]$TargetPort)
    try {
        $Listener = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::", "::1") } |
            Select-Object -First 1
    }
    catch {
        # Without the TCP table the loopback probe below still guards the port.
        return 0
    }
    if ($Listener) {
        return [int]$Listener.OwningProcess
    }
    return 0
}

function Test-ManagedNodeProcess {
    # A managed node is node.exe running this runtime's MCP CLI for this profile
    # and port. Anything else holding the port is never adopted.
    param([int]$ProcessId, [string]$Cli, [string]$ProfileArgument, [int]$TargetPort)
    if ($ProcessId -le 0) {
        return $false
    }
    $Candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $Candidate -or $Candidate.Name -ne "node.exe" -or [string]::IsNullOrWhiteSpace($Candidate.CommandLine)) {
        return $false
    }
    $CommandLine = $Candidate.CommandLine
    return (
        $CommandLine.IndexOf($Cli, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $CommandLine.IndexOf($ProfileArgument, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $CommandLine -match ("--port\s+{0}(\s|$)" -f $TargetPort)
    )
}

function Test-ManagedDashboardProcess {
    # A managed dashboard is node.exe running this launcher's dashboard script
    # on the configured dashboard port.
    param([int]$ProcessId, [string]$Script, [int]$TargetPort)
    if ($ProcessId -le 0) {
        return $false
    }
    $Candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $Candidate -or $Candidate.Name -ne "node.exe" -or [string]::IsNullOrWhiteSpace($Candidate.CommandLine)) {
        return $false
    }
    return (
        $Candidate.CommandLine.IndexOf($Script, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $Candidate.CommandLine -match ("--port\s+{0}(\s|$)" -f $TargetPort)
    )
}

try {
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

    # Take the singleton lock before any logging or state change. The service
    # task relaunches the wrapper on a repeating trigger, so a launch that finds
    # a live supervisor must exit successfully and leave no trace.
    $LocksRoot = Join-Path $RuntimeRoot "locks"
    $null = [IO.Directory]::CreateDirectory($LocksRoot)
    $LockPath = Join-Path $LocksRoot "shared-server.lock"
    try {
        $LockStream = [IO.File]::Open(
            $LockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch [IO.IOException] {
        Write-DiagnosticError "The shared Playwright MCP server is already running."
        exit 0
    }

    $EarlyLogsRoot = Join-Path $RuntimeRoot "logs"
    $null = [IO.Directory]::CreateDirectory($EarlyLogsRoot)
    $BootstrapLog = Join-Path $EarlyLogsRoot "shared-server.bootstrap.log"
    function Write-Bootstrap {
        param([string]$Message)
        [IO.File]::AppendAllText(
            $BootstrapLog,
            ("{0:o} {1}{2}" -f [DateTime]::UtcNow, $Message, [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
    }
    Write-Bootstrap "runtime resolved"

    if ([string]::IsNullOrWhiteSpace($McpCli)) {
        if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_CLI)) {
            $McpCli = $env:PLAYWRIGHT_MCP_SHARED_CLI
        }
        else {
            $McpCli = Join-Path $RuntimeRoot "package\node_modules\@playwright\mcp\cli.js"
        }
    }
    $McpCli = [IO.Path]::GetFullPath($McpCli)
    if (-not [IO.File]::Exists($McpCli)) {
        throw "Pinned Playwright MCP CLI is missing at '$McpCli'. Run playwright-mcp-shared:setup."
    }
    Write-Bootstrap "MCP CLI verified"

    if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
        if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_PROFILE)) {
            $ProfilePath = $env:PLAYWRIGHT_MCP_SHARED_PROFILE
        }
        else {
            $ProfilePath = Join-Path $RuntimeRoot "profiles\shared"
        }
    }
    $ProfilePath = [IO.Path]::GetFullPath($ProfilePath)
    Write-Bootstrap "profile selected"

    if ($Port -eq 0) {
        if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_PORT)) {
            $Port = [int]$env:PLAYWRIGHT_MCP_SHARED_PORT
        }
        else {
            $Port = 8931
        }
    }
    if ($Port -lt 1024 -or $Port -gt 65535) {
        throw "The shared Playwright MCP port must be between 1024 and 65535."
    }

    if ($DashboardPort -lt 0) {
        if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_DASHBOARD_PORT)) {
            $DashboardPort = [int]$env:PLAYWRIGHT_MCP_SHARED_DASHBOARD_PORT
        }
        else {
            $DashboardPort = 8932
        }
    }
    if ($DashboardPort -ne 0 -and ($DashboardPort -lt 1024 -or $DashboardPort -gt 65535 -or $DashboardPort -eq $Port)) {
        throw "The dashboard port must be 0 (off) or a port between 1024 and 65535 other than the service port."
    }
    $DashboardScript = Join-Path $PSScriptRoot "playwright-mcp-dashboard.mjs"

    $OutputsRoot = Join-Path $RuntimeRoot "outputs\shared"
    $LogsRoot = Join-Path $RuntimeRoot "logs"
    $StateRoot = Join-Path $RuntimeRoot "state"
    foreach ($Directory in @($OutputsRoot, $LogsRoot, $StateRoot, $ProfilePath)) {
        $null = [IO.Directory]::CreateDirectory($Directory)
    }
    Write-Bootstrap "runtime directories ready"
    Write-Bootstrap "singleton lock acquired"

    $PidPath = Join-Path $StateRoot "shared-server.pid"
    $NodePidPath = Join-Path $StateRoot "shared-node.pid"
    $DashboardPidPath = Join-Path $StateRoot "dashboard.pid"
    $ServerPidWritten = $false
    $OwnNodePid = 0
    $DashboardProcess = $null
    $OwnDashboardPid = 0
    $DashboardNextStart = [DateTime]::MinValue
    $DashboardBackoffSeconds = 5
    if ($DashboardPort -ne 0 -and -not [IO.File]::Exists($DashboardScript)) {
        Write-Bootstrap "dashboard script missing; dashboard disabled"
        $DashboardPort = 0
    }

    # Keep the dashboard running beside the node. It reconnects to the service
    # on its own, so a node restart does not restart it. A dashboard left by a
    # previous supervisor is adopted like the node.
    function Ensure-Dashboard {
        if ($DashboardPort -eq 0) {
            return
        }
        if ($script:DashboardProcess -and -not $script:DashboardProcess.HasExited) {
            return
        }
        if ($script:DashboardProcess) {
            Write-Bootstrap "dashboard process exited; restarting after $script:DashboardBackoffSeconds seconds"
            Remove-OwnedPidFile -Path $DashboardPidPath -Value $script:OwnDashboardPid
            $script:OwnDashboardPid = 0
            $script:DashboardProcess = $null
            $script:DashboardNextStart = [DateTime]::UtcNow.AddSeconds($script:DashboardBackoffSeconds)
            $script:DashboardBackoffSeconds = [Math]::Min(300, $script:DashboardBackoffSeconds * 2)
            return
        }
        if ([DateTime]::UtcNow -lt $script:DashboardNextStart) {
            return
        }
        if ([IO.File]::Exists($DashboardPidPath)) {
            $RecordedDashboard = 0
            $null = [int]::TryParse([IO.File]::ReadAllText($DashboardPidPath).Trim(), [ref]$RecordedDashboard)
            if (Test-ManagedDashboardProcess -ProcessId $RecordedDashboard -Script $DashboardScript -TargetPort $DashboardPort) {
                $script:DashboardProcess = [Diagnostics.Process]::GetProcessById($RecordedDashboard)
                $script:OwnDashboardPid = $RecordedDashboard
                Write-Bootstrap "dashboard process adopted"
                return
            }
        }
        if ([string]::IsNullOrWhiteSpace($script:ResolvedNodePath)) {
            $script:ResolvedNodePath = Resolve-NodeExecutable -PreferredPath $NodePath
        }
        $DashboardArguments = @(
            ('"{0}"' -f $DashboardScript),
            "--runtime-root", ('"{0}"' -f $RuntimeRoot),
            "--mcp-port", [string]$Port,
            "--port", [string]$DashboardPort,
            "--profile", ('"{0}"' -f $ProfilePath),
            "--node-pid-file", ('"{0}"' -f $NodePidPath),
            "--mcp-cli", ('"{0}"' -f $McpCli)
        )
        if (-not [string]::IsNullOrWhiteSpace($DashboardAttach)) {
            $DashboardArguments += @("--attach", $DashboardAttach)
        }
        $script:DashboardProcess = Start-Process `
            -FilePath $script:ResolvedNodePath `
            -ArgumentList $DashboardArguments `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogsRoot "dashboard.stdout.log") `
            -RedirectStandardError (Join-Path $LogsRoot "dashboard.stderr.log") `
            -PassThru
        $script:OwnDashboardPid = $script:DashboardProcess.Id
        Write-OwnedPidFile -Path $DashboardPidPath -Value $script:OwnDashboardPid
        Write-Bootstrap "dashboard process started"
    }

    try {
        $ProfileArgument = $ProfilePath.Replace("\", "/")
        $OutputArgument = $OutputsRoot.Replace("\", "/")

        # A previous supervisor can die (console closed, process killed) while
        # its node keeps serving. Adopt that node instead of failing on the port.
        $AdoptedProcess = $null
        Write-Bootstrap "probing loopback port"
        $ListenerPid = Get-LoopbackListenerPid -TargetPort $Port
        if ($ListenerPid -eq 0 -and [IO.File]::Exists($NodePidPath)) {
            $RecordedPid = 0
            $null = [int]::TryParse([IO.File]::ReadAllText($NodePidPath).Trim(), [ref]$RecordedPid)
            if (Test-ManagedNodeProcess -ProcessId $RecordedPid -Cli $McpCli -ProfileArgument $ProfileArgument -TargetPort $Port) {
                # The recorded node may still be starting; give it bounded time to bind.
                Write-Bootstrap "recorded Playwright MCP node process is alive but not listening; waiting"
                $Deadline = [DateTime]::UtcNow.AddSeconds(30)
                while ($ListenerPid -eq 0 -and [DateTime]::UtcNow -lt $Deadline -and
                    (Get-Process -Id $RecordedPid -ErrorAction SilentlyContinue)) {
                    Start-Sleep -Milliseconds 500
                    $ListenerPid = Get-LoopbackListenerPid -TargetPort $Port
                }
            }
        }
        if ($ListenerPid -ne 0) {
            if (-not (Test-ManagedNodeProcess -ProcessId $ListenerPid -Cli $McpCli -ProfileArgument $ProfileArgument -TargetPort $Port)) {
                $ListenerName = (Get-Process -Id $ListenerPid -ErrorAction SilentlyContinue).ProcessName
                throw "Loopback port $Port is already in use by process $ListenerPid ($ListenerName), which is not this runtime's managed Playwright MCP node."
            }
            $AdoptedProcess = [Diagnostics.Process]::GetProcessById($ListenerPid)
            # Open the handle now so the exit code stays readable after exit.
            $null = $AdoptedProcess.Handle
            Write-Bootstrap "loopback port owned by the managed Playwright MCP node process"
        }
        else {
            $PortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
            try {
                $PortProbe.Start()
            }
            catch [Net.Sockets.SocketException] {
                throw "Loopback port $Port is already in use."
            }
            finally {
                $PortProbe.Stop()
            }
            Write-Bootstrap "loopback port available"
        }

        Write-OwnedPidFile -Path $PidPath -Value $PID
        $ServerPidWritten = $true

        $StdoutLog = Join-Path $LogsRoot "shared-server.stdout.log"
        $StderrLog = Join-Path $LogsRoot "shared-server.stderr.log"
        $env:PLAYWRIGHT_MCP_PING_TIMEOUT_MS = "0"

        $McpArguments = @(
            ('"{0}"' -f $McpCli),
            "--browser", "chrome",
            "--user-data-dir", ('"{0}"' -f $ProfileArgument),
            "--output-dir", ('"{0}"' -f $OutputArgument),
            "--port", [string]$Port,
            "--host", "127.0.0.1",
            "--shared-browser-context"
        )
        if ($Headless) {
            $McpArguments += "--headless"
        }
        $ResolvedNodePath = ""

        $RestartCount = 0
        while ($true) {
            if ($AdoptedProcess) {
                $NodeProcess = $AdoptedProcess
                $AdoptedProcess = $null
                Write-Bootstrap "Playwright MCP node process adopted"
            }
            else {
                if ([string]::IsNullOrWhiteSpace($ResolvedNodePath)) {
                    $ResolvedNodePath = Resolve-NodeExecutable -PreferredPath $NodePath
                    Write-Bootstrap "Node.js executable verified"
                }
                Write-Bootstrap "starting Playwright MCP node process"
                $NodeProcess = Start-Process `
                    -FilePath $ResolvedNodePath `
                    -ArgumentList $McpArguments `
                    -WindowStyle Hidden `
                    -RedirectStandardOutput $StdoutLog `
                    -RedirectStandardError $StderrLog `
                    -PassThru
                Write-Bootstrap "Playwright MCP node process started"
            }
            try {
                $OwnNodePid = $NodeProcess.Id
                Write-OwnedPidFile -Path $NodePidPath -Value $OwnNodePid
                Ensure-Dashboard
                while (-not $NodeProcess.WaitForExit(2000)) {
                    Ensure-Dashboard
                }
                $NodeProcess.WaitForExit()
                $NodeProcess.Refresh()
                try {
                    $NodeExitCode = $NodeProcess.ExitCode
                }
                catch {
                    $NodeExitCode = "unknown"
                }
            }
            finally {
                Remove-OwnedPidFile -Path $NodePidPath -Value $OwnNodePid
                $OwnNodePid = 0
            }

            if ($MaxRestarts -ge 0 -and $RestartCount -ge $MaxRestarts) {
                Write-Bootstrap "Playwright MCP node process exited with code $NodeExitCode; restart limit reached"
                if ($NodeExitCode -is [int]) {
                    exit $NodeExitCode
                }
                exit 1
            }

            $RestartCount++
            Write-Bootstrap "Playwright MCP node process exited with code $NodeExitCode; restarting after $RestartDelaySeconds seconds"
            if ($RestartDelaySeconds -gt 0) {
                Start-Sleep -Seconds $RestartDelaySeconds
            }
        }
    }
    finally {
        if ($ServerPidWritten) {
            Remove-OwnedPidFile -Path $PidPath -Value $PID
        }
        Remove-OwnedPidFile -Path $NodePidPath -Value $OwnNodePid
        if ($DashboardProcess -and -not $DashboardProcess.HasExited) {
            Stop-Process -Id $DashboardProcess.Id -Force -ErrorAction SilentlyContinue
        }
        Remove-OwnedPidFile -Path $DashboardPidPath -Value $OwnDashboardPid
        $LockStream.Dispose()
    }
}
catch {
    $FailureMessage = "Shared Playwright MCP launcher failed: $($_.Exception.Message)"
    try {
        if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) {
            $FailureLogsRoot = Join-Path ([IO.Path]::GetFullPath($RuntimeRoot)) "logs"
            $null = [IO.Directory]::CreateDirectory($FailureLogsRoot)
            [IO.File]::AppendAllText(
                (Join-Path $FailureLogsRoot "shared-server.bootstrap.log"),
                ("{0:o} {1}{2}" -f [DateTime]::UtcNow, $FailureMessage, [Environment]::NewLine),
                [Text.UTF8Encoding]::new($false)
            )
        }
    }
    catch {
        # Preserve the original startup failure when diagnostic logging also fails.
    }
    Write-DiagnosticError $FailureMessage
    exit 70
}
