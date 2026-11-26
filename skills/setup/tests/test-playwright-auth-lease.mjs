import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
if (!isWindows && process.platform !== "linux") {
  console.log("SKIP: Playwright authentication lease test requires Windows or Linux.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const leaseScript = path.resolve(
  testsDir,
  "..",
  "scripts",
  isWindows ? "playwright-auth-lease.ps1" : "playwright-auth-lease.sh",
);
const launcherProgram = isWindows ? "powershell.exe" : "bash";
const launcherPrefix = isWindows
  ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
  : [];
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-auth-lease-"));

function runLease(args, { script = leaseScript, runtimeRoot = tempRoot, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      launcherProgram,
      [...launcherPrefix, script, ...(runtimeRoot ? ["-RuntimeRoot", runtimeRoot] : []), ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      let payload;
      try {
        payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      } catch {
        return reject(new Error(`Invalid lease output (${code}): ${stdout} ${stderr}`));
      }
      resolve({ code, payload, stderr });
    });
  });
}

try {
  const contenders = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      runLease([
        "-Action",
        "Acquire",
        "-Owner",
        `test-client-${index}`,
        "-TtlSeconds",
        "60",
      ]),
    ),
  );
  const winners = contenders.filter(
    ({ code, payload }) => code === 0 && payload.acquired === true,
  );
  const busy = contenders.filter(
    ({ code, payload }) => code === 75 && payload.reason === "busy",
  );
  if (winners.length !== 1 || busy.length !== 7)
    throw new Error(
      `Expected one winner and seven busy contenders: ${JSON.stringify(contenders)}`,
    );

  const winner = winners[0].payload;
  const status = await runLease(["-Action", "Status"]);
  if (status.code !== 0 || status.payload.available !== false)
    throw new Error(`Held lease was not visible: ${JSON.stringify(status)}`);

  const wrongRelease = await runLease([
    "-Action",
    "Release",
    "-LeaseId",
    "00000000000000000000000000000000",
  ]);
  if (wrongRelease.code !== 76)
    throw new Error(`Wrong lease ID released the lease: ${JSON.stringify(wrongRelease)}`);

  const renew = await runLease([
    "-Action",
    "Renew",
    "-LeaseId",
    winner.lease_id,
    "-TtlSeconds",
    "60",
  ]);
  if (renew.code !== 0 || renew.payload.success !== true)
    throw new Error(`Lease renewal failed: ${JSON.stringify(renew)}`);

  const release = await runLease([
    "-Action",
    "Release",
    "-LeaseId",
    winner.lease_id,
  ]);
  if (release.code !== 0 || release.payload.success !== true)
    throw new Error(`Lease release failed: ${JSON.stringify(release)}`);

  const successor = await runLease([
    "-Action",
    "Acquire",
    "-Owner",
    "test-successor",
    "-TtlSeconds",
    "60",
  ]);
  if (successor.code !== 0 || successor.payload.acquired !== true)
    throw new Error(`Successor did not acquire the released lease: ${JSON.stringify(successor)}`);
  await runLease([
    "-Action",
    "Release",
    "-LeaseId",
    successor.payload.lease_id,
  ]);

  // An installed copy run without -RuntimeRoot uses the lease of the runtime it
  // lives in, whatever that runtime is named; the environment override wins.
  // The default root is pointed into the temporary directory, so a fallback
  // would never touch a real installation.
  const installedRoot = path.join(tempRoot, "installed-under-another-name");
  const installedScript = path.join(installedRoot, "bin", path.basename(leaseScript));
  await mkdir(path.join(installedRoot, "bin"), { recursive: true });
  await mkdir(path.join(installedRoot, "state"), { recursive: true });
  await copyFile(leaseScript, installedScript);
  await writeFile(
    path.join(installedRoot, "state", isWindows ? "windows-service-config.json" : "linux-service-config.json"),
    "{}",
  );
  const fallbackHome = path.join(tempRoot, "default-home");
  const isolatedEnv = { ...process.env, LOCALAPPDATA: fallbackHome, XDG_DATA_HOME: fallbackHome };
  delete isolatedEnv.PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT;
  const installed = await runLease(["-Action", "Acquire", "-Owner", "test-installed", "-TtlSeconds", "60"], {
    script: installedScript,
    runtimeRoot: null,
    env: isolatedEnv,
  });
  if (installed.code !== 0 || installed.payload.acquired !== true)
    throw new Error(`Installed copy did not acquire its own lease: ${JSON.stringify(installed)}`);
  if (!(await stat(path.join(installedRoot, "locks", "auth-flow.json")).catch(() => null)))
    throw new Error("Installed copy did not use the lease of the runtime it lives in.");
  if (await stat(path.join(fallbackHome, "playwright-mcp-shared")).catch(() => null))
    throw new Error("Installed copy fell back to the default runtime root.");
  await runLease(["-Action", "Release", "-LeaseId", installed.payload.lease_id], {
    script: installedScript,
    runtimeRoot: null,
    env: isolatedEnv,
  });

  const overrideRoot = path.join(tempRoot, "override-root");
  const overridden = await runLease(["-Action", "Status"], {
    script: installedScript,
    runtimeRoot: null,
    env: { ...isolatedEnv, PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT: overrideRoot },
  });
  if (overridden.code !== 0 || !(await stat(path.join(overrideRoot, "locks")).catch(() => null)))
    throw new Error(`PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT was not honoured: ${JSON.stringify(overridden)}`);

  console.log(
    "PASS: Eight concurrent authentication contenders produced one lease holder, protected release, renewal, and clean handoff; an installed copy finds its own runtime.",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
