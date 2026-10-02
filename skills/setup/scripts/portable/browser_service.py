#!/usr/bin/env python3
"""Launch the managed, loopback-only Playwright MCP service."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from pathlib import Path


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
            try:
                return process.wait()
            finally:
                try:
                    (root / "state" / "node.pid").unlink()
                except FileNotFoundError:
                    pass
    finally:
        try:
            service_pid.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
