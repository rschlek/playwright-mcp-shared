param(
    [string]$RuntimeRoot = "",
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
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
$StateRoot = Join-Path $RuntimeRoot "state"
$ConfigPath = Join-Path $StateRoot "windows-service-config.json"
$ExpectedCli = Join-Path $RuntimeRoot "package\node_modules\@playwright\mcp\cli.js"
if ([IO.File]::Exists($ConfigPath)) {
    $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if (-not [string]::IsNullOrWhiteSpace([string]$Config.McpCli)) {
        $ExpectedCli = [IO.Path]::GetFullPath([string]$Config.McpCli)
    }
    if ($Port -eq 0 -and [int]$Config.Port -gt 0) {
        $Port = [int]$Config.Port
    }
}
if ($Port -eq 0) {
    if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_PORT)) {
        $Port = [int]$env:PLAYWRIGHT_MCP_SHARED_PORT
    }
    else {
        $Port = 8931
    }
}

# The supervisor is either the launcher run directly or the service wrapper the
# scheduled task runs; both live in this runtime's bin directory.
$ExpectedServers = @(
    (Join-Path $RuntimeRoot "bin\playwright-mcp-shared.ps1"),
    (Join-Path $RuntimeRoot "bin\start-playwright-mcp-shared-service.ps1")
)

function Stop-ValidatedProcess {
    param(
        [string]$PidPath,
        [string[]]$ExpectedNames,
        [string[]]$ExpectedCommandFragments
    )

    if (-not [IO.File]::Exists($PidPath)) {
        return
    }

    $ManagedPid = 0
    if (-not [int]::TryParse([IO.File]::ReadAllText($PidPath).Trim(), [ref]$ManagedPid)) {
        throw "Invalid managed PID file '$PidPath'."
    }

    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$ManagedPid" -ErrorAction SilentlyContinue
    if ($Process) {
        $Matched = $false
        if ($ExpectedNames -contains $Process.Name -and -not [string]::IsNullOrWhiteSpace($Process.CommandLine)) {
            foreach ($Fragment in $ExpectedCommandFragments) {
                if ($Process.CommandLine.IndexOf($Fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $Matched = $true
                }
            }
        }
        if (-not $Matched) {
            # The recorded process is gone and its PID was reused. Never stop
            # it; the PID file is stale, so discard it.
            [Console]::Error.WriteLine("PID $ManagedPid does not match the managed Playwright command; refusing to stop it and discarding the stale PID file.")
        }
        else {
            Stop-Process -Id $ManagedPid -ErrorAction SilentlyContinue
            try {
                Wait-Process -Id $ManagedPid -Timeout 10 -ErrorAction Stop
            }
            catch {
                Stop-Process -Id $ManagedPid -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if ([IO.File]::Exists($PidPath)) {
        [IO.File]::Delete($PidPath)
    }
}

# Hold the service down before stopping anything, so the task's repeating
# trigger cannot relaunch the supervisor mid-stop. The installer clears it.
$null = [IO.Directory]::CreateDirectory($StateRoot)
[IO.File]::WriteAllText(
    (Join-Path $StateRoot "service-stopped"),
    ("{0:o}" -f [DateTime]::UtcNow),
    [Text.UTF8Encoding]::new($false)
)

# Stop the supervisor first so an intentional stop does not trigger a restart.
Stop-ValidatedProcess `
    -PidPath (Join-Path $StateRoot "shared-server.pid") `
    -ExpectedNames @("powershell.exe", "pwsh.exe") `
    -ExpectedCommandFragments $ExpectedServers
Stop-ValidatedProcess `
    -PidPath (Join-Path $StateRoot "shared-node.pid") `
    -ExpectedNames @("node.exe") `
    -ExpectedCommandFragments @($ExpectedCli)

function Test-LoopbackPort {
    param([int]$TargetPort)
    $Client = [Net.Sockets.TcpClient]::new()
    try {
        $Connect = $Client.ConnectAsync("127.0.0.1", $TargetPort)
        if (-not $Connect.Wait(500)) {
            return $false
        }
        return $Client.Connected
    }
    catch {
        return $false
    }
    finally {
        $Client.Dispose()
    }
}

$Deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    if (-not (Test-LoopbackPort -TargetPort $Port)) {
        "Shared Playwright MCP server stopped."
        exit 0
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $Deadline)

throw "Shared Playwright MCP port $Port is still listening after the managed stop."
