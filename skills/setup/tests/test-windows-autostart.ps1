$ErrorActionPreference = "Stop"

$SkillRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Installer = Join-Path $SkillRoot "scripts\install-playwright-mcp-shared-autostart.ps1"
$Launcher = Join-Path $SkillRoot "scripts\playwright-mcp-shared.ps1"
$ServiceWrapper = Join-Path $SkillRoot "scripts\start-playwright-mcp-shared-service.ps1"
$TestId = [Guid]::NewGuid().ToString("N")
$RuntimeRoot = Join-Path ([IO.Path]::GetTempPath()) "playwright-mcp-shared-test-$TestId"
$RunKey = "HKCU:\Software\PlaywrightMCPSharedTests\$TestId"
$RunValueName = "PlaywrightMCPSharedTest"
$TaskName = "PlaywrightMCPSharedTest-$TestId"

try {
    $BinRoot = Join-Path $RuntimeRoot "bin"
    $CliRoot = Join-Path $RuntimeRoot "package\node_modules\@playwright\mcp"
    $null = New-Item -ItemType Directory -Path $BinRoot, $CliRoot -Force
    Copy-Item -LiteralPath $Launcher -Destination (Join-Path $BinRoot "playwright-mcp-shared.ps1")
    Copy-Item -LiteralPath $ServiceWrapper -Destination (Join-Path $BinRoot "start-playwright-mcp-shared-service.ps1")
    $null = New-Item -ItemType File -Path (Join-Path $CliRoot "cli.js") -Force
    $null = New-Item -Path $RunKey -Force
    $null = New-ItemProperty `
        -Path $RunKey `
        -Name $RunValueName `
        -Value "legacy-test-value" `
        -PropertyType String `
        -Force

    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $Result = & $Installer `
        -RuntimeRoot $RuntimeRoot `
        -ProfilePath (Join-Path $RuntimeRoot "profiles\shared") `
        -NodePath $NodePath `
        -TaskName $TaskName `
        -RunKey $RunKey `
        -RunValueName $RunValueName

    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $TaskAction = @($Task.Actions)[0]
    $TaskTrigger = @($Task.Triggers)[0]
    $ExpectedPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if ($Result.PowerShellPath -ne $ExpectedPowerShell) {
        throw "Installer did not select stable Windows PowerShell."
    }
    if ($TaskAction.Execute -ne $ExpectedPowerShell) {
        throw "Scheduled task does not use stable Windows PowerShell."
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
    if ($TaskTrigger.CimClass.CimClassName -ne "MSFT_TaskLogonTrigger") {
        throw "Scheduled task does not have a logon trigger."
    }
    if ($Task.Settings.RestartCount -lt 1) {
        throw "Scheduled task does not have a failure restart policy."
    }
    if (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction SilentlyContinue) {
        throw "Legacy Run entry was not removed after task registration."
    }

    "PASS Windows autostart registers a supervised current-user service task and removes the legacy Run entry."

    $PortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $PortProbe.Start()
    $TestPort = ([Net.IPEndPoint]$PortProbe.LocalEndpoint).Port
    $PortProbe.Stop()

    $LauncherProcess = Start-Process `
        -FilePath $ExpectedPowerShell `
        -ArgumentList @(
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"{0}"' -f (Join-Path $BinRoot "playwright-mcp-shared.ps1")),
            "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
            "-ProfilePath", ('"{0}"' -f (Join-Path $RuntimeRoot "profiles\shared")),
            "-NodePath", ('"{0}"' -f (Join-Path $RuntimeRoot "missing-node.exe")),
            "-Port", [string]$TestPort,
            "-RestartDelaySeconds", "0",
            "-MaxRestarts", "1"
        ) `
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
}
finally {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    if (Test-Path -LiteralPath $RunKey) {
        Remove-Item -LiteralPath $RunKey -Recurse -Force
    }
    if (Test-Path -LiteralPath $RuntimeRoot) {
        Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force
    }
}
