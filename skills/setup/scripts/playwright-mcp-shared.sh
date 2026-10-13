#!/usr/bin/env bash
# Linux sibling of playwright-mcp-shared.ps1. Same flags, same behavior, same
# runtime layout and log wording - only the platform primitives differ (flock
# instead of an exclusive FileShare::None handle, ss and /proc instead of the
# TCP table and Win32_Process).
#
# It is a supervisor: it starts the Playwright MCP node process (or adopts a
# managed one a previous supervisor left serving), keeps the launch-tab
# dashboard running beside it, and restarts the node when it exits. A restarted
# node does not open Chrome; the browser starts when an agent next needs it.
#
# Runs in the foreground so a systemd --user unit can be Type=simple; -Detach
# is the by-hand equivalent of the Windows hidden-window launch.
set -uo pipefail

RUNTIME_ROOT=""
MCP_CLI=""
PROFILE_PATH=""
NODE_PATH=""
PORT=0
HEADLESS=0
DETACH=0
RESTART_DELAY_SECONDS=3
MAX_RESTARTS=-1
# Loopback port of the live dashboard shown in the launch tab: -1 uses
# PLAYWRIGHT_MCP_SHARED_DASHBOARD_PORT or 8932, and 0 turns it off.
DASHBOARD_PORT=-1
BOOTSTRAP_LOG=""

bootstrap() {
    [ -n "$BOOTSTRAP_LOG" ] || return 0
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ)" "$1" >>"$BOOTSTRAP_LOG" 2>/dev/null || true
}

# Every failure exits 70 and leaves other launchers' PID files alone: only
# files this launcher wrote, still holding its own values, are removed.
die() {
    local message="Shared Playwright MCP launcher failed: $1"
    bootstrap "$message"
    printf '%s\n' "$message" >&2
    exit 70
}

ORIGINAL_ARGS=("$@")
# PowerShell-style single-dash names keep the shared .mjs callers identical
# across platforms; the GNU long forms are accepted for hand use.
while [ "$#" -gt 0 ]; do
    case "$1" in
        -RuntimeRoot|--runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
        -McpCli|--mcp-cli) MCP_CLI="${2:-}"; shift 2 ;;
        -ProfilePath|--profile-path) PROFILE_PATH="${2:-}"; shift 2 ;;
        -NodePath|--node-path) NODE_PATH="${2:-}"; shift 2 ;;
        -Port|--port) PORT="${2:-0}"; shift 2 ;;
        -Headless|--headless) HEADLESS=1; shift ;;
        -Detach|--detach) DETACH=1; shift ;;
        -RestartDelaySeconds|--restart-delay-seconds) RESTART_DELAY_SECONDS="${2:-}"; shift 2 ;;
        -MaxRestarts|--max-restarts) MAX_RESTARTS="${2:-}"; shift 2 ;;
        -DashboardPort|--dashboard-port) DASHBOARD_PORT="${2:-}"; shift 2 ;;
        *) die "Unknown argument '$1'." ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || die "Cannot resolve the launcher directory."

if [ -z "$RUNTIME_ROOT" ]; then
    INSTALLED_ROOT="$(dirname "$SCRIPT_DIR")"
    if [ -n "${PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT:-}" ]; then
        RUNTIME_ROOT="$PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT"
    elif [ "$(basename "$SCRIPT_DIR")" = "bin" ] && [ -f "$INSTALLED_ROOT/state/linux-service-config.json" ]; then
        # An installed copy manages the runtime it lives in.
        RUNTIME_ROOT="$INSTALLED_ROOT"
    elif [ -n "${XDG_DATA_HOME:-}" ]; then
        RUNTIME_ROOT="$XDG_DATA_HOME/playwright-mcp-shared"
    elif [ -n "${HOME:-}" ]; then
        RUNTIME_ROOT="$HOME/.local/share/playwright-mcp-shared"
    else
        die "HOME is unavailable and PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT is not set."
    fi
