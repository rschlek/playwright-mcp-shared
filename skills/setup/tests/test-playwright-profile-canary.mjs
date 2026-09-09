import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: Playwright profile canary test requires Windows.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const canaryScript = path.resolve(
  testsDir,
  "..",
  "scripts",
  "playwright-profile-canary.mjs",
);
const timeoutMs = 120_000;
let server;

try {
  server = http.createServer((_request, response) => {
    response.end("<html><title>CANARY_TEST</title><h1>CANARY_TEST</h1></html>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const secretQuery = "must-not-appear";
  const target = `http://127.0.0.1:${port}/canary?probe=${secretQuery}#fragment`;
  const mcpCliArgument = process.env.PLAYWRIGHT_MCP_SHARED_CLI
    ? [`--mcp-cli=${process.env.PLAYWRIGHT_MCP_SHARED_CLI}`]
    : [];
  const child = spawn(
    process.execPath,
    [
      canaryScript,
      `--url=${target}`,
      "--headless",
      "--non-interactive",
      "--discard",
      ...mcpCliArgument,
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
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Canary test timed out.")), timeoutMs),
    ),
  ]);
  child.stdout.destroy();
  child.stderr.destroy();
  if (exitCode !== 0) throw new Error(`Canary exited ${exitCode}: ${stderr}`);
  if (!stdout.includes("CANARY_READY")) throw new Error(`Missing READY: ${stdout}`);
  if (!stdout.includes('"targetHost":true'))
    throw new Error(`Canary did not reach the target host: ${stdout}`);
  if (!stdout.includes("CANARY_DISCARDED"))
    throw new Error(`Canary did not discard its temporary profile: ${stdout}`);
  if (stdout.includes(secretQuery))
    throw new Error("Canary output exposed the target query string.");

  const root = stdout.match(/CANARY_READY root=([^\s]+)/)?.[1];
  if (!root) throw new Error(`Canary did not report its isolated root: ${stdout}`);
  try {
    await access(root);
    throw new Error(`Canary temporary root still exists: ${root}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(
    "PASS: Fresh-profile canary used an isolated MCP runtime, redacted URL state, and discarded only its temporary profile.",
  );
} finally {
  if (server) {
    server.close();
    server.closeAllConnections();
    server.unref();
  }
}

process.exit(0);
