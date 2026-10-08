#!/usr/bin/env python3
"""Cross-platform registry of which agent session uses which shared-browser tab.

A claim is a cooperative label shown on the dashboard, not a lock. Entries
expire after their TTL so a session that ends without releasing drops off.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit


MAX_CLAIMS = 200
OWNER_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")
CLAIM_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
EXIT_ERROR = 70
EXIT_MISMATCH = 76


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


def parse_time(value: object) -> datetime:
    text = str(value)
    # Python before 3.11 does not accept a trailing Z or 7-digit fractions.
    text = text.replace("Z", "+00:00")
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def redact_url(value: str) -> str:
    """Keep scheme, host, and path; never record a query or fragment."""
    parts = urlsplit(value)
    if not parts.scheme or (parts.scheme in ("http", "https") and not parts.netloc):
        raise ValueError("--url must be an absolute URL")
    if parts.scheme in ("http", "https"):
        # Never keep user information; omit a default port like browsers do.
        host = parts.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        port = parts.port
        if port and port != {"http": 80, "https": 443}[parts.scheme]:
            host = f"{host}:{port}"
        return f"{parts.scheme}://{host}{parts.path or '/'}"
    return f"{parts.scheme}:{parts.path}"


def read_claims(path: Path) -> list[dict]:
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return []
    if not raw.strip():
        return []
    try:
        state = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("The tab-claim registry is invalid JSON") from exc
    claims = state.get("claims") if isinstance(state, dict) else None
    return [claim for claim in claims or [] if isinstance(claim, dict)]


def active_claims(claims: list[dict]) -> list[dict]:
    current = now()
    kept = []
    for claim in claims:
        try:
            if CLAIM_ID_PATTERN.match(str(claim.get("claim_id", ""))) and parse_time(
                claim["expires_utc"]
            ) > current:
                kept.append(claim)
        except (KeyError, TypeError, ValueError):
            continue
    return kept


def write_claims(path: Path, claims: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"schema": 1, "claims": claims}, sort_keys=True), encoding="utf-8")
    os.replace(temp, path)


def emit(value: dict) -> None:
    print(json.dumps(value))


def run(args: argparse.Namespace) -> int:
    if args.action == "claim":
        if not OWNER_PATTERN.match(args.owner):
            raise ValueError(
                "--owner must be 1-80 characters using letters, digits, period, underscore, colon, or hyphen"
            )
        if len(args.task) > 120 or re.search(r"[\x00-\x1f\x7f]", args.task):
            raise ValueError("--task must be at most 120 printable characters")
        if not args.url:
            raise ValueError("claim requires --url, the URL the tab was opened at")
        args.url = redact_url(args.url)
    if args.action in ("renew", "release") and not CLAIM_ID_PATTERN.match(args.claim_id):
        raise ValueError(f"{args.action} requires a valid --claim-id")
    if args.action == "renew" and args.url:
        args.url = redact_url(args.url)
    if not 60 <= args.ttl <= 86400:
        raise ValueError("--ttl must be between 60 and 86400 seconds")

    path = runtime_root() / "locks" / "tab-claims.json"
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
        raise RuntimeError("The tab-claim registry remained busy for five seconds")

    try:
        claims = active_claims(read_claims(path))
        if args.action in ("list", "status"):
            public = [
                {key: claim.get(key, "") for key in ("owner", "task", "url", "claimed_utc", "expires_utc")}
                for claim in claims
            ]
            emit({"action": "list", "count": len(public), "claims": public})
            return 0
        stamp = now()
        if args.action == "claim":
            if len(claims) >= MAX_CLAIMS:
                raise RuntimeError(f"The tab-claim registry already holds {MAX_CLAIMS} active claims")
            claim_id = secrets.token_hex(16)
            expiry = (stamp + timedelta(seconds=args.ttl)).isoformat()
            claims.append({
                "claim_id": claim_id, "owner": args.owner, "task": args.task, "url": args.url,
                "claimed_utc": stamp.isoformat(), "renewed_utc": stamp.isoformat(), "expires_utc": expiry,
            })
            write_claims(path, claims)
            emit({"action": "claim", "claimed": True, "claim_id": claim_id, "owner": args.owner,
                  "url": args.url, "expires_utc": expiry})
            return 0
        match = next((claim for claim in claims if claim.get("claim_id") == args.claim_id), None)
        if match is None:
            write_claims(path, claims)
            emit({"action": args.action, "success": False, "reason": "claim-not-found-or-expired"})
            return EXIT_MISMATCH
        if args.action == "renew":
            match["renewed_utc"] = stamp.isoformat()
            match["expires_utc"] = (stamp + timedelta(seconds=args.ttl)).isoformat()
            if args.url:
                match["url"] = args.url
            write_claims(path, claims)
            emit({"action": "renew", "success": True, "claim_id": args.claim_id,
                  "url": match["url"], "expires_utc": match["expires_utc"]})
            return 0
        claims.remove(match)
        write_claims(path, claims)
        emit({"action": "release", "success": True})
        return 0
    finally:
        os.close(fd)
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("claim", "renew", "release", "list", "status"))
    parser.add_argument("--owner", default="")
    parser.add_argument("--task", default="")
    parser.add_argument("--url", default="")
    parser.add_argument("--claim-id", default="")
    parser.add_argument("--ttl", type=int, default=3600)
    args = parser.parse_args()
    try:
        return run(args)
    except (ValueError, RuntimeError, OSError) as exc:
        emit({"action": args.action, "success": False, "reason": "error", "message": str(exc)})
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
