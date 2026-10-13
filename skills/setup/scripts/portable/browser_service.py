#!/usr/bin/env python3
"""Launch the managed, loopback-only Playwright MCP service."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from pathlib import Path


DEFAULT_DASHBOARD_PORT = 8932


def start_dashboard(root: Path, state: dict, port: int, profile: Path, logs: Path,
                    creationflags: int) -> subprocess.Popen | None:
    """Start the live launch-tab dashboard beside the service, when installed."""
    dashboard_port = int(state.get("dashboard_port", DEFAULT_DASHBOARD_PORT))
    script = root / "bin" / "playwright-mcp-dashboard.mjs"
    if dashboard_port == 0 or not script.is_file():
        return None
    args = [state["node"], str(script), "--runtime-root", str(root), "--mcp-port", str(port),
            "--port", str(dashboard_port), "--profile", str(profile),
            "--node-pid-file", str(root / "state" / "node.pid"),
            "--mcp-cli", str(root / "package" / "node_modules" / "@playwright" / "mcp" / "cli.js")]
    with (logs / "dashboard.stdout.log").open("ab") as stdout, (logs / "dashboard.stderr.log").open("ab") as stderr:
        process = subprocess.Popen(args, stdout=stdout, stderr=stderr, creationflags=creationflags)
    (root / "state" / "dashboard.pid").write_text(str(process.pid), encoding="utf-8")
    return process


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    state_path = root / "state" / "config.json"
    if not state_path.exists():
        print(f"Missing browser state: {state_path}", file=sys.stderr)
        return 70
    state = json.loads(state_path.read_text(encoding="utf-8"))
    port = int(state["port"])
    cli = root / "package" / "node_modules" / "@playwright" / "mcp" / "cli.js"
    profile = Path(state["profile"])
    output = root / "outputs"
    logs = root / "logs"
    for path in (profile, output, logs, root / "state"):
        path.mkdir(parents=True, exist_ok=True)

    probe = socket.socket()
    try:
        probe.bind(("127.0.0.1", port))
    except OSError:
        print(f"Playwright MCP port {port} is already in use", file=sys.stderr)
        return 75
    finally:
        probe.close()

    service_pid = root / "state" / "service.pid"
    service_pid.write_text(str(os.getpid()), encoding="utf-8")

    node = state["node"]
    args = [node, str(cli), "--browser", "chrome", "--user-data-dir", str(profile),
            "--output-dir", str(output), "--port", str(port), "--host", "127.0.0.1",
            "--shared-browser-context"]
    env = dict(os.environ)
    env["PLAYWRIGHT_MCP_PING_TIMEOUT_MS"] = "0"
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        with (logs / "server.stdout.log").open("ab") as stdout, (logs / "server.stderr.log").open("ab") as stderr:
            process = subprocess.Popen(args, stdout=stdout, stderr=stderr, env=env,
                                       creationflags=creationflags)
            (root / "state" / "node.pid").write_text(str(process.pid), encoding="utf-8")
            dashboard = start_dashboard(root, state, port, profile, logs, creationflags)
            try:
                return process.wait()
            finally:
                for name, child in (("node.pid", None), ("dashboard.pid", dashboard)):
                    if child is not None and child.poll() is None:
                        child.terminate()
                    try:
                        (root / "state" / name).unlink()
                    except FileNotFoundError:
                        pass
    finally:
        try:
            service_pid.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
