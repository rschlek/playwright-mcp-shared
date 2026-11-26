# Checks how the Windows installer names its scheduled task, without touching
# Task Scheduler or the registry: the ScheduledTasks cmdlets and
# Remove-ItemProperty are replaced by recording stubs, the runtime is a
# temporary directory, and the Run key points at a key that does not exist.
# Safe to run on a machine with a live installation.

$ErrorActionPreference = "Stop"

$SkillRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Installer = Join-Path $SkillRoot "scripts\install-playwright-mcp-shared-autostart.ps1"
$TestId = [Guid]::NewGuid().ToString("N")
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) "playwright-mcp-shared-names-$TestId"
$AbsentRunKey = "HKCU:\Software\PlaywrightMCPSharedTests\absent-$TestId"

$global:PwmcpTestRegistered = [Collections.Generic.List[string]]::new()
$global:PwmcpTestStarted = [Collections.Generic.List[string]]::new()
$global:PwmcpTestRemovedProperties = [Collections.Generic.List[string]]::new()

# Functions take precedence over cmdlets, and the installer runs in a child
# scope that sees them.
function Register-ScheduledTask {
    param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [string]$Description, [switch]$Force)
    $global:PwmcpTestRegistered.Add($TaskName)
}
function Start-ScheduledTask { param([string]$TaskName) $global:PwmcpTestStarted.Add($TaskName) }
function Unregister-ScheduledTask { throw "The installer must not unregister a task." }
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument) [pscustomobject]@{ Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskTrigger { [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }
function Remove-ItemProperty { param([string]$LiteralPath, [string]$Name) $global:PwmcpTestRemovedProperties.Add("$LiteralPath|$Name") }

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "FAIL: $Message"
    }
}

function New-TestRuntime {
    param([string]$Name)
    $Root = Join-Path $TempRoot $Name
    $Bin = Join-Path $Root "bin"
    $null = [IO.Directory]::CreateDirectory($Bin)
    foreach ($Script in @("playwright-mcp-shared.ps1", "start-playwright-mcp-shared-service.ps1")) {
        Copy-Item -LiteralPath (Join-Path $SkillRoot "scripts\$Script") -Destination $Bin
    }
    return $Root
}

function Invoke-Installer {
    param([string]$RuntimeRoot, [hashtable]$Extra = @{})
    $global:PwmcpTestRegistered.Clear()
    $Arguments = @{
        RuntimeRoot = $RuntimeRoot
        Port = 18931
        DashboardPort = 18932
        RunKey = $AbsentRunKey
    }
    foreach ($Key in $Extra.Keys) {
        $Arguments[$Key] = $Extra[$Key]
    }
    $ErrorFile = Join-Path $TempRoot "installer-$([Guid]::NewGuid().ToString('N')).stderr"
    $PreviousError = [Console]::Error
    $Writer = [IO.StreamWriter]::new($ErrorFile)
    [Console]::SetError($Writer)
    try {
        $Result = & $Installer @Arguments
    }
    finally {
        $Writer.Flush()
        $Writer.Dispose()
        [Console]::SetError($PreviousError)
    }
    return [pscustomobject]@{
        Result = $Result
        Stderr = [IO.File]::ReadAllText($ErrorFile)
        Config = Get-Content -LiteralPath (Join-Path $RuntimeRoot "state\windows-service-config.json") -Raw | ConvertFrom-Json
    }
}

# Refuse to run unless every stub shadows the real command: the default-name
# case would otherwise re-register a live installation's task.
foreach ($Name in @(
    "Register-ScheduledTask", "Start-ScheduledTask", "Unregister-ScheduledTask",
    "New-ScheduledTaskAction", "New-ScheduledTaskTrigger", "New-ScheduledTaskPrincipal",
    "New-ScheduledTaskSettingsSet", "Remove-ItemProperty")) {
    $Resolved = Get-Command -Name $Name
    if ($Resolved.CommandType -ne "Function") {
        throw "FAIL: '$Name' resolves to a $($Resolved.CommandType), not the test stub; refusing to run the installer."
    }
}

