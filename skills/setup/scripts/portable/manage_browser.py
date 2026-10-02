#!/usr/bin/env python3
"""Install and manage the shared Playwright MCP runtime."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path


PACKAGE_VERSION = "0.0.79"
DEFAULT_PORT = 8931
RUN_VALUE = "PlaywrightMCPShared"
LEGACY_RUN_VALUE = "SPROPlaywrightMCP"
MACOS_LABEL = "com.playwright-mcp-shared.service"
LEGACY_MACOS_LABEL = "com.cisco.spro.playwright-mcp"


def root() -> Path:
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
    if sys.platform == "darwin":
        canonical = Path.home() / "Library" / "Application Support" / "playwright-mcp-shared"
        legacy = Path.home() / "Library" / "Application Support" / "spro-ai" / "playwright-mcp"
    if sys.platform not in ("win32", "darwin"):
        raise RuntimeError("Shared Playwright MCP supports Windows and macOS only")
    return legacy if not canonical.exists() and legacy.exists() else canonical


def which(names: tuple[str, ...]) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return str(Path(found).resolve())
    return None


def chrome_path() -> str | None:
    candidates: list[Path] = []
    if sys.platform == "win32":
        for env_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env_name)
            if base:
                candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    elif sys.platform == "darwin":
        candidates.append(Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    return next((str(p) for p in candidates if p.is_file()), None)


def port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def state_path() -> Path:
    return root() / "state" / "config.json"


def read_state() -> dict:
    try:
        return json.loads(state_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_state(state: dict) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(temp, path)


def validate_profile(path: Path, adopting: bool, managed_profile: Path | None = None) -> None:
    everyday_roots = []
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        everyday_roots.append(Path(os.environ["LOCALAPPDATA"]) / "Google" / "Chrome" / "User Data")
    elif sys.platform == "darwin":
        everyday_roots.append(Path.home() / "Library" / "Application Support" / "Google" / "Chrome")
    resolved = path.resolve()
    for everyday in everyday_roots:
        try:
            resolved.relative_to(everyday.resolve())
        except ValueError:
            continue
        raise RuntimeError("Refusing to use an everyday Chrome user-data directory")
    if path.exists() and any((path / marker).exists() for marker in
                             ("SingletonLock", "SingletonCookie", "SingletonSocket")):
        if managed_profile is None or resolved != managed_profile.resolve():
            raise RuntimeError("The selected profile appears to be owned by another process")
    if (path.exists() and any(path.iterdir()) and not adopting and
            (managed_profile is None or resolved != managed_profile.resolve())):
        raise RuntimeError("A non-empty profile requires --adopt-existing-profile")


def install_autostart(runtime: Path) -> None:
    pythonw = Path(sys.executable).with_name("pythonw.exe") if sys.platform == "win32" else Path(sys.executable)
    service = runtime / "bin" / "browser_service.py"
    if sys.platform == "win32":
        import winreg
        command = f'"{pythonw}" "{service}"'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                              r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
            winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, command)
    else:
        launch_dir = Path.home() / "Library" / "LaunchAgents"
        launch_dir.mkdir(parents=True, exist_ok=True)
        plist = launch_dir / f"{MACOS_LABEL}.plist"
        plist.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{MACOS_LABEL}</string>
<key>ProgramArguments</key><array><string>{pythonw}</string><string>{service}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>''', encoding="utf-8")


def remove_autostart() -> None:
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                                winreg.KEY_SET_VALUE) as key:
                for value_name in (RUN_VALUE, LEGACY_RUN_VALUE):
                    try:
                        winreg.DeleteValue(key, value_name)
                    except FileNotFoundError:
                        pass
        except FileNotFoundError:
            pass
    elif sys.platform == "darwin":
        for label in (MACOS_LABEL, LEGACY_MACOS_LABEL):
            plist = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
            if plist.exists():
                subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(plist)],
                               capture_output=True)
                plist.unlink()


def process_command(pid: int) -> str:
    if sys.platform == "win32":
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"],
            capture_output=True, text=True,
        )
    else:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                capture_output=True, text=True)
    return result.stdout.strip()


def stop_pid(pid_path: Path, expected: str) -> None:
    try:
        pid = int(pid_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return
    command = process_command(pid)
    if command and str(Path(expected).resolve()) not in command:
        raise RuntimeError(f"Managed PID {pid} does not match the expected browser command")
    if sys.platform == "win32":
        result = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        if result.returncode not in (0, 128):
            raise RuntimeError(f"Could not stop managed browser PID {pid}")
    else:
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
    try:
        pid_path.unlink()
    except FileNotFoundError:
        pass


def stop(runtime: Path) -> None:
    pid_paths = (runtime / "state" / "node.pid", runtime / "state" / "service.pid")
    had_managed_pid = any(path.exists() for path in pid_paths)
    state = read_state()
    if not had_managed_pid and not state:
        return
    stop_pid(runtime / "state" / "node.pid",
             runtime / "package" / "node_modules" / "@playwright" / "mcp" / "cli.js")
    stop_pid(runtime / "state" / "service.pid", runtime / "bin" / "browser_service.py")
    port = int(state.get("port", DEFAULT_PORT))
    deadline = time.monotonic() + 10
    while port_open(port) and time.monotonic() < deadline:
        time.sleep(0.1)
    if port_open(port):
        raise RuntimeError(f"Managed Playwright port {port} is still listening after stop")


def install(args: argparse.Namespace) -> int:
    runtime = root()
    node = which(("node.exe", "node"))
    npm = which(("npm.cmd", "npm"))
    chrome = chrome_path()
    missing = [name for name, value in (("Node.js", node), ("npm", npm), ("Google Chrome", chrome)) if not value]
    if missing:
        print(json.dumps({"healthy": False, "missing": missing,
                          "next": "Install the missing prerequisites and rerun setup."}, indent=2))
        return 2
    existing = read_state()
    managed_profile = Path(existing["profile"]) if existing.get("profile") else None
    profile = Path(args.profile).expanduser().resolve() if args.profile else runtime / "profiles" / "shared"
    validate_profile(profile, args.adopt_existing_profile, managed_profile)
    for path in (runtime / "bin", runtime / "logs", runtime / "outputs", runtime / "state", profile):
        path.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    for name in ("browser_service.py", "auth_lease.py"):
        shutil.copy2(source / name, runtime / "bin" / name)
    package = runtime / "package"
    subprocess.run([npm, "install", "--prefix", str(package),
                    f"@playwright/mcp@{PACKAGE_VERSION}", "--save-exact"], check=True)
    remove_autostart()
    stop(runtime)
    state = {"schema": 1, "package_version": PACKAGE_VERSION, "port": args.port,
             "profile": str(profile), "node": node, "chrome": chrome,
             "platform_status": "supported" if sys.platform == "win32" else "preview"}
    write_state(state)
    install_autostart(runtime)
    flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS if sys.platform == "win32" else 0
    subprocess.Popen([sys.executable, str(runtime / "bin" / "browser_service.py")],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=sys.platform != "win32", creationflags=flags)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not port_open(args.port):
        time.sleep(0.25)
    return status()


def status() -> int:
    runtime = root()
    state = read_state()
    port = int(state.get("port", DEFAULT_PORT))
    cli = runtime / "package" / "node_modules" / "@playwright" / "mcp" / "cli.js"
    node_pid = runtime / "state" / "node.pid"
    try:
        managed_pid = int(node_pid.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        managed_pid = 0
    managed_listener = bool(managed_pid and str(cli.resolve()) in process_command(managed_pid))
    result = {"healthy": bool(state) and cli.is_file() and port_open(port) and managed_listener,
              "runtime": str(runtime), "profile": state.get("profile"), "port": port,
              "listener": port_open(port), "managed_listener": managed_listener,
              "chrome": chrome_path(),
              "package_version": state.get("package_version"),
              "platform_status": state.get("platform_status",
                  "supported" if sys.platform == "win32" else "preview")}
    print(json.dumps(result, indent=2))
    return 0 if result["healthy"] else 1


def uninstall(args: argparse.Namespace) -> int:
    if not args.confirm:
        print(json.dumps({"removed": False, "needs_confirmation": True,
                          "runtime": str(root()), "profile": read_state().get("profile")}))
        return 2
    runtime = root()
    state = read_state()
    profile = Path(state["profile"]) if state.get("profile") else None
    remove_autostart()
    stop(runtime)
    for name in ("package", "bin", "outputs"):
        target = runtime / name
        if target.exists():
            shutil.rmtree(target)
    if args.delete_profile and profile and profile.exists():
        shutil.rmtree(profile)
    print(json.dumps({"removed": True, "profile_deleted": bool(args.delete_profile),
                      "profile": str(profile) if profile else None}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    install_parser = sub.add_parser("install")
    install_parser.add_argument("--profile")
    install_parser.add_argument("--adopt-existing-profile", action="store_true")
    install_parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    sub.add_parser("status")
    uninstall_parser = sub.add_parser("uninstall")
    uninstall_parser.add_argument("--confirm", action="store_true")
    uninstall_parser.add_argument("--delete-profile", action="store_true")
    args = parser.parse_args()
    if getattr(args, "port", DEFAULT_PORT) < 1024 or getattr(args, "port", DEFAULT_PORT) > 65535:
        raise SystemExit("Port must be between 1024 and 65535")
    return install(args) if args.action == "install" else status() if args.action == "status" else uninstall(args)


if __name__ == "__main__":
    raise SystemExit(main())
