#!/usr/bin/env bash
# Linux sibling of stop-playwright-mcp-shared.ps1. Stops the systemd --user
# unit when it runs this runtime's launcher, then validates each managed PID
# against /proc/<pid>/cmdline before signalling it, the way the PowerShell
# version validates Win32_Process.CommandLine.
set -uo pipefail

RUNTIME_ROOT=""
PORT=0
UNIT_NAME=""

die() {
    printf '%s\n' "Shared Playwright MCP stop failed: $1" >&2
    exit 70
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -RuntimeRoot|--runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
        -Port|--port) PORT="${2:-0}"; shift 2 ;;
        -UnitName|--unit-name) UNIT_NAME="${2:-}"; shift 2 ;;
        *) die "Unknown argument '$1'." ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || die "Cannot resolve the stop script directory."
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
case "$RUNTIME_ROOT" in /*) ;; *) RUNTIME_ROOT="$PWD/$RUNTIME_ROOT" ;; esac

STATE_ROOT="$RUNTIME_ROOT/state"
CONFIG_PATH="$STATE_ROOT/linux-service-config.json"
EXPECTED_CLI="$RUNTIME_ROOT/package/node_modules/@playwright/mcp/cli.js"
EXPECTED_SERVER="$RUNTIME_ROOT/bin/playwright-mcp-shared.sh"
EXPECTED_DASHBOARD="$RUNTIME_ROOT/bin/playwright-mcp-dashboard.mjs"

# Read one top-level value written by the installer (string or number).
config_value() {
    [ -f "$CONFIG_PATH" ] || return 0
    sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\}[[:space:]]*,\{0,1\}[[:space:]]*\$/\1/p" \
        "$CONFIG_PATH" | head -n 1
}
CONFIGURED_CLI="$(config_value McpCli)"
[ -n "$CONFIGURED_CLI" ] && EXPECTED_CLI="$CONFIGURED_CLI"
if [ "$PORT" = "0" ]; then
    PORT="$(config_value Port)"
fi
if [ -z "$PORT" ] || [ "$PORT" = "0" ]; then
    PORT="${PLAYWRIGHT_MCP_SHARED_PORT:-8931}"
fi
case "$PORT" in ''|*[!0-9]*) die "The port must be numeric." ;; esac
[ -n "$UNIT_NAME" ] || UNIT_NAME="$(config_value UnitName)"
[ -n "$UNIT_NAME" ] || UNIT_NAME="playwright-mcp-shared"
UNIT_NAME="${UNIT_NAME%.service}"

# Stop the unit only when it runs this runtime's launcher, so stopping a
# disposable runtime never takes down another runtime's service.
UNIT_STOPPED=0
if command -v systemctl >/dev/null 2>&1; then
    UNIT_EXEC="$(systemctl --user show -p ExecStart --value "$UNIT_NAME.service" 2>/dev/null || true)"
    case "$UNIT_EXEC" in
        *"$EXPECTED_SERVER"*)
            # Stop the unit before any process so its Restart= policy cannot
            # bring the supervisor back mid-stop. An explicit stop is never
            # restarted.
            systemctl --user stop "$UNIT_NAME.service" >/dev/null 2>&1 \
                || die "systemctl --user stop $UNIT_NAME failed."
            UNIT_STOPPED=1
            ;;
    esac
fi

stop_validated_process() {
    local pid_path="$1" expected_name="$2" fragment="$3" managed_pid cmdline name
    [ -f "$pid_path" ] || return 0
    managed_pid="$(tr -d '[:space:]' <"$pid_path")"
    case "$managed_pid" in
        ''|*[!0-9]*) die "Invalid managed PID file '$pid_path'." ;;
    esac
    if [ -d "/proc/$managed_pid" ]; then
        name="$(tr -d '\n' <"/proc/$managed_pid/comm" 2>/dev/null || true)"
        cmdline="$(tr '\0' ' ' <"/proc/$managed_pid/cmdline" 2>/dev/null || true)"
        case "$name:$cmdline" in
            "$expected_name:"*"$fragment"*)
                kill "$managed_pid" 2>/dev/null || true
                for _ in $(seq 1 40); do
                    [ -d "/proc/$managed_pid" ] || break
                    sleep 0.25
                done
                if [ -d "/proc/$managed_pid" ]; then
                    kill -9 "$managed_pid" 2>/dev/null || true
                fi
                ;;
            *)
                # The recorded process is gone and its PID was reused. Never
                # stop it; the PID file is stale, so discard it.
                printf '%s\n' "PID $managed_pid does not match the managed Playwright command; refusing to stop it and discarding the stale PID file." >&2
                ;;
        esac
    fi
    rm -f "$pid_path"
}

# Stop the supervisor first so an intentional stop does not trigger a restart
# of the node it supervises.
stop_validated_process "$STATE_ROOT/shared-server.pid" "bash" "$EXPECTED_SERVER"
stop_validated_process "$STATE_ROOT/shared-node.pid" "node" "$EXPECTED_CLI"
stop_validated_process "$STATE_ROOT/dashboard.pid" "node" "$EXPECTED_DASHBOARD"

port_listening() {
    if command -v ss >/dev/null 2>&1; then
        [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ] && return 0
        return 1
    fi
    (exec 8<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

STOPPED=0
for _ in $(seq 1 80); do
    if ! port_listening "$PORT"; then
        STOPPED=1
        break
    fi
    sleep 0.25
done
[ "$STOPPED" -eq 1 ] || die "Shared Playwright MCP port $PORT is still listening after the managed stop."

# The unit restarts 5 seconds after an unexpected exit. Watch it for longer
# than that to prove the stop held.
if [ "$UNIT_STOPPED" -eq 1 ]; then
    for _ in $(seq 1 16); do
        STATE="$(systemctl --user is-active "$UNIT_NAME.service" 2>/dev/null || true)"
        case "$STATE" in
            active|activating|reloading)
                die "the $UNIT_NAME unit became $STATE again after the managed stop; inspect 'journalctl --user -u $UNIT_NAME'."
                ;;
        esac
        sleep 0.5
    done
fi

printf '%s\n' "Shared Playwright MCP server stopped."
exit 0