fi
case "$RUNTIME_ROOT" in
    /*) ;;
    *) RUNTIME_ROOT="$PWD/$RUNTIME_ROOT" ;;
esac

# -Detach mirrors the Windows hidden-window launch: re-exec this same script in
# its own session and return immediately. Done before the singleton lock so the
# background copy, not this shell, owns it; the copy validates and logs.
if [ "$DETACH" -eq 1 ]; then
    mkdir -p "$RUNTIME_ROOT/logs" || die "Cannot create '$RUNTIME_ROOT/logs'."
    SELF="${BASH_SOURCE[0]}"
    case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac
    DETACHED_ARGS=()
    for ARGUMENT in "${ORIGINAL_ARGS[@]}"; do
        case "$ARGUMENT" in -Detach|--detach) ;; *) DETACHED_ARGS+=("$ARGUMENT") ;; esac
    done
    setsid nohup bash "$SELF" "${DETACHED_ARGS[@]}" -RuntimeRoot "$RUNTIME_ROOT" \
        >>"$RUNTIME_ROOT/logs/shared-server.bootstrap.log" 2>&1 </dev/null &
    printf 'Shared Playwright MCP launcher detached (pid %s).\n' "$!"
    exit 0
fi

# Take the singleton lock before any logging or state change, as the Windows
# launcher does. A launch that finds a live supervisor exits successfully and
# leaves no trace. Children never inherit fd 9 (see 9>&- below), so a dead
# supervisor's node cannot keep the lock and block its replacement.
LOCKS_ROOT="$RUNTIME_ROOT/locks"
mkdir -p "$LOCKS_ROOT" || die "Cannot create '$LOCKS_ROOT'."
LOCK_PATH="$LOCKS_ROOT/shared-server.lock"
exec 9>>"$LOCK_PATH" || die "Cannot open the singleton lock at '$LOCK_PATH'."
if ! flock -n 9; then
    printf '%s\n' "The shared Playwright MCP server is already running." >&2
    exit 0
fi

LOGS_ROOT="$RUNTIME_ROOT/logs"
mkdir -p "$LOGS_ROOT" || die "Cannot create '$LOGS_ROOT'."
BOOTSTRAP_LOG="$LOGS_ROOT/shared-server.bootstrap.log"
bootstrap "runtime resolved"

if [ -z "$MCP_CLI" ]; then
    if [ -n "${PLAYWRIGHT_MCP_SHARED_CLI:-}" ]; then
        MCP_CLI="$PLAYWRIGHT_MCP_SHARED_CLI"
    else
        MCP_CLI="$RUNTIME_ROOT/package/node_modules/@playwright/mcp/cli.js"
    fi
fi
case "$MCP_CLI" in /*) ;; *) MCP_CLI="$PWD/$MCP_CLI" ;; esac
[ -f "$MCP_CLI" ] || die "Pinned Playwright MCP CLI is missing at '$MCP_CLI'. Run playwright-mcp-shared:setup."
bootstrap "MCP CLI verified"

if [ -z "$PROFILE_PATH" ]; then
    if [ -n "${PLAYWRIGHT_MCP_SHARED_PROFILE:-}" ]; then
        PROFILE_PATH="$PLAYWRIGHT_MCP_SHARED_PROFILE"
    else
        PROFILE_PATH="$RUNTIME_ROOT/profiles/shared"
    fi
fi
case "$PROFILE_PATH" in
    /*) ;;
    *) PROFILE_PATH="$PWD/$PROFILE_PATH" ;;
esac
bootstrap "profile selected"

if [ "$PORT" = "0" ]; then
    PORT="${PLAYWRIGHT_MCP_SHARED_PORT:-8931}"
fi
case "$PORT" in
    ''|*[!0-9]*) die "The shared Playwright MCP port must be between 1024 and 65535." ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
    die "The shared Playwright MCP port must be between 1024 and 65535."
fi

case "$RESTART_DELAY_SECONDS" in
    ''|*[!0-9]*) die "RestartDelaySeconds must be an integer between 0 and 300." ;;
esac
[ "$RESTART_DELAY_SECONDS" -le 300 ] || die "RestartDelaySeconds must be an integer between 0 and 300."
case "$MAX_RESTARTS" in
    -1) ;;
    ''|*[!0-9]*) die "MaxRestarts must be -1 (unlimited) or an integer between 0 and 1000000." ;;
    *) [ "$MAX_RESTARTS" -le 1000000 ] || die "MaxRestarts must be -1 (unlimited) or an integer between 0 and 1000000." ;;
esac

if [ "$DASHBOARD_PORT" = "-1" ]; then
    DASHBOARD_PORT="${PLAYWRIGHT_MCP_SHARED_DASHBOARD_PORT:-8932}"
fi
case "$DASHBOARD_PORT" in
    ''|*[!0-9]*) die "The dashboard port must be 0 (off) or a port between 1024 and 65535 other than the service port." ;;
esac
if [ "$DASHBOARD_PORT" -ne 0 ] && { [ "$DASHBOARD_PORT" -lt 1024 ] || [ "$DASHBOARD_PORT" -gt 65535 ] || [ "$DASHBOARD_PORT" -eq "$PORT" ]; }; then
    die "The dashboard port must be 0 (off) or a port between 1024 and 65535 other than the service port."
fi
DASHBOARD_SCRIPT="$SCRIPT_DIR/playwright-mcp-dashboard.mjs"

OUTPUTS_ROOT="$RUNTIME_ROOT/outputs/shared"
STATE_ROOT="$RUNTIME_ROOT/state"
mkdir -p "$OUTPUTS_ROOT" "$STATE_ROOT" "$PROFILE_PATH" \
    || die "Cannot create the runtime directories under '$RUNTIME_ROOT'."
bootstrap "runtime directories ready"
bootstrap "singleton lock acquired"

PID_PATH="$STATE_ROOT/shared-server.pid"
NODE_PID_PATH="$STATE_ROOT/shared-node.pid"
DASHBOARD_PID_PATH="$STATE_ROOT/dashboard.pid"
SERVER_PID_WRITTEN=0
OWN_NODE_PID=0
NODE_PID=""
NODE_IS_CHILD=0
DASHBOARD_PID=""
OWN_DASHBOARD_PID=0
STOPPING=0

read_pid_file() {
    tr -d '[:space:]' <"$1" 2>/dev/null
}

# Delete a PID file only while it still records this launcher's value, so a
# failed or superseded launcher never erases another supervisor's state.
remove_owned_pid_file() {
    local path="$1" value="$2"
    case "$value" in ''|*[!0-9]*) return 0 ;; esac
    [ "$value" -gt 0 ] && [ -f "$path" ] || return 0
    if [ "$(read_pid_file "$path")" = "$value" ]; then
        rm -f "$path"
    fi
}

stop_pid() {
    kill "$1" 2>/dev/null || true
    for _ in $(seq 1 40); do
        kill -0 "$1" 2>/dev/null || break
        sleep 0.25
    done
    if kill -0 "$1" 2>/dev/null; then
        kill -9 "$1" 2>/dev/null || true
    fi
}

process_cmdline() {
    # NUL-separated argv joined with single spaces, with a trailing space so a
    # final argument still ends on a separator.
    [ -r "/proc/$1/cmdline" ] || return 1
    tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null
}

process_name() {
    tr -d '\n' <"/proc/$1/comm" 2>/dev/null || printf 'unknown'
}

# A managed node is node running this runtime's MCP CLI for this profile and
# port. Anything else holding the port is never adopted.
managed_node() {
    local candidate="$1" cmdline
    case "$candidate" in ''|*[!0-9]*) return 1 ;; esac
    [ "$candidate" -gt 0 ] || return 1
    cmdline="$(process_cmdline "$candidate")" || return 1
    case "$cmdline" in *"$MCP_CLI "*) ;; *) return 1 ;; esac
    case "$cmdline" in *"--user-data-dir $PROFILE_PATH "*) ;; *) return 1 ;; esac
    case "$cmdline" in *"--port $PORT "*) ;; *) return 1 ;; esac
    return 0
}

# A managed dashboard is node running this launcher's dashboard script on the
# configured dashboard port.
managed_dashboard() {
    local candidate="$1" cmdline
    case "$candidate" in ''|*[!0-9]*) return 1 ;; esac
    [ "$candidate" -gt 0 ] || return 1
    cmdline="$(process_cmdline "$candidate")" || return 1
    case "$cmdline" in
        *"$DASHBOARD_SCRIPT "*"--port $DASHBOARD_PORT "*) return 0 ;;
    esac
    return 1
}

# PID of the process listening on the loopback port, 0 when nothing listens,
# and -1 when something listens but its owner is not visible to this user.
loopback_listener_pid() {
    local line pid
    if command -v ss >/dev/null 2>&1; then
        line="$(ss -ltnpH "sport = :$1" 2>/dev/null | head -n 1)"
        [ -n "$line" ] || { printf '0'; return 0; }
        pid="$(printf '%s' "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
        printf '%s' "${pid:--1}"
        return 0
    fi
    # Without ss the owner cannot be identified; a connect still guards the port.
    if (exec 8<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
        printf '%s' "-1"
    else
        printf '0'
    fi
}

cleanup() {
    if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
        # An adopted node is stopped only while it is still the managed one.
        if [ "$NODE_IS_CHILD" -eq 1 ] || managed_node "$NODE_PID"; then
            stop_pid "$NODE_PID"
        fi
    fi
    if [ -n "$DASHBOARD_PID" ] && kill -0 "$DASHBOARD_PID" 2>/dev/null; then
        stop_pid "$DASHBOARD_PID"
    fi
    if [ "$SERVER_PID_WRITTEN" -eq 1 ]; then
        remove_owned_pid_file "$PID_PATH" "$$"
    fi
    remove_owned_pid_file "$NODE_PID_PATH" "$OWN_NODE_PID"
    remove_owned_pid_file "$DASHBOARD_PID_PATH" "$OWN_DASHBOARD_PID"
}
# Traps go in before any PID file is written. A stop sets STOPPING so the
# supervisor loop never restarts the node it is taking down (node exits 0 on
# SIGTERM, which would otherwise look like an ordinary exit).
trap 'STOPPING=1; cleanup; exit 143' TERM
trap 'STOPPING=1; cleanup; exit 130' INT
trap cleanup EXIT

if [ -z "$NODE_PATH" ]; then
    if [ -n "${PLAYWRIGHT_MCP_SHARED_NODE:-}" ]; then
        NODE_PATH="$PLAYWRIGHT_MCP_SHARED_NODE"
    else
        NODE_PATH="$(command -v node || true)"
    fi
fi
[ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ] \
    || die "Node.js could not be resolved. Install Node.js, pass -NodePath, or set PLAYWRIGHT_MCP_SHARED_NODE."

# A previous supervisor can die (killed, session ended) while its node keeps
# serving. Adopt that node instead of failing on the port.
ADOPTED_PID=""
bootstrap "probing loopback port"
LISTENER_PID="$(loopback_listener_pid "$PORT")"
if [ "$LISTENER_PID" = "0" ] && [ -f "$NODE_PID_PATH" ]; then
    RECORDED_PID="$(read_pid_file "$NODE_PID_PATH")"
    if managed_node "$RECORDED_PID"; then
        # The recorded node may still be starting; give it bounded time to bind.
        bootstrap "recorded Playwright MCP node process is alive but not listening; waiting"
        DEADLINE=$(( $(date +%s) + 30 ))
        while [ "$LISTENER_PID" = "0" ] && [ "$(date +%s)" -lt "$DEADLINE" ] && kill -0 "$RECORDED_PID" 2>/dev/null; do
            sleep 0.5
            LISTENER_PID="$(loopback_listener_pid "$PORT")"
        done
    fi
fi
if [ "$LISTENER_PID" != "0" ]; then
    if [ "$LISTENER_PID" = "-1" ]; then
        die "Loopback port $PORT is already in use."
    fi
    if ! managed_node "$LISTENER_PID"; then
        die "Loopback port $PORT is already in use by process $LISTENER_PID ($(process_name "$LISTENER_PID")), which is not this runtime's managed Playwright MCP node."
    fi
    ADOPTED_PID="$LISTENER_PID"
    bootstrap "loopback port owned by the managed Playwright MCP node process"
else
    bootstrap "loopback port available"
fi

printf '%s' "$$" >"$PID_PATH" || die "Cannot write '$PID_PATH'."
SERVER_PID_WRITTEN=1

STDOUT_LOG="$LOGS_ROOT/shared-server.stdout.log"
STDERR_LOG="$LOGS_ROOT/shared-server.stderr.log"
export PLAYWRIGHT_MCP_PING_TIMEOUT_MS="0"

MCP_ARGUMENTS=(
    "$MCP_CLI"
    --browser chrome
    --user-data-dir "$PROFILE_PATH"
    --output-dir "$OUTPUTS_ROOT"
    --port "$PORT"
    --host 127.0.0.1
    --shared-browser-context
)
[ "$HEADLESS" -eq 1 ] && MCP_ARGUMENTS+=(--headless)

if [ "$DASHBOARD_PORT" -ne 0 ] && [ ! -f "$DASHBOARD_SCRIPT" ]; then
    bootstrap "dashboard script missing; dashboard disabled"
    DASHBOARD_PORT=0
fi

# Keep the dashboard running beside the node, the way the Windows supervisor
# does: restart it with a doubling backoff when it exits, and adopt one a
# previous launcher left running. It reconnects to the service on its own, so
# a node restart does not restart it.
DASHBOARD_NEXT_START=0
DASHBOARD_BACKOFF=5
ensure_dashboard() {
    [ "$DASHBOARD_PORT" -ne 0 ] || return 0
    if [ -n "$DASHBOARD_PID" ]; then
        kill -0 "$DASHBOARD_PID" 2>/dev/null && return 0
        bootstrap "dashboard process exited; restarting after $DASHBOARD_BACKOFF seconds"
        remove_owned_pid_file "$DASHBOARD_PID_PATH" "$OWN_DASHBOARD_PID"
        OWN_DASHBOARD_PID=0
        DASHBOARD_PID=""
        DASHBOARD_NEXT_START=$(( $(date +%s) + DASHBOARD_BACKOFF ))
        DASHBOARD_BACKOFF=$(( DASHBOARD_BACKOFF * 2 ))
        [ "$DASHBOARD_BACKOFF" -gt 300 ] && DASHBOARD_BACKOFF=300
        return 0
    fi
    [ "$(date +%s)" -ge "$DASHBOARD_NEXT_START" ] || return 0
    if [ -f "$DASHBOARD_PID_PATH" ]; then
        local recorded
        recorded="$(read_pid_file "$DASHBOARD_PID_PATH")"
        if managed_dashboard "$recorded"; then
            DASHBOARD_PID="$recorded"
            OWN_DASHBOARD_PID="$recorded"
            bootstrap "dashboard process adopted"
            return 0
        fi
    fi
    local dashboard_args=(
        "$DASHBOARD_SCRIPT"
        --runtime-root "$RUNTIME_ROOT"
        --mcp-port "$PORT"
        --port "$DASHBOARD_PORT"
        --profile "$PROFILE_PATH"
        --node-pid-file "$NODE_PID_PATH"
        --mcp-cli "$MCP_CLI"
    )
    "$NODE_PATH" "${dashboard_args[@]}" \
        >>"$LOGS_ROOT/dashboard.stdout.log" 2>>"$LOGS_ROOT/dashboard.stderr.log" </dev/null 9>&- &
    DASHBOARD_PID=$!
    OWN_DASHBOARD_PID="$DASHBOARD_PID"
    printf '%s' "$OWN_DASHBOARD_PID" >"$DASHBOARD_PID_PATH"
    bootstrap "dashboard process started pid=$DASHBOARD_PID"
}

# Sleep in a background child and wait on it, so TERM/INT traps run at once.
pause() {
    sleep "$1" 9>&- &
    wait "$!" 2>/dev/null || true
}

RESTART_COUNT=0
NODE_PATH_VERIFIED=0
while true; do
    if [ -n "$ADOPTED_PID" ]; then
        NODE_PID="$ADOPTED_PID"
        NODE_IS_CHILD=0
        ADOPTED_PID=""
        bootstrap "Playwright MCP node process adopted pid=$NODE_PID"
    else
        if [ "$NODE_PATH_VERIFIED" -eq 0 ]; then
            NODE_PATH_VERIFIED=1
            bootstrap "Node.js executable verified"
        fi
        bootstrap "starting Playwright MCP node process"
        "$NODE_PATH" "${MCP_ARGUMENTS[@]}" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" </dev/null 9>&- &
        NODE_PID=$!
        NODE_IS_CHILD=1
        bootstrap "Playwright MCP node process started pid=$NODE_PID"
    fi
    OWN_NODE_PID="$NODE_PID"
    printf '%s' "$OWN_NODE_PID" >"$NODE_PID_PATH"

    # Poll every two seconds rather than a bare wait, so the dashboard is kept
    # running and an adopted node (not a child of this shell) is watched too.
    ensure_dashboard
    while kill -0 "$NODE_PID" 2>/dev/null; do
        pause 2
        ensure_dashboard
    done
    if [ "$NODE_IS_CHILD" -eq 1 ]; then
        wait "$NODE_PID" 2>/dev/null
        NODE_EXIT_CODE=$?
    else
        # An adopted node's exit status is not observable from here.
        NODE_EXIT_CODE="unknown"
    fi
    NODE_PID=""
    remove_owned_pid_file "$NODE_PID_PATH" "$OWN_NODE_PID"
    OWN_NODE_PID=0

    if [ "$STOPPING" -eq 1 ]; then
        exit 143
    fi
    if [ "$MAX_RESTARTS" -ge 0 ] && [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
        bootstrap "Playwright MCP node process exited with code $NODE_EXIT_CODE; restart limit reached"
        case "$NODE_EXIT_CODE" in
            ''|*[!0-9]*) exit 1 ;;
            *) exit "$NODE_EXIT_CODE" ;;
        esac
    fi

    RESTART_COUNT=$(( RESTART_COUNT + 1 ))
    bootstrap "Playwright MCP node process exited with code $NODE_EXIT_CODE; restarting after $RESTART_DELAY_SECONDS seconds"
    if [ "$RESTART_DELAY_SECONDS" -gt 0 ]; then
        pause "$RESTART_DELAY_SECONDS"
    fi
done