try {
    $null = [IO.Directory]::CreateDirectory($TempRoot)

    # A fresh runtime with no name given uses the default task name.
    $DefaultRoot = New-TestRuntime -Name "default"
    $Run = Invoke-Installer -RuntimeRoot $DefaultRoot
    Assert-True ($global:PwmcpTestRegistered.Count -eq 1 -and $global:PwmcpTestRegistered[0] -eq "PlaywrightMCPSharedService") "a fresh install did not register the default task: $($global:PwmcpTestRegistered -join ',')"
    Assert-True ($Run.Config.TaskName -eq "PlaywrightMCPSharedService") "a fresh install did not record the default task name"
    Assert-True ($Run.Result.TaskName -eq "PlaywrightMCPSharedService") "the installer reported task '$($Run.Result.TaskName)'"

    # A runtime installed under another task name keeps it on a later install
    # that names no task.
    $NamedRoot = New-TestRuntime -Name "installed-under-another-name"
    $Run = Invoke-Installer -RuntimeRoot $NamedRoot -Extra @{ TaskName = "OtherSharedBrowserTask"; ProfilePath = (Join-Path $NamedRoot "profiles\shared") }
    Assert-True ($global:PwmcpTestRegistered[0] -eq "OtherSharedBrowserTask") "the named install registered '$($global:PwmcpTestRegistered -join ',')'"
    Assert-True ($Run.Config.TaskName -eq "OtherSharedBrowserTask") "the named install did not record its task name"
    Assert-True ($Run.Config.RuntimeRoot -eq [IO.Path]::GetFullPath($NamedRoot)) "the named install recorded runtime '$($Run.Config.RuntimeRoot)'"

    $Run = Invoke-Installer -RuntimeRoot $NamedRoot -Extra @{ Start = $true }
    Assert-True ($global:PwmcpTestRegistered.Count -eq 1 -and $global:PwmcpTestRegistered[0] -eq "OtherSharedBrowserTask") "a re-install without -TaskName registered '$($global:PwmcpTestRegistered -join ',')'"
    Assert-True ($global:PwmcpTestStarted -contains "OtherSharedBrowserTask") "a re-install with -Start did not start the recorded task"
    Assert-True ($Run.Config.TaskName -eq "OtherSharedBrowserTask") "a re-install changed the recorded task name"
    Assert-True ([string]::IsNullOrEmpty($Run.Stderr)) "a re-install under the recorded name warned: $($Run.Stderr)"

    # An explicit new name is used and recorded; the earlier task is named in a
    # warning and never unregistered.
    $Run = Invoke-Installer -RuntimeRoot $NamedRoot -Extra @{ TaskName = "RenamedSharedBrowserTask" }
    Assert-True ($global:PwmcpTestRegistered[0] -eq "RenamedSharedBrowserTask") "a renamed install registered '$($global:PwmcpTestRegistered -join ',')'"
    Assert-True ($Run.Config.TaskName -eq "RenamedSharedBrowserTask") "a renamed install did not record the new name"
    Assert-True ($Run.Stderr -match "OtherSharedBrowserTask") "a renamed install did not name the earlier task: $($Run.Stderr)"

    # A name Task Scheduler cannot hold is refused before anything is registered.
    $global:PwmcpTestRegistered.Clear()
    $Refused = $false
    try {
        $null = Invoke-Installer -RuntimeRoot $NamedRoot -Extra @{ TaskName = "bad\name" }
    }
    catch {
        $Refused = $_.Exception.Message -match "task name"
    }
    Assert-True $Refused "an invalid task name was accepted"
    Assert-True ($global:PwmcpTestRegistered.Count -eq 0) "an invalid task name was registered"

    # The Run key was never touched: it does not exist.
    Assert-True ($global:PwmcpTestRemovedProperties.Count -eq 0) "the installer removed a Run value: $($global:PwmcpTestRemovedProperties -join ',')"

    "PASS: the installer uses the default task name on a fresh runtime, keeps a runtime's recorded task name when none is given, records a new name, and refuses an invalid one."
}
finally {
    if ([IO.Directory]::Exists($TempRoot)) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
}
