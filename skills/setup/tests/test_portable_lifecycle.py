from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts" / "portable"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class PortableLifecycleTests(unittest.TestCase):
    def test_auth_lease_acquire_and_release(self) -> None:
        script = SCRIPTS / "auth_lease.py"
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT=directory)
            acquire = subprocess.run(
                [sys.executable, str(script), "acquire", "--owner", "unit-test"],
                text=True,
                capture_output=True,
                env=env,
                check=True,
            )
            lease_id = json.loads(acquire.stdout)["lease_id"]
            status = subprocess.run(
                [sys.executable, str(script), "status"],
                text=True,
                capture_output=True,
                env=env,
                check=True,
            )
            self.assertFalse(json.loads(status.stdout)["available"])
            release = subprocess.run(
                [sys.executable, str(script), "release", "--lease-id", lease_id],
                text=True,
                capture_output=True,
                env=env,
                check=True,
            )
            self.assertTrue(json.loads(release.stdout)["success"])

    def test_manager_ignores_an_unmanaged_default_port(self) -> None:
        manager = load_module("portable_browser_manager", SCRIPTS / "manage_browser.py")
        with tempfile.TemporaryDirectory() as directory:
            original_root = manager.root
            original_port_open = manager.port_open
            manager.root = lambda: Path(directory)
            manager.port_open = lambda port: True
            try:
                manager.stop(Path(directory))
            finally:
                manager.root = original_root
                manager.port_open = original_port_open

    def test_canonical_runtime_override_wins(self) -> None:
        lease = load_module("portable_auth_lease", SCRIPTS / "auth_lease.py")
        with tempfile.TemporaryDirectory() as directory:
            previous = os.environ.get("PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT")
            os.environ["PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT"] = directory
            try:
                self.assertEqual(Path(directory).resolve(), lease.runtime_root())
            finally:
                if previous is None:
                    os.environ.pop("PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT", None)
                else:
                    os.environ["PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT"] = previous


if __name__ == "__main__":
    unittest.main()
