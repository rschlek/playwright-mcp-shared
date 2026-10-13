#!/usr/bin/env bash
# Linux sibling of install-playwright-mcp-shared-autostart.ps1: a systemd --user
# unit replaces the scheduled task. No root at any point.
#
# Why graphical-session.target and not default.target: the service launches a
# HEADED Chrome, so it must start only once the desktop session has published
# DISPLAY / WAYLAND_DISPLAY / XAUTHORITY into the user manager's environment
# (desktop sessions do that with dbus-update-activation-environment --systemd).
# graphical-session.target is reached after that, so After= + WantedBy= it is
# both the correct ordering and the correct enablement. PartOf= makes the
# service stop when the session ends instead of outliving it and orphaning the
# profile lock. This script also runs `systemctl --user import-environment`
# from the graphical shell that invoked it, so the unit can start immediately
# without waiting for the next login. ExecStartPre=import-environment would NOT
# work: import-environment copies from the CALLING process, and inside the unit
# that caller is the service itself, which has no DISPLAY.
#
# Restart=always with RestartSec=5 replaces the task's repeating relaunch
# trigger: a supervisor that dies for any reason is started again, and the new
# one adopts the node still serving. systemd never restarts a unit after an
# explicit `systemctl --user stop` or a stop propagated from the session
# through PartOf=, so a managed stop stays stopped.
set -uo pipefail

RUNTIME_ROOT=""
PROFILE_PATH=""
NODE_PATH=""
PORT=8931
# Loopback port of the live dashboard shown in the launch tab; 0 turns it off.
DASHBOARD_PORT=8932
START=0
UNIT_NAME="playwright-mcp-shared"

die() {
    printf '%s\n' "Shared Playwright MCP autostart install failed: $1" >&2
    exit 70
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -RuntimeRoot|--runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
        -ProfilePath|--profile-path) PROFILE_PATH="${2:-}"; shift 2 ;;
        -NodePath|--node-path) NODE_PATH="${2:-}"; shift 2 ;;
        -Port|--port) PORT="${2:-8931}"; shift 2 ;;
        -DashboardPort|--dashboard-port) DASHBOARD_PORT="${2:-}"; shift 2 ;;
        -UnitName|--unit-name) UNIT_NAME="${2:-}"; shift 2 ;;
        -Start|--start) START=1; shift ;;
        *) die "Unknown argument '$1'." ;;
    esac
done

case "$UNIT_NAME" in
    ''|*[!A-Za-z0-9_.@-]*) die "The unit name may contain only letters, digits, and _ . @ -." ;;
esac
UNIT_NAME="${UNIT_NAME%.service}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || die "Cannot resolve the installer directory."
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

