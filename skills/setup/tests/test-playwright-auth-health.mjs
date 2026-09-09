import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: Playwright authentication health test requires Windows.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(testsDir, "..");
const healthScript = path.join(skillDir, "scripts", "playwright-auth-health.mjs");
const serverScript = path.join(skillDir, "scripts", "playwright-mcp-shared.ps1");
const managedRuntime = path.join(process.env.LOCALAPPDATA, "playwright-mcp-shared");
const mcpCli =
  process.env.PLAYWRIGHT_MCP_SHARED_CLI ||
  path.join(
    managedRuntime,
    "package",
    "node_modules",
    "@playwright",
    "mcp",
    "cli.js",
  );
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-auth-health-"));
let appServer;
let mcpProcess;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function runHealth(endpoint, specPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        healthScript,
        `--endpoint=${endpoint}`,
        `--runtime-root=${tempRoot}`,
        `--spec=${specPath}`,
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
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseReport(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .find((value) => value.startsWith("AUTH_HEALTH "));
  if (!line) throw new Error(`Missing health report: ${stdout}`);
  return JSON.parse(line.slice("AUTH_HEALTH ".length));
}

function stopTempProcesses() {
  const command =
    "$root=$env:PLAYWRIGHT_HEALTH_TEST_ROOT; " +
    "Get-CimInstance Win32_Process | Where-Object { " +
    "($_.Name -eq 'chrome.exe' -or $_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe') -and " +
    "$_.CommandLine -and $_.CommandLine.Contains($root) " +
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: { ...process.env, PLAYWRIGHT_HEALTH_TEST_ROOT: tempRoot },
        timeout: 30_000,
      },
    );
  } catch {}
}

try {
  const appPort = await freePort();
  appServer = http.createServer((request, response) => {
    if (request.url === "/developer-ok") {
      response.end("<html><title>Developer</title><h1>Developer portal</h1></html>");
      return;
    }
    if (request.url === "/performance-ok") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ principal: "must-not-appear" }));
      return;
    }
    if (request.url === "/developer-bad") {
      response.end("<html><h1>Email does not match the remembered identity</h1></html>");
      return;
    }
    if (request.url === "/performance-bad") {
      response.statusCode = 401;
      response.end("authentication required");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    appServer.once("error", reject);
    appServer.listen(appPort, "127.0.0.1", resolve);
  });

  const mcpPort = await freePort();
  const endpoint = `http://localhost:${mcpPort}/mcp`;
  mcpProcess = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      serverScript,
      "-RuntimeRoot",
      tempRoot,
      "-McpCli",
      mcpCli,
      "-ProfilePath",
      path.join(tempRoot, "profile"),
      "-Port",
      String(mcpPort),
      "-Headless",
    ],
    { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
  );

  const healthySpec = path.join(tempRoot, "healthy-probes.json");
  const unhealthySpec = path.join(tempRoot, "unhealthy-probes.json");
  await writeFile(
    healthySpec,
    JSON.stringify({
      probes: [
        {
          name: "portal-session",
          url: `http://127.0.0.1:${appPort}/developer-ok`,
          forbidSignals: ["accessDenied", "identityMismatch", "authenticationPrompt"],
        },
        {
          name: "application-principal",
          url: `http://127.0.0.1:${appPort}/performance-ok`,
          forbidSignals: ["accessDenied", "authenticationRequired"],
          requireNonEmptyJsonObject: true,
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    unhealthySpec,
    JSON.stringify({
      probes: [
        {
          name: "portal-session",
          url: `http://127.0.0.1:${appPort}/developer-bad`,
          forbidSignals: ["accessDenied", "identityMismatch"],
        },
        {
          name: "application-principal",
          url: `http://127.0.0.1:${appPort}/performance-bad`,
          forbidSignals: ["accessDenied", "authenticationRequired"],
          requireNonEmptyJsonObject: true,
        },
      ],
    }),
    "utf8",
  );

  const healthy = await runHealth(endpoint, healthySpec);
  const healthyReport = parseReport(healthy.stdout);
  if (healthy.code !== 0 || healthyReport.healthy !== true)
    throw new Error(`Healthy fixture failed: ${JSON.stringify(healthy)}`);
  if (healthy.stdout.includes("must-not-appear"))
    throw new Error("Health output exposed the synthetic principal.");

  const unhealthy = await runHealth(endpoint, unhealthySpec);
  const unhealthyReport = parseReport(unhealthy.stdout);
  if (unhealthy.code !== 3 || unhealthyReport.healthy !== false)
    throw new Error(`Unhealthy fixture was not rejected: ${JSON.stringify(unhealthy)}`);
  if (
    unhealthyReport.probes[0].forbiddenSignals.includes("identityMismatch") !== true ||
    unhealthyReport.probes[1].forbiddenSignals.includes("authenticationRequired") !== true
  )
    throw new Error(`Unhealthy signals were incomplete: ${JSON.stringify(unhealthyReport)}`);

  console.log(
    "PASS: Authentication health check accepted healthy state, rejected mismatch/401 state, and redacted principal content.",
  );
} finally {
  try {
    const nodePid = Number(
      (await readFile(path.join(tempRoot, "state", "shared-node.pid"), "utf8")).trim(),
    );
    if (Number.isInteger(nodePid) && nodePid > 0) process.kill(nodePid);
  } catch {}
  if (mcpProcess && mcpProcess.exitCode === null) mcpProcess.kill();
  stopTempProcesses();
  if (appServer) {
    appServer.close();
    appServer.closeAllConnections();
    appServer.unref();
  }
  await rm(tempRoot, { recursive: true, force: true });
}

process.exit(0);
