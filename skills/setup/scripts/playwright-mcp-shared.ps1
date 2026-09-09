param(
    [string]$RuntimeRoot = "",
    [string]$McpCli = "",
    [string]$ProfilePath = "",
    [int]$Port = 0,
    [switch]$Headless
)

$ErrorActionPreference = "Stop"

function Write-DiagnosticError {
    param([string]$Message)
    [Console]::Error.WriteLine($Message)
}

try {
    if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT)) {
            $RuntimeRoot = $env:PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT
        }
        elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            $RuntimeRoot = Join-Path $env:LOCALAPPDATA "playwright-mcp-shared"
        }
        else {
            throw "LOCALAPPDATA is unavailable and PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT is not set."
        }
    }
    $RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
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

    $LocksRoot = Join-Path $RuntimeRoot "locks"
    $OutputsRoot = Join-Path $RuntimeRoot "outputs\shared"
    $LogsRoot = Join-Path $RuntimeRoot "logs"
    $StateRoot = Join-Path $RuntimeRoot "state"
    foreach ($Directory in @($LocksRoot, $OutputsRoot, $LogsRoot, $StateRoot, $ProfilePath)) {
        $null = [IO.Directory]::CreateDirectory($Directory)
    }
    Write-Bootstrap "runtime directories ready"

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
    Write-Bootstrap "singleton lock acquired"

    try {
        Write-Bootstrap "probing loopback port"
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

        $PidPath = Join-Path $StateRoot "shared-server.pid"
        [IO.File]::WriteAllText($PidPath, [string]$PID, [Text.UTF8Encoding]::new($false))

        $ProfileArgument = $ProfilePath.Replace("\", "/")
        $OutputArgument = $OutputsRoot.Replace("\", "/")
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
        $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
        Write-Bootstrap "starting Playwright MCP node process"
        $NodeProcess = Start-Process `
            -FilePath $NodePath `
            -ArgumentList $McpArguments `
            -WindowStyle Hidden `
            -RedirectStandardOutput $StdoutLog `
            -RedirectStandardError $StderrLog `
            -PassThru
        $NodePidPath = Join-Path $StateRoot "shared-node.pid"
        [IO.File]::WriteAllText($NodePidPath, [string]$NodeProcess.Id, [Text.UTF8Encoding]::new($false))
        Write-Bootstrap "Playwright MCP node process started"
        $NodeProcess.WaitForExit()
        $NodeProcess.Refresh()
        exit $NodeProcess.ExitCode
    }
    finally {
        $PidPath = Join-Path $StateRoot "shared-server.pid"
        if ([IO.File]::Exists($PidPath)) {
            [IO.File]::Delete($PidPath)
        }
        $NodePidPath = Join-Path $StateRoot "shared-node.pid"
        if ([IO.File]::Exists($NodePidPath)) {
            [IO.File]::Delete($NodePidPath)
        }
        $LockStream.Dispose()
    }
}
catch {
    Write-DiagnosticError "Shared Playwright MCP launcher failed: $($_.Exception.Message)"
    exit 70
}
