#!/usr/bin/env bash
# Linux sibling of playwright-auth-lease.ps1: identical subcommands, identical
# JSON schema, identical exit codes (0 ok, 75 busy, 76 lease-mismatch-or-expired,
# 70 error). flock replaces the exclusive FileShare::None handle.
#
# The lease records only an owner CLASS and timestamps. Never put an identity
# value, URL, or credential in -Owner.
set -uo pipefail

ACTION=""
RUNTIME_ROOT=""
OWNER=""
LEASE_ID=""
TTL_SECONDS=900

json_escape() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s' "$value"
}

action_lower() {
    printf '%s' "$ACTION" | tr '[:upper:]' '[:lower:]'
}

fail() {
    printf '{"action":"%s","success":false,"reason":"error","message":"%s"}\n' \
        "$(action_lower)" "$(json_escape "$1")"
    exit 70
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -Action|--action) ACTION="${2:-}"; shift 2 ;;
        -RuntimeRoot|--runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
        -Owner|--owner) OWNER="${2:-}"; shift 2 ;;
        -LeaseId|--lease-id) LEASE_ID="${2:-}"; shift 2 ;;
        -TtlSeconds|--ttl-seconds) TTL_SECONDS="${2:-900}"; shift 2 ;;
        *) fail "Unknown argument '$1'." ;;
    esac
done

case "$ACTION" in
    Acquire|Renew|Release|Status) ;;
    *) fail "Action must be one of Acquire, Renew, Release, Status." ;;
esac

case "$TTL_SECONDS" in
    ''|*[!0-9]*) fail "TtlSeconds must be an integer between 30 and 3600." ;;
esac
if [ "$TTL_SECONDS" -lt 30 ] || [ "$TTL_SECONDS" -gt 3600 ]; then
    fail "TtlSeconds must be an integer between 30 and 3600."
fi

