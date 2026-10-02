param(
    [ValidateSet("Acquire", "Renew", "Release", "Status")]
    [string]$Action,
    [string]$RuntimeRoot = "",
    [string]$Owner = "",
    [string]$LeaseId = "",
    [ValidateRange(30, 3600)]
    [int]$TtlSeconds = 900
)

$ErrorActionPreference = "Stop"

function Write-Result {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
}

function Open-LeaseFile {
    param([string]$Path)
    $Deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        try {
            return [IO.File]::Open(
                $Path,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
        }
        catch [IO.IOException] {
            Start-Sleep -Milliseconds 50
        }
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "The authentication lease file remained busy for five seconds."
}

function Read-LeaseState {
    param([IO.FileStream]$Stream)
    $Stream.Position = 0
    $Reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false), $true, 1024, $true)
    try {
        $Raw = $Reader.ReadToEnd()
    }
    finally {
        $Reader.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($Raw)) {
        return $null
    }
    try {
        return $Raw | ConvertFrom-Json
    }
    catch {
        throw "The authentication lease state is invalid JSON."
    }
}

function Write-LeaseState {
    param(
        [IO.FileStream]$Stream,
        [hashtable]$State
    )
    $Json = $State | ConvertTo-Json -Compress
    $Bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
    $Stream.Position = 0
    $Stream.SetLength(0)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
}

try {
    if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "LOCALAPPDATA is unavailable."
        }
        $RuntimeRoot = Join-Path $env:LOCALAPPDATA "playwright-mcp-shared"
    }
    $RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
    $LocksRoot = Join-Path $RuntimeRoot "locks"
    $null = [IO.Directory]::CreateDirectory($LocksRoot)
    $LeasePath = Join-Path $LocksRoot "auth-flow.json"

    if ($Action -in @("Acquire", "Renew")) {
        if ($Action -eq "Acquire" -and ($Owner -notmatch '^[A-Za-z0-9._:-]{1,80}$')) {
            throw "Owner must be 1-80 characters using letters, digits, period, underscore, colon, or hyphen."
        }
        if ($Action -eq "Renew" -and $LeaseId -notmatch '^[a-f0-9]{32}$') {
            throw "Renew requires a valid lease ID."
        }
    }
    if ($Action -eq "Release" -and $LeaseId -notmatch '^[a-f0-9]{32}$') {
        throw "Release requires a valid lease ID."
    }

    $Stream = Open-LeaseFile -Path $LeasePath
    try {
        $Now = [DateTime]::UtcNow
        $Current = Read-LeaseState -Stream $Stream
        $Held = $false
        if ($Current -and $Current.state -eq "held" -and $Current.lease_id -and $Current.expires_utc) {
            $Expires = [DateTime]::Parse(
                [string]$Current.expires_utc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
            $Held = $Expires -gt $Now
        }

        if ($Action -eq "Status") {
            if ($Held) {
                Write-Result -Value @{
                    action = "status"
                    available = $false
                    owner = [string]$Current.owner
                    expires_utc = [string]$Current.expires_utc
                }
            }
            else {
                Write-Result -Value @{
                    action = "status"
                    available = $true
                }
            }
            exit 0
        }

        if ($Action -eq "Acquire") {
            if ($Held) {
                Write-Result -Value @{
                    action = "acquire"
                    acquired = $false
                    reason = "busy"
                    owner = [string]$Current.owner
                    expires_utc = [string]$Current.expires_utc
                }
                exit 75
            }
            $NewLeaseId = [Guid]::NewGuid().ToString("N")
            $ExpiresAt = $Now.AddSeconds($TtlSeconds)
            Write-LeaseState -Stream $Stream -State @{
                schema = 1
                state = "held"
                lease_id = $NewLeaseId
                owner = $Owner
                acquired_utc = $Now.ToString("o")
                expires_utc = $ExpiresAt.ToString("o")
            }
            Write-Result -Value @{
                action = "acquire"
                acquired = $true
                lease_id = $NewLeaseId
                owner = $Owner
                expires_utc = $ExpiresAt.ToString("o")
            }
            exit 0
        }

        if (-not $Held -or [string]$Current.lease_id -ne $LeaseId) {
            Write-Result -Value @{
                action = $Action.ToLowerInvariant()
                success = $false
                reason = "lease-mismatch-or-expired"
            }
            exit 76
        }

        if ($Action -eq "Renew") {
            $ExpiresAt = $Now.AddSeconds($TtlSeconds)
            Write-LeaseState -Stream $Stream -State @{
                schema = 1
                state = "held"
                lease_id = [string]$Current.lease_id
                owner = [string]$Current.owner
                acquired_utc = [string]$Current.acquired_utc
                expires_utc = $ExpiresAt.ToString("o")
            }
            Write-Result -Value @{
                action = "renew"
                success = $true
                lease_id = $LeaseId
                expires_utc = $ExpiresAt.ToString("o")
            }
            exit 0
        }

        Write-LeaseState -Stream $Stream -State @{
            schema = 1
            state = "free"
            released_utc = $Now.ToString("o")
        }
        Write-Result -Value @{
            action = "release"
            success = $true
        }
        exit 0
    }
    finally {
        $Stream.Dispose()
    }
}
catch {
    Write-Result -Value @{
        action = $Action.ToLowerInvariant()
        success = $false
        reason = "error"
        message = $_.Exception.Message
    }
    exit 70
}
