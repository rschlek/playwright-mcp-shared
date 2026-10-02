#!/usr/bin/env python3
"""Cross-platform lease for serializing shared-browser authentication changes."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


def runtime_root() -> Path:
    override = os.environ.get("PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT") or os.environ.get(
        "SPRO_BROWSER_RUNTIME_ROOT"
    )
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            raise RuntimeError("LOCALAPPDATA is unavailable")
        canonical = Path(base) / "playwright-mcp-shared"
        legacy = Path(base) / "spro-ai" / "playwright-mcp"
    else:
        canonical = Path.home() / "Library" / "Application Support" / "playwright-mcp-shared"
        legacy = Path.home() / "Library" / "Application Support" / "spro-ai" / "playwright-mcp"
    return legacy if not canonical.exists() and legacy.exists() else canonical


def now() -> datetime:
    return datetime.now(timezone.utc)


def read_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise RuntimeError("Authentication lease state is invalid JSON") from exc


def active(state: dict) -> bool:
    try:
        return state.get("state") == "held" and datetime.fromisoformat(state["expires_utc"]) > now()
    except (KeyError, TypeError, ValueError):
        return False


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.replace(temp, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("acquire", "renew", "release", "status"))
    parser.add_argument("--owner", default="")
    parser.add_argument("--lease-id", default="")
    parser.add_argument("--ttl", type=int, default=900)
    args = parser.parse_args()
    if not 30 <= args.ttl <= 3600:
        raise SystemExit("--ttl must be between 30 and 3600 seconds")

    path = runtime_root() / "locks" / "auth-flow.json"
    lock = path.with_suffix(".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 5
    fd = None
    while time.monotonic() < deadline:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 10:
                    lock.unlink()
            except FileNotFoundError:
                pass
            time.sleep(0.05)
    if fd is None:
        raise SystemExit("Authentication lease file remained busy")

    try:
        state = read_state(path)
        held = active(state)
        if args.action == "status":
            result = {"available": not held}
            if held:
                result.update(owner=state.get("owner"), expires_utc=state.get("expires_utc"))
            print(json.dumps(result))
            return 0
        if args.action == "acquire":
            if not args.owner or len(args.owner) > 80:
                raise SystemExit("--owner is required and must be at most 80 characters")
            if held:
                print(json.dumps({"acquired": False, "reason": "busy", "owner": state.get("owner")}))
                return 75
            lease_id = secrets.token_hex(16)
            expiry = now() + timedelta(seconds=args.ttl)
            state = {"schema": 1, "state": "held", "lease_id": lease_id,
                     "owner": args.owner, "expires_utc": expiry.isoformat()}
            write_state(path, state)
            print(json.dumps({"acquired": True, "lease_id": lease_id,
                              "expires_utc": expiry.isoformat()}))
            return 0
        if not held or state.get("lease_id") != args.lease_id:
            print(json.dumps({"success": False, "reason": "lease-mismatch-or-expired"}))
            return 76
        if args.action == "renew":
            state["expires_utc"] = (now() + timedelta(seconds=args.ttl)).isoformat()
            write_state(path, state)
        else:
            write_state(path, {"schema": 1, "state": "free", "released_utc": now().isoformat()})
        print(json.dumps({"success": True, "action": args.action}))
        return 0
    finally:
        os.close(fd)
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
