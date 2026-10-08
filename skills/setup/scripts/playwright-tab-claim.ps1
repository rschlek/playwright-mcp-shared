param(
    [ValidateSet("Claim", "Renew", "Release", "List", "Status")]
    [string]$Action,
    [string]$RuntimeRoot = "",
    [string]$Owner = "",
    [string]$Task = "",
    [string]$Url = "",
    [string]$ClaimId = "",
    [ValidateRange(60, 86400)]
    [int]$TtlSeconds = 3600
)

# Records which agent session is using which shared-browser tab, so the
# dashboard can show it. A claim is a cooperative label, not a lock: it never
# blocks another client. Entries expire after their TTL, so a session that
# ends without releasing drops off on its own.

$ErrorActionPreference = "Stop"
$MaxClaims = 200

function Write-Result {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

function Open-ClaimFile {
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
    throw "The tab-claim registry remained busy for five seconds."
}

function Read-ClaimState {
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
        return @()
    }
    try {
        $State = $Raw | ConvertFrom-Json
    }
    catch {
        throw "The tab-claim registry is invalid JSON."
    }
    return @($State.claims | Where-Object { $null -ne $_ })
}

function Write-ClaimState {
    param(
        [IO.FileStream]$Stream,
        [object[]]$Claims
    )
    $Json = @{ schema = 1; claims = @($Claims) } | ConvertTo-Json -Compress -Depth 5
    $Bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
    $Stream.Position = 0
    $Stream.SetLength(0)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
}

function ConvertTo-UtcTime {
    # Windows PowerShell keeps ISO strings as strings; PowerShell 7 turns
    # them into DateTime values. Accept either.
    param($Value)
    if ($Value -is [DateTime]) {
        return $Value.ToUniversalTime()
    }
    return [DateTime]::Parse(
        [string]$Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
}

function Format-UtcTime {
    param($Value)
    return (ConvertTo-UtcTime $Value).ToString("o")
}

function ConvertTo-RedactedUrl {
    # Keep scheme, host, and path. Query strings and fragments can carry
    # tokens and are never recorded.
    param([string]$Value)
    $Parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$Parsed)) {
        throw "Url must be an absolute URL."
    }
    if ($Parsed.Scheme -in @("http", "https")) {
        return "{0}://{1}{2}" -f $Parsed.Scheme, $Parsed.Authority, $Parsed.AbsolutePath
    }
    return "{0}:{1}" -f $Parsed.Scheme, $Parsed.AbsolutePath
}

