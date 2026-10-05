param(
    # Pinned Playwright MCP CLI used for the live supervision checks. Defaults
    # to PLAYWRIGHT_MCP_SHARED_CLI, then the canonical runtime's package. The
    # CLI is only read; the service under test runs headless in a temporary
    # runtime on a free port.
    [string]$McpCli = ""
)

$ErrorActionPreference = "Stop"

$SkillRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Installer = Join-Path $SkillRoot "scripts\install-playwright-mcp-shared-autostart.ps1"
$Launcher = Join-Path $SkillRoot "scripts\playwright-mcp-shared.ps1"
$ServiceWrapper = Join-Path $SkillRoot "scripts\start-playwright-mcp-shared-service.ps1"
$StopScript = Join-Path $SkillRoot "scripts\stop-playwright-mcp-shared.ps1"
$DashboardScript = Join-Path $SkillRoot "scripts\playwright-mcp-dashboard.mjs"
$TestId = [Guid]::NewGuid().ToString("N")
$RuntimeRoot = Join-Path ([IO.Path]::GetTempPath()) "playwright-mcp-shared-test-$TestId"
$RunKey = "HKCU:\Software\PlaywrightMCPSharedTests\$TestId"
$RunValueName = "PlaywrightMCPSharedTest"
$TaskName = "PlaywrightMCPSharedTest-$TestId"
$ExpectedPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$ExpectedConsoleHost = Join-Path $env:SystemRoot "System32\conhost.exe"