if [ -z "$RUNTIME_ROOT" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || fail "Cannot resolve the script directory."
    INSTALLED_ROOT="$(dirname "$SCRIPT_DIR")"
    if [ -n "${PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT:-}" ]; then
        RUNTIME_ROOT="$PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT"
    elif [ "$(basename "$SCRIPT_DIR")" = "bin" ] && [ -f "$INSTALLED_ROOT/state/linux-service-config.json" ]; then
        # An installed copy uses the runtime it lives in.
        RUNTIME_ROOT="$INSTALLED_ROOT"
    elif [ -n "${XDG_DATA_HOME:-}" ]; then
        RUNTIME_ROOT="$XDG_DATA_HOME/playwright-mcp-shared"
    elif [ -n "${HOME:-}" ]; then
        RUNTIME_ROOT="$HOME/.local/share/playwright-mcp-shared"
    else
        fail "HOME is unavailable and PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT is not set."
    fi
fi
case "$RUNTIME_ROOT" in /*) ;; *) RUNTIME_ROOT="$PWD/$RUNTIME_ROOT" ;; esac

if [ "$ACTION" = "Acquire" ]; then
    if ! printf '%s' "$OWNER" | grep -Eq '^[A-Za-z0-9._:-]{1,80}$'; then
        fail "Owner must be 1-80 characters using letters, digits, period, underscore, colon, or hyphen."
    fi
fi
if [ "$ACTION" = "Renew" ] || [ "$ACTION" = "Release" ]; then
    if ! printf '%s' "$LEASE_ID" | grep -Eq '^[a-f0-9]{32}$'; then
        fail "$ACTION requires a valid lease ID."
    fi
fi

LOCKS_ROOT="$RUNTIME_ROOT/locks"
mkdir -p "$LOCKS_ROOT" || fail "Cannot create '$LOCKS_ROOT'."
LEASE_PATH="$LOCKS_ROOT/auth-flow.json"

exec 9>>"$LEASE_PATH" || fail "Cannot open the authentication lease at '$LEASE_PATH'."
if ! flock -w 5 9; then
    fail "The authentication lease file remained busy for five seconds."
fi

RAW="$(cat "$LEASE_PATH" 2>/dev/null || true)"

# The lease file is written only by this script and its PowerShell sibling: flat,
# string-valued JSON, so a field extractor needs no JSON parser dependency.
lease_field() {
    printf '%s' "$RAW" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 \
        | sed -e 's/^[^:]*:[[:space:]]*"//' -e 's/"$//'
}

CURRENT_STATE="$(lease_field state)"
CURRENT_LEASE_ID="$(lease_field lease_id)"
CURRENT_OWNER="$(lease_field owner)"
CURRENT_ACQUIRED="$(lease_field acquired_utc)"
CURRENT_EXPIRES="$(lease_field expires_utc)"

NOW_EPOCH="$(date -u +%s)"
now_iso() { date -u +%Y-%m-%dT%H:%M:%S.%6NZ; }
future_iso() { date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%S.%6NZ; }

HELD=0
if [ "$CURRENT_STATE" = "held" ] && [ -n "$CURRENT_LEASE_ID" ] && [ -n "$CURRENT_EXPIRES" ]; then
    EXPIRES_EPOCH="$(date -u -d "$CURRENT_EXPIRES" +%s 2>/dev/null || true)"
    case "$EXPIRES_EPOCH" in
        ''|*[!0-9]*) fail "The authentication lease state is invalid JSON." ;;
    esac
    [ "$EXPIRES_EPOCH" -gt "$NOW_EPOCH" ] && HELD=1
fi

write_state() { printf '%s' "$1" >"$LEASE_PATH"; }

if [ "$ACTION" = "Status" ]; then
    if [ "$HELD" -eq 1 ]; then
        printf '{"action":"status","available":false,"owner":"%s","expires_utc":"%s"}\n' \
            "$(json_escape "$CURRENT_OWNER")" "$(json_escape "$CURRENT_EXPIRES")"
    else
        printf '{"action":"status","available":true}\n'
    fi
    exit 0
fi

if [ "$ACTION" = "Acquire" ]; then
    if [ "$HELD" -eq 1 ]; then
        printf '{"action":"acquire","acquired":false,"reason":"busy","owner":"%s","expires_utc":"%s"}\n' \
            "$(json_escape "$CURRENT_OWNER")" "$(json_escape "$CURRENT_EXPIRES")"
        exit 75
    fi
    NEW_LEASE_ID="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
    if ! printf '%s' "$NEW_LEASE_ID" | grep -Eq '^[a-f0-9]{32}$'; then
        fail "Could not generate a lease ID."
    fi
    ACQUIRED_AT="$(now_iso)"
    EXPIRES_AT="$(future_iso "$TTL_SECONDS")"
    write_state "$(printf '{"schema":1,"state":"held","lease_id":"%s","owner":"%s","acquired_utc":"%s","expires_utc":"%s"}' \
        "$NEW_LEASE_ID" "$(json_escape "$OWNER")" "$ACQUIRED_AT" "$EXPIRES_AT")"
    printf '{"action":"acquire","acquired":true,"lease_id":"%s","owner":"%s","expires_utc":"%s"}\n' \
        "$NEW_LEASE_ID" "$(json_escape "$OWNER")" "$EXPIRES_AT"
    exit 0
fi

if [ "$HELD" -ne 1 ] || [ "$CURRENT_LEASE_ID" != "$LEASE_ID" ]; then
    printf '{"action":"%s","success":false,"reason":"lease-mismatch-or-expired"}\n' "$(action_lower)"
    exit 76
fi

if [ "$ACTION" = "Renew" ]; then
    EXPIRES_AT="$(future_iso "$TTL_SECONDS")"
    write_state "$(printf '{"schema":1,"state":"held","lease_id":"%s","owner":"%s","acquired_utc":"%s","expires_utc":"%s"}' \
        "$CURRENT_LEASE_ID" "$(json_escape "$CURRENT_OWNER")" "$(json_escape "$CURRENT_ACQUIRED")" "$EXPIRES_AT")"
    printf '{"action":"renew","success":true,"lease_id":"%s","expires_utc":"%s"}\n' "$LEASE_ID" "$EXPIRES_AT"
    exit 0
fi

write_state "$(printf '{"schema":1,"state":"free","released_utc":"%s"}' "$(now_iso)")"
printf '{"action":"release","success":true}\n'
exit 0
