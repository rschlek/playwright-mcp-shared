param(
    [string]$RuntimeRoot = "",
    [int]$Port = 8931
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is unavailable."
    }
    $RuntimeRoot = Join-Path $env:LOCALAPPDATA "playwright-mcp-shared"
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$StateRoot = Join-Path $RuntimeRoot "state"
$ExpectedCli = Join-Path $RuntimeRoot "package\node_modules\@playwright\mcp\cli.js"
$ExpectedServer = Join-Path $RuntimeRoot "bin\playwright-mcp-shared.ps1"

function Stop-ValidatedProcess {
    param(
        [string]$PidPath,
        [string]$ExpectedCommandFragment
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
        if ([string]::IsNullOrWhiteSpace($Process.CommandLine) -or -not $Process.CommandLine.Contains($ExpectedCommandFragment)) {
            throw "PID $ManagedPid does not match the managed Playwright command; refusing to stop it."
        }
        Stop-Process -Id $ManagedPid -ErrorAction SilentlyContinue
        try {
            Wait-Process -Id $ManagedPid -Timeout 10 -ErrorAction Stop
        }
        catch {
            Stop-Process -Id $ManagedPid -Force -ErrorAction SilentlyContinue
        }
    }

    if ([IO.File]::Exists($PidPath)) {
        [IO.File]::Delete($PidPath)
    }
}

Stop-ValidatedProcess `
    -PidPath (Join-Path $StateRoot "shared-server.pid") `
    -ExpectedCommandFragment $ExpectedServer
Stop-ValidatedProcess `
    -PidPath (Join-Path $StateRoot "shared-node.pid") `
    -ExpectedCommandFragment $ExpectedCli

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