if ([string]::IsNullOrWhiteSpace($McpCli)) {
    if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_CLI)) {
        $McpCli = $env:PLAYWRIGHT_MCP_SHARED_CLI
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $McpCli = Join-Path $env:LOCALAPPDATA "playwright-mcp-shared\package\node_modules\@playwright\mcp\cli.js"
    }
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PlaywrightMcpSharedTestWindows {
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    public static List<string> VisibleTerminalWindows() {
        var found = new List<string>();
        EnumWindows((hwnd, lParam) => {
            if (IsWindowVisible(hwnd)) {
                var name = new StringBuilder(256);
                GetClassName(hwnd, name, name.Capacity);
                var className = name.ToString();
                if (className == "CASCADIA_HOSTING_WINDOW_CLASS" || className == "ConsoleWindowClass" || className == "PseudoConsoleWindow") {
                    found.Add(hwnd.ToInt64() + ":" + className);
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

function Get-FreePort {
    $Probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $Probe.Start()
    $FreePort = ([Net.IPEndPoint]$Probe.LocalEndpoint).Port
    $Probe.Stop()
    return $FreePort
}

function Wait-Until {
    param([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Failure)
    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw $Failure
}

function Read-PidFile {
    param([string]$Name)
    $Path = Join-Path $RuntimeRoot "state\$Name"
    if (-not [IO.File]::Exists($Path)) {
        return 0
    }
    $Value = 0
    $null = [int]::TryParse([IO.File]::ReadAllText($Path).Trim(), [ref]$Value)
    return $Value
}

function Test-Endpoint {
    param([int]$TargetPort)
    try {
        $Request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$TargetPort/mcp")
        $Request.Timeout = 2000
        $Response = $Request.GetResponse()
        $Response.Dispose()
        return $true
    }
    catch [Net.WebException] {
        # Any HTTP status means the server answered.
        return $null -ne $_.Exception.Response
    }
    catch {
        return $false
    }
}

function Test-Alive {
    param([int]$ProcessId)
    return $ProcessId -gt 0 -and [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Test-Dashboard {
    param([int]$TargetPort)
    try {
        $Request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$TargetPort/healthz")
        $Request.Timeout = 2000
        $Response = $Request.GetResponse()
        $Response.Dispose()
        return $true
    }
    catch {
        return $false
    }
}

function Get-TaskState {
    return [string](Get-ScheduledTask -TaskName $TaskName).State
}

function Get-AdoptionCount {
    $Log = Join-Path $RuntimeRoot "logs\shared-server.bootstrap.log"
    return @(Get-Content -LiteralPath $Log | Where-Object { $_ -match "node process adopted$" }).Count
}

function Invoke-InstalledStop {
    # Run the installed stop script with no arguments, as an operator would.
    param([string]$LogName)
    $StopProcess = Start-Process `
        -FilePath $ExpectedPowerShell `
        -ArgumentList @(
            "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"{0}"' -f (Join-Path $RuntimeRoot "bin\stop-playwright-mcp-shared.ps1"))
        ) `
        -RedirectStandardOutput (Join-Path $RuntimeRoot "$LogName.stdout.log") `
        -RedirectStandardError (Join-Path $RuntimeRoot "$LogName.stderr.log") `
        -NoNewWindow `
        -PassThru `
        -Wait
    return $StopProcess.ExitCode
}

function Stop-TestProcesses {
    # Only processes whose command line names this test's temporary runtime.
    foreach ($Pass in 1..2) {
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.ProcessId -ne $PID -and $_.CommandLine -and
                $_.CommandLine.IndexOf($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
            } |
            Sort-Object { if ($_.Name -eq "node.exe") { 1 } else { 0 } } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    }
}

try {
    $BinRoot = Join-Path $RuntimeRoot "bin"
    $CliRoot = Join-Path $RuntimeRoot "package\node_modules\@playwright\mcp"
    $null = New-Item -ItemType Directory -Path $BinRoot, $CliRoot -Force
    Copy-Item -LiteralPath $Launcher -Destination (Join-Path $BinRoot "playwright-mcp-shared.ps1")
    Copy-Item -LiteralPath $ServiceWrapper -Destination (Join-Path $BinRoot "start-playwright-mcp-shared-service.ps1")
    Copy-Item -LiteralPath $StopScript -Destination (Join-Path $BinRoot "stop-playwright-mcp-shared.ps1")
    $null = New-Item -ItemType File -Path (Join-Path $CliRoot "cli.js") -Force
    $null = New-Item -Path $RunKey -Force
    $null = New-ItemProperty `
        -Path $RunKey `
        -Name $RunValueName `
        -Value "legacy-test-value" `
        -PropertyType String `
        -Force

    $ServicePort = Get-FreePort
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $Result = & $Installer `
        -RuntimeRoot $RuntimeRoot `
        -ProfilePath (Join-Path $RuntimeRoot "profiles\shared") `
        -NodePath $NodePath `
        -Port $ServicePort `
        -TaskName $TaskName `
        -RunKey $RunKey `
        -RunValueName $RunValueName

    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $TaskAction = @($Task.Actions)[0]
    if ($Result.PowerShellPath -ne $ExpectedPowerShell) {
        throw "Installer did not select stable Windows PowerShell."
    }
    if ($TaskAction.Execute -ne $ExpectedConsoleHost) {
        throw "Scheduled task does not launch through the system console host."
    }
    if (-not $TaskAction.Arguments.StartsWith(('--headless "{0}" ' -f $ExpectedPowerShell))) {
        throw "Scheduled task does not run stable Windows PowerShell under a headless console host."
    }
    $ExpectedServiceWrapper = Join-Path $Result.RuntimeRoot "bin\start-playwright-mcp-shared-service.ps1"
    if (-not $TaskAction.Arguments.Contains(('-File "{0}"' -f $ExpectedServiceWrapper))) {
        throw "Scheduled task does not use the installed service wrapper."
    }
    $ServiceConfig = Get-Content -LiteralPath $Result.ServiceConfigPath -Raw | ConvertFrom-Json
    if ($ServiceConfig.NodePath -ne $NodePath) {
        throw "Service configuration does not pin the resolved Node.js executable."
    }
    if ($ServiceConfig.ProfilePath -ne $Result.ProfilePath) {
        throw "Service configuration does not retain the selected profile."
    }
    if ($ServiceConfig.DashboardPort -ne 8932) {
        throw "Service configuration does not record the default dashboard port."
    }
    $Triggers = @($Task.Triggers)
    if (-not ($Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" })) {
        throw "Scheduled task does not have a logon trigger."
    }
    $Repeating = @($Triggers | Where-Object {
        $_.CimClass.CimClassName -eq "MSFT_TaskTimeTrigger" -and
        $_.Repetition.Interval -eq "PT5M" -and
        [string]::IsNullOrEmpty($_.Repetition.Duration)
    })
    if ($Repeating.Count -ne 1) {
        throw "Scheduled task does not have an indefinite five-minute relaunch trigger."
    }
    if ([string]$Task.Settings.MultipleInstances -ne "IgnoreNew") {
        throw "Scheduled task does not ignore a new instance while the supervisor runs."
    }
    if ($Task.Settings.RestartCount -lt 1) {
        throw "Scheduled task does not have a failure restart policy."
    }
    if (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction SilentlyContinue) {
        throw "Legacy Run entry was not removed after task registration."
    }

    "PASS Windows autostart registers a headless, relaunching current-user service task and removes the legacy Run entry."

    $TestPort = Get-FreePort
    $LauncherProcess = Start-Process `
        -FilePath $ExpectedPowerShell `
        -ArgumentList @(
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"{0}"' -f (Join-Path $BinRoot "playwright-mcp-shared.ps1")),
            "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
            "-McpCli", ('"{0}"' -f (Join-Path $CliRoot "cli.js")),
            "-ProfilePath", ('"{0}"' -f (Join-Path $RuntimeRoot "profiles\shared")),
            "-NodePath", ('"{0}"' -f (Join-Path $RuntimeRoot "missing-node.exe")),
            "-Port", [string]$TestPort,
            "-RestartDelaySeconds", "0",
            "-MaxRestarts", "1"
        ) `
        -NoNewWindow `
        -PassThru `
        -Wait
    $BootstrapLog = Join-Path $RuntimeRoot "logs\shared-server.bootstrap.log"
    $Bootstrap = Get-Content -LiteralPath $BootstrapLog
    if (($Bootstrap | Where-Object { $_ -match "node process started$" }).Count -ne 2) {
        throw "Launcher did not start the child once and restart it once."
    }
    if (-not ($Bootstrap | Where-Object { $_ -match "exited with code .*; restarting" })) {
        throw "Launcher did not record the supervised restart."
    }

    "PASS Windows launcher rediscovers Node.js and restarts an unexpectedly exited child process."

    # A port held by something other than the managed node fails clearly and
    # leaves PID files the launcher did not write untouched.
    $StateRoot = Join-Path $RuntimeRoot "state"
    $ForeignPort = Get-FreePort
    $Foreign = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $ForeignPort)
    $Foreign.Start()
    try {
        [IO.File]::WriteAllText((Join-Path $StateRoot "shared-server.pid"), "4194300")
        [IO.File]::WriteAllText((Join-Path $StateRoot "shared-node.pid"), "4194301")
        $ForeignStderr = Join-Path $RuntimeRoot "foreign.stderr.log"
        $ForeignProcess = Start-Process `
            -FilePath $ExpectedPowerShell `
            -ArgumentList @(
                "-NoLogo", "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", ('"{0}"' -f (Join-Path $BinRoot "playwright-mcp-shared.ps1")),
                "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
                "-McpCli", ('"{0}"' -f (Join-Path $CliRoot "cli.js")),
                "-NodePath", ('"{0}"' -f $NodePath),
                "-Port", [string]$ForeignPort,
                "-MaxRestarts", "0"
            ) `
            -RedirectStandardError $ForeignStderr `
            -NoNewWindow `
            -PassThru `
            -Wait
    }
    finally {
        $Foreign.Stop()
    }
    if ($ForeignProcess.ExitCode -ne 70) {
        throw "Launcher did not fail when an unidentified process held the port."
    }
    if (-not ((Get-Content -LiteralPath $ForeignStderr -Raw) -match "not this runtime's managed Playwright MCP node")) {
        throw "Launcher did not explain that the port owner is not the managed node."
    }
    if ((Read-PidFile "shared-server.pid") -ne 4194300 -or (Read-PidFile "shared-node.pid") -ne 4194301) {
        throw "Failed launcher removed PID files it did not write."
    }
    Remove-Item -LiteralPath (Join-Path $StateRoot "shared-server.pid"), (Join-Path $StateRoot "shared-node.pid")

    "PASS Windows launcher refuses an unidentified port owner without touching PID files it did not write."

    if ([string]::IsNullOrWhiteSpace($McpCli) -or -not [IO.File]::Exists($McpCli)) {
        "SKIP live supervision checks: no Playwright MCP CLI found. Pass -McpCli or set PLAYWRIGHT_MCP_SHARED_CLI."
        return
    }

    # Run the real CLI headless in the temporary runtime through the task,
    # with the launch-tab dashboard on a free port.
    Copy-Item -LiteralPath $DashboardScript -Destination (Join-Path $BinRoot "playwright-mcp-dashboard.mjs")
    $DashboardPort = Get-FreePort
    $ServiceConfig | Add-Member -NotePropertyName McpCli -NotePropertyValue ([IO.Path]::GetFullPath($McpCli)) -Force
    $ServiceConfig | Add-Member -NotePropertyName Headless -NotePropertyValue $true -Force
    $ServiceConfig | Add-Member -NotePropertyName DashboardPort -NotePropertyValue $DashboardPort -Force
    [IO.File]::WriteAllText(
        $Result.ServiceConfigPath,
        ($ServiceConfig | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )

    $HostsBefore = @(Get-Process -Name WindowsTerminal, OpenConsole -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $WindowsBefore = [PlaywrightMcpSharedTestWindows]::VisibleTerminalWindows()
    $NewHosts = @{}
    $NewWindows = @{}
    Start-ScheduledTask -TaskName $TaskName
    $Deadline = [DateTime]::UtcNow.AddSeconds(60)
    $Answered = $false
    while ([DateTime]::UtcNow -lt $Deadline -and -not $Answered) {
        foreach ($HostId in @(Get-Process -Name WindowsTerminal, OpenConsole -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })) {
            if ($HostsBefore -notcontains $HostId) { $NewHosts[$HostId] = $true }
        }
        foreach ($Window in [PlaywrightMcpSharedTestWindows]::VisibleTerminalWindows()) {
            if ($WindowsBefore -notcontains $Window) { $NewWindows[$Window] = $true }
        }
        $Answered = Test-Endpoint -TargetPort $ServicePort
        if (-not $Answered) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $Answered) {
        throw "Task-launched service did not answer on its port."
    }
    $SupervisorPid = Read-PidFile "shared-server.pid"
    $NodePid = Read-PidFile "shared-node.pid"
    $Supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
    if (-not $Supervisor -or -not $Supervisor.CommandLine.Contains($ExpectedServiceWrapper)) {
        throw "Supervisor PID does not belong to the task-launched service wrapper."
    }
    $SupervisorHost = Get-CimInstance Win32_Process -Filter "ProcessId=$($Supervisor.ParentProcessId)"
    if (-not $SupervisorHost -or $SupervisorHost.Name -ne "conhost.exe" -or -not $SupervisorHost.CommandLine.Contains("--headless")) {
        throw "Supervisor is not hosted by a headless console host."
    }
    if ($NewHosts.Count -gt 0 -or $NewWindows.Count -gt 0) {
        throw "A terminal window or terminal host appeared while the task started: $(@($NewHosts.Keys) + @($NewWindows.Keys) -join ', ')"
    }
    if ((Get-TaskState) -ne "Running") {
        throw "Task does not report Running while the supervisor lives."
    }

    "PASS Task-launched supervisor runs under a headless console host with no terminal window, and the task reports Running."

    Wait-Until { Test-Dashboard -TargetPort $DashboardPort } 30 "The supervisor did not start the dashboard."
    $DashboardPid = Read-PidFile "dashboard.pid"
    $Dashboard = Get-CimInstance Win32_Process -Filter "ProcessId=$DashboardPid"
    if (-not $Dashboard -or $Dashboard.Name -ne "node.exe" -or
        -not $Dashboard.CommandLine.Contains((Join-Path $BinRoot "playwright-mcp-dashboard.mjs"))) {
        throw "The dashboard PID does not belong to the installed dashboard script."
    }

    "PASS Task-launched supervisor starts the launch-tab dashboard on its configured loopback port."

    # Kill the supervisor: the task instance ends, the node keeps serving, and a
    # relaunch adopts that node instead of failing on the port.
    $AdoptionsBefore = Get-AdoptionCount
    Stop-Process -Id $SupervisorPid -Force
    Wait-Until { (Get-TaskState) -ne "Running" } 15 "Task still reports Running after its supervisor was killed."
    if (-not (Test-Alive $NodePid)) {
        throw "Node did not outlive the killed supervisor; the adoption check would be vacuous."
    }
    Start-ScheduledTask -TaskName $TaskName
    Wait-Until { (Get-AdoptionCount) -gt $AdoptionsBefore } 30 "Relaunched supervisor did not adopt the running node."
    $AdoptingPid = Read-PidFile "shared-server.pid"
    if ($AdoptingPid -eq $SupervisorPid -or -not (Test-Alive $AdoptingPid)) {
        throw "Relaunched supervisor did not record its own PID."
    }
    if ((Read-PidFile "shared-node.pid") -ne $NodePid -or -not (Test-Alive $NodePid)) {
        throw "Relaunch restarted the node instead of adopting it."
    }
    if (-not (Test-Endpoint -TargetPort $ServicePort)) {
        throw "Adopted node stopped answering."
    }
    if ((Get-TaskState) -ne "Running") {
        throw "Task does not report Running under the adopting supervisor."
    }
    Wait-Until {
        @(Get-Content -LiteralPath (Join-Path $RuntimeRoot "logs\shared-server.bootstrap.log") | Where-Object { $_ -match "dashboard process adopted$" }).Count -gt 0
    } 30 "Relaunched supervisor did not adopt the running dashboard."
    if ((Read-PidFile "dashboard.pid") -ne $DashboardPid -or -not (Test-Dashboard -TargetPort $DashboardPort)) {
        throw "Relaunch restarted the dashboard instead of adopting it."
    }

    "PASS Killed supervisor is replaced by a relaunch that adopts the running node (PID unchanged) and records correct PID files."

    # A second launch while a supervisor lives exits quietly and changes nothing.
    $LogLengthBefore = (Get-Item -LiteralPath $BootstrapLog).Length
    $SecondLaunch = Start-Process `
        -FilePath $ExpectedPowerShell `
        -ArgumentList @(
            "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"{0}"' -f (Join-Path $BinRoot "start-playwright-mcp-shared-service.ps1"))
        ) `
        -RedirectStandardError (Join-Path $RuntimeRoot "second-launch.stderr.log") `
        -NoNewWindow `
        -PassThru `
        -Wait
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    if ($SecondLaunch.ExitCode -ne 0) {
        throw "Second launch did not exit successfully."
    }
    if ((Read-PidFile "shared-server.pid") -ne $AdoptingPid -or (Read-PidFile "shared-node.pid") -ne $NodePid) {
        throw "Second launch changed the PID files."
    }
    if ((Get-Item -LiteralPath $BootstrapLog).Length -ne $LogLengthBefore) {
        throw "Second launch wrote to the bootstrap log."
    }
    if (-not (Test-Alive $AdoptingPid) -or -not (Test-Alive $NodePid)) {
        throw "Second launch disturbed the running service."
    }

    "PASS Second launch while a supervisor is alive exits 0 and leaves state untouched."

    # Under the adopting supervisor, an exited node is restarted as usual.
    Stop-Process -Id $NodePid -Force
    Wait-Until {
        $Current = Read-PidFile "shared-node.pid"
        $Current -gt 0 -and $Current -ne $NodePid -and (Test-Alive $Current) -and (Test-Endpoint -TargetPort $ServicePort)
    } 60 "Adopting supervisor did not restart the killed node."
    if ((Read-PidFile "shared-server.pid") -ne $AdoptingPid) {
        throw "Supervisor changed while restarting the node."
    }
    $NodePid = Read-PidFile "shared-node.pid"

    if ((Read-PidFile "dashboard.pid") -ne $DashboardPid) {
        throw "A node restart restarted the dashboard."
    }

    "PASS Adopting supervisor restarts a killed node and the endpoint answers again."

    # The dashboard is supervised too: a killed dashboard comes back.
    Stop-Process -Id $DashboardPid -Force
    Wait-Until {
        $Current = Read-PidFile "dashboard.pid"
        $Current -gt 0 -and $Current -ne $DashboardPid -and (Test-Dashboard -TargetPort $DashboardPort)
    } 60 "Supervisor did not restart the killed dashboard."
    $DashboardPid = Read-PidFile "dashboard.pid"

    "PASS Supervisor restarts a killed dashboard."

    # The installed stop script resolves its own runtime and port, stops the
    # task-launched supervisor and node, and holds the service down.
    $StopExitCode = Invoke-InstalledStop -LogName "stop"
    if ($StopExitCode -ne 0) {
        throw "Managed stop failed: $(Get-Content -LiteralPath (Join-Path $RuntimeRoot 'stop.stderr.log') -Raw)"
    }
    # A terminated process can linger briefly while other handles to it close.
    try {
        Wait-Until { -not (Test-Alive $AdoptingPid) -and -not (Test-Alive $NodePid) } 15 "lingering"
    }
    catch {
        throw ("Managed stop left a process running (supervisor {0}: {1}, node {2}: {3}). Stop output: {4}" -f
            $AdoptingPid, (Test-Alive $AdoptingPid), $NodePid, (Test-Alive $NodePid),
            (Get-Content -LiteralPath (Join-Path $RuntimeRoot "stop.stdout.log") -Raw))
    }
    if ((Read-PidFile "shared-server.pid") -ne 0 -or (Read-PidFile "shared-node.pid") -ne 0 -or (Read-PidFile "dashboard.pid") -ne 0) {
        throw "Managed stop left PID files behind."
    }
    Wait-Until { -not (Test-Alive $DashboardPid) } 15 "Managed stop left the dashboard running."
    Wait-Until { (Get-TaskState) -ne "Running" } 15 "Task still reports Running after the managed stop."
    $LastRunBefore = (Get-ScheduledTaskInfo -TaskName $TaskName).LastRunTime
    Start-ScheduledTask -TaskName $TaskName
    Wait-Until {
        (Get-ScheduledTaskInfo -TaskName $TaskName).LastRunTime -ne $LastRunBefore -and (Get-TaskState) -ne "Running"
    } 30 "Relaunch after a managed stop did not run and exit."
    if ((Read-PidFile "shared-server.pid") -ne 0 -or (Test-Endpoint -TargetPort $ServicePort)) {
        throw "Relaunch trigger restarted the service after a managed stop."
    }

    "PASS Stop script stops a task-launched supervisor and its node, and the relaunch trigger honours the stop."

    # A recorded PID that now belongs to an unrelated process is never stopped.
    $Unrelated = Start-Process `
        -FilePath $ExpectedPowerShell `
        -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ('"Start-Sleep -Seconds 120 # {0}"' -f $RuntimeRoot)) `
        -NoNewWindow `
        -PassThru
    [IO.File]::WriteAllText((Join-Path $StateRoot "shared-server.pid"), [string]$Unrelated.Id)
    $null = Invoke-InstalledStop -LogName "refusal"
    $RefusalOutput = Get-Content -LiteralPath (Join-Path $RuntimeRoot "refusal.stderr.log") -Raw
    if (-not (Test-Alive $Unrelated.Id)) {
        throw "Stop script killed an unrelated process."
    }
    if (-not ($RefusalOutput -match "refusing to stop")) {
        throw "Stop script did not report refusing the unrelated PID."
    }
    Stop-Process -Id $Unrelated.Id -Force

    "PASS Stop script refuses to stop an unrelated process recorded in the PID file."
}
finally {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Stop-TestProcesses
    if (Test-Path -LiteralPath $RunKey) {
        Remove-Item -LiteralPath $RunKey -Recurse -Force
    }
    if (Test-Path -LiteralPath $RuntimeRoot) {
        Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
    }
}