function ConvertTo-StoredClaim {
    param($Claim)
    return [ordered]@{
        claim_id = [string]$Claim.claim_id
        owner = [string]$Claim.owner
        task = [string]$Claim.task
        url = [string]$Claim.url
        claimed_utc = Format-UtcTime $Claim.claimed_utc
        renewed_utc = Format-UtcTime $Claim.renewed_utc
        expires_utc = Format-UtcTime $Claim.expires_utc
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
        $InstalledRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
        if (-not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT)) {
            $RuntimeRoot = $env:PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT
        }
        elseif ((Split-Path -Leaf $PSScriptRoot) -eq "bin" -and
            [IO.File]::Exists((Join-Path $InstalledRoot "state\windows-service-config.json"))) {
            # An installed copy uses the runtime it lives in.
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
    $LocksRoot = Join-Path $RuntimeRoot "locks"
    $null = [IO.Directory]::CreateDirectory($LocksRoot)
    $ClaimPath = Join-Path $LocksRoot "tab-claims.json"

    if ($Action -eq "Claim") {
        if ($Owner -notmatch '^[A-Za-z0-9._:-]{1,80}$') {
            throw "Owner must be 1-80 characters using letters, digits, period, underscore, colon, or hyphen."
        }
        if ($Task.Length -gt 120 -or $Task -match '[\x00-\x1f\x7f]') {
            throw "Task must be at most 120 printable characters."
        }
        if ([string]::IsNullOrWhiteSpace($Url)) {
            throw "Claim requires the URL the tab was opened at."
        }
        $Url = ConvertTo-RedactedUrl -Value $Url
    }
    if ($Action -in @("Renew", "Release") -and $ClaimId -notmatch '^[a-f0-9]{32}$') {
        throw "$Action requires a valid claim ID."
    }
    if ($Action -eq "Renew" -and -not [string]::IsNullOrWhiteSpace($Url)) {
        $Url = ConvertTo-RedactedUrl -Value $Url
    }

    $Stream = Open-ClaimFile -Path $ClaimPath
    try {
        $Now = [DateTime]::UtcNow
        # Drop expired and malformed entries on every pass.
        $Active = [Collections.Generic.List[object]]::new()
        foreach ($Claim in (Read-ClaimState -Stream $Stream)) {
            try {
                if ([string]$Claim.claim_id -match '^[a-f0-9]{32}$' -and (ConvertTo-UtcTime $Claim.expires_utc) -gt $Now) {
                    $Active.Add((ConvertTo-StoredClaim $Claim))
                }
            }
            catch {
                # A malformed entry is discarded rather than trusted.
            }
        }

        if ($Action -in @("List", "Status")) {
            $Public = @($Active | ForEach-Object {
                [ordered]@{
                    owner = $_.owner
                    task = $_.task
                    url = $_.url
                    claimed_utc = $_.claimed_utc
                    expires_utc = $_.expires_utc
                }
            })
            Write-Result -Value @{
                action = "list"
                count = $Public.Count
                claims = $Public
            }
            exit 0
        }

        if ($Action -eq "Claim") {
            if ($Active.Count -ge $MaxClaims) {
                throw "The tab-claim registry already holds $MaxClaims active claims."
            }
            $NewClaimId = [Guid]::NewGuid().ToString("N")
            $ExpiresAt = $Now.AddSeconds($TtlSeconds)
            $Active.Add([ordered]@{
                claim_id = $NewClaimId
                owner = $Owner
                task = $Task
                url = $Url
                claimed_utc = $Now.ToString("o")
                renewed_utc = $Now.ToString("o")
                expires_utc = $ExpiresAt.ToString("o")
            })
            Write-ClaimState -Stream $Stream -Claims $Active.ToArray()
            Write-Result -Value @{
                action = "claim"
                claimed = $true
                claim_id = $NewClaimId
                owner = $Owner
                url = $Url
                expires_utc = $ExpiresAt.ToString("o")
            }
            exit 0
        }

        $Match = $null
        foreach ($Claim in $Active) {
            if ($Claim.claim_id -eq $ClaimId) {
                $Match = $Claim
            }
        }
        if ($null -eq $Match) {
            # Rewrite anyway so expired entries are pruned.
            Write-ClaimState -Stream $Stream -Claims $Active.ToArray()
            Write-Result -Value @{
                action = $Action.ToLowerInvariant()
                success = $false
                reason = "claim-not-found-or-expired"
            }
            exit 76
        }

        if ($Action -eq "Renew") {
            $ExpiresAt = $Now.AddSeconds($TtlSeconds)
            $Match.renewed_utc = $Now.ToString("o")
            $Match.expires_utc = $ExpiresAt.ToString("o")
            if (-not [string]::IsNullOrWhiteSpace($Url)) {
                $Match.url = $Url
            }
            Write-ClaimState -Stream $Stream -Claims $Active.ToArray()
            Write-Result -Value @{
                action = "renew"
                success = $true
                claim_id = $ClaimId
                url = $Match.url
                expires_utc = $ExpiresAt.ToString("o")
            }
            exit 0
        }

        $null = $Active.Remove($Match)
        Write-ClaimState -Stream $Stream -Claims $Active.ToArray()
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
        action = $(if ($Action) { $Action.ToLowerInvariant() } else { "" })
        success = $false
        reason = "error"
        message = $_.Exception.Message
    }
    exit 70
}
