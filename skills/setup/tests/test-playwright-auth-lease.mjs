import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: Playwright authentication lease test requires Windows.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const leaseScript = path.resolve(
  testsDir,
  "..",
  "scripts",
  "playwright-auth-lease.ps1",
);
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-auth-lease-"));

function runLease(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        leaseScript,
        "-RuntimeRoot",
        tempRoot,
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
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

  console.log(
    "PASS: Eight concurrent authentication contenders produced one lease holder, protected release, renewal, and clean handoff.",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
