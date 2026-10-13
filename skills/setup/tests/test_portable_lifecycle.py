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

    def run_claim(self, env: dict, *args: str) -> tuple[int, dict]:
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "tab_claim.py"), *args],
            text=True,
            capture_output=True,
            env=env,
        )
        return result.returncode, json.loads(result.stdout)

    def test_tab_claim_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT=directory)
            code, claim = self.run_claim(
                env, "claim", "--owner", "unit-test", "--task", "read docs",
                "--url", "https://user:pw@Example.com:443/docs?token=secret#frag",
            )
            self.assertEqual(0, code)
            self.assertTrue(claim["claimed"])
            self.assertEqual("https://example.com/docs", claim["url"])
            registry = Path(directory) / "locks" / "tab-claims.json"
            self.assertNotIn("secret", registry.read_text(encoding="utf-8"))

            code, listed = self.run_claim(env, "list")
            self.assertEqual((0, 1), (code, listed["count"]))
            self.assertNotIn(claim["claim_id"], json.dumps(listed))

            code, renewed = self.run_claim(env, "renew", "--claim-id", claim["claim_id"],
                                           "--url", "https://example.com/next?x=1")
            self.assertEqual(0, code)
            self.assertEqual("https://example.com/next", renewed["url"])

            code, wrong = self.run_claim(env, "release", "--claim-id", "0" * 32)
            self.assertEqual((76, "claim-not-found-or-expired"), (code, wrong["reason"]))
            code, released = self.run_claim(env, "release", "--claim-id", claim["claim_id"])
            self.assertEqual(0, code)
            self.assertTrue(released["success"])

    def test_tab_claim_expiry_and_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT=directory)
            _, claim = self.run_claim(env, "claim", "--owner", "unit-test", "--url", "https://example.com/")
            self.run_claim(env, "claim", "--owner", "other", "--url", "https://example.com/b")
            registry = Path(directory) / "locks" / "tab-claims.json"
            state = json.loads(registry.read_text(encoding="utf-8"))
            for entry in state["claims"]:
                if entry["claim_id"] == claim["claim_id"]:
                    # The PowerShell helper writes seven-digit fractions and Z.
                    entry["expires_utc"] = "2000-01-01T00:00:00.0000000Z"
            registry.write_text(json.dumps(state), encoding="utf-8")
            code, listed = self.run_claim(env, "status")
            self.assertEqual((0, 1), (code, listed["count"]))
            code, _ = self.run_claim(env, "renew", "--claim-id", claim["claim_id"])
            self.assertEqual(76, code)
            self.assertNotIn(claim["claim_id"], registry.read_text(encoding="utf-8"))
            for args in (("claim", "--owner", "bad owner", "--url", "https://example.com/"),
                         ("claim", "--owner", "ok", "--url", "not a url"),
                         ("claim", "--owner", "ok"),
                         ("renew", "--claim-id", "nope")):
                code, result = self.run_claim(env, *args)
                self.assertEqual((70, "error"), (code, result["reason"]), args)

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