[ -n "$PROFILE_PATH" ] || PROFILE_PATH="$RUNTIME_ROOT/profiles/shared"
case "$PROFILE_PATH" in /*) ;; *) PROFILE_PATH="$PWD/$PROFILE_PATH" ;; esac

case "$PORT" in
    ''|*[!0-9]*) die "The shared Playwright MCP port must be between 1024 and 65535." ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
    die "The shared Playwright MCP port must be between 1024 and 65535."
fi
case "$DASHBOARD_PORT" in
    ''|*[!0-9]*) die "The dashboard port must be 0 (off) or a port between 1024 and 65535 other than the service port." ;;
esac
if [ "$DASHBOARD_PORT" -ne 0 ] && { [ "$DASHBOARD_PORT" -lt 1024 ] || [ "$DASHBOARD_PORT" -gt 65535 ] || [ "$DASHBOARD_PORT" -eq "$PORT" ]; }; then
    die "The dashboard port must be 0 (off) or a port between 1024 and 65535 other than the service port."
fi

SERVER_SCRIPT="$RUNTIME_ROOT/bin/playwright-mcp-shared.sh"
[ -f "$SERVER_SCRIPT" ] || die "The installed shared-server launcher is missing at '$SERVER_SCRIPT'."

command -v systemctl >/dev/null 2>&1 || die "systemctl is unavailable; this host has no systemd --user session."
BASH_BIN="$(command -v bash || true)"
[ -n "$BASH_BIN" ] || die "bash is not on PATH."

# The user manager's PATH is minimal, so record a stable Node.js path the way
# the Windows installer does instead of relying on PATH inside the unit.
if [ -z "$NODE_PATH" ]; then
    if [ -n "${PLAYWRIGHT_MCP_SHARED_NODE:-}" ]; then
        NODE_PATH="$PLAYWRIGHT_MCP_SHARED_NODE"
    else
        NODE_PATH="$(command -v node || true)"
    fi
fi
[ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ] \
    || die "Node.js could not be resolved. Install Node.js, pass -NodePath, or set PLAYWRIGHT_MCP_SHARED_NODE."
NODE_PATH="$(readlink -f "$NODE_PATH")"

# systemd splits ExecStart= on whitespace and expands % specifiers and $
# variables; quote each argument and double any % and $.
unit_quote() {
    local value="${1//%/%%}"
    value="${value//\$/\$\$}"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
}
json_string() {
    local value="${1//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
}

STATE_ROOT="$RUNTIME_ROOT/state"
mkdir -p "$STATE_ROOT" || die "Cannot create '$STATE_ROOT'."
SERVICE_CONFIG_PATH="$STATE_ROOT/linux-service-config.json"
cat >"$SERVICE_CONFIG_PATH.new" <<CONFIG || die "Cannot write '$SERVICE_CONFIG_PATH'."
{
  "RuntimeRoot": $(json_string "$RUNTIME_ROOT"),
  "ProfilePath": $(json_string "$PROFILE_PATH"),
  "NodePath": $(json_string "$NODE_PATH"),
  "Port": $PORT,
  "DashboardPort": $DASHBOARD_PORT,
  "UnitName": $(json_string "$UNIT_NAME")
}
CONFIG
mv "$SERVICE_CONFIG_PATH.new" "$SERVICE_CONFIG_PATH" || die "Cannot write '$SERVICE_CONFIG_PATH'."

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME.service"
mkdir -p "$UNIT_DIR" || die "Cannot create '$UNIT_DIR'."

EXEC_START="$(unit_quote "$BASH_BIN") $(unit_quote "$SERVER_SCRIPT") -RuntimeRoot $(unit_quote "$RUNTIME_ROOT") -ProfilePath $(unit_quote "$PROFILE_PATH") -NodePath $(unit_quote "$NODE_PATH") -Port $PORT -DashboardPort $DASHBOARD_PORT"

TMP_UNIT="$UNIT_PATH.new"
cat >"$TMP_UNIT" <<UNIT || die "Cannot write '$UNIT_PATH'."
[Unit]
Description=Shared Playwright MCP browser service
Documentation=https://github.com/rschlek/playwright-mcp-shared
# Needs the graphical session: the service owns a HEADED Chrome on the shared
# profile, so it must start after the session publishes DISPLAY /
# WAYLAND_DISPLAY into the user manager, and stop with the session rather than
# outliving it.
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
Environment=PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0
ExecStart=$EXEC_START
# A supervisor that dies for any reason comes back and adopts the running node.
# An explicit stop, or one propagated from the session, is never restarted.
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=graphical-session.target
UNIT
mv "$TMP_UNIT" "$UNIT_PATH" || die "Cannot write '$UNIT_PATH'."

# Publish the graphical-session variables the headed Chrome needs into the user
# manager. Harmless and idempotent when the session has already done it.
for VARIABLE in DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE XAUTHORITY; do
    if [ -n "${!VARIABLE:-}" ]; then
        systemctl --user import-environment "$VARIABLE" >/dev/null 2>&1 || true
    fi
done

systemctl --user daemon-reload || die "systemctl --user daemon-reload failed."
if [ "$START" -eq 1 ]; then
    # restart, not start: re-running the installer after an upgrade must put the
    # new launcher and package in service. It restarts the browser.
    systemctl --user enable "$UNIT_NAME" || die "systemctl --user enable $UNIT_NAME failed."
    systemctl --user restart "$UNIT_NAME" || die "systemctl --user restart $UNIT_NAME failed."
else
    systemctl --user enable "$UNIT_NAME" || die "systemctl --user enable $UNIT_NAME failed."
fi

ENABLED="$(systemctl --user is-enabled "$UNIT_NAME" 2>&1 || true)"
ACTIVE="$(systemctl --user is-active "$UNIT_NAME" 2>&1 || true)"
printf '%s\n' "Unit             : $UNIT_PATH"
printf '%s\n' "RuntimeRoot      : $RUNTIME_ROOT"
printf '%s\n' "ProfilePath      : $PROFILE_PATH"
printf '%s\n' "NodePath         : $NODE_PATH"
printf '%s\n' "Port             : $PORT"
printf '%s\n' "DashboardPort    : $DASHBOARD_PORT"
printf '%s\n' "ServiceConfigPath: $SERVICE_CONFIG_PATH"
printf '%s\n' "Enabled          : $ENABLED"
printf '%s\n' "Active           : $ACTIVE"
printf '%s\n' "Started          : $([ "$START" -eq 1 ] && echo true || echo false)"

if [ "$START" -eq 1 ] && [ "$ACTIVE" != "active" ]; then
    die "the unit did not reach active state; inspect 'journalctl --user -u $UNIT_NAME'."
fi
exit 0
