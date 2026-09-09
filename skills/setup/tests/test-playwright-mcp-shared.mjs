import { execFileSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: shared Playwright MCP smoke test requires Windows.");
  process.exit(0);
}

const runtimeRoot = path.join(process.env.LOCALAPPDATA, "playwright-mcp-shared");
const mcpCli =
  process.env.PLAYWRIGHT_MCP_SHARED_CLI ||
  path.join(runtimeRoot, "package", "node_modules", "@playwright", "mcp", "cli.js");
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testsDir, "..", "scripts", "playwright-mcp-shared.ps1");
const leaseScript = path.resolve(testsDir, "..", "scripts", "playwright-auth-lease.ps1");
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-mcp-shared-smoke-"));
const profileRoot = path.join(tempRoot, "profile");
const endpointArgument = process.argv.find((value) => value.startsWith("--endpoint="));
const externalEndpoint = endpointArgument?.slice("--endpoint=".length) || null;
const timeoutMs = 120_000;
let mcpProcess;
let testServer;
let stderr = "";

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

class HttpMcpClient {
  constructor(endpoint, name) {
    this.endpoint = endpoint;
    this.name = name;
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(message, attempts = 1) {
    let response;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const headers = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        };
        if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
        response = await fetch(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
        });
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    const assignedSession = response.headers.get("mcp-session-id");
    if (assignedSession) this.sessionId = assignedSession;
    if (!response.ok)
      throw new Error(`${this.name}: HTTP ${response.status} ${await response.text()}`);
    if (response.status === 202) return null;

    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let payload;
    if (contentType.includes("text/event-stream")) {
      const dataLines = body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) throw new Error(`${this.name}: empty SSE response`);
      payload = JSON.parse(dataLines.join(""));
    } else {
      payload = JSON.parse(body);
    }
    if (payload.error) throw new Error(`${this.name}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  async initialize() {
    const id = this.nextId++;
    await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: this.name, version: "1.0.0" },
        },
      },
      400,
    );
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  }

  async callTool(name, args = {}) {
    return await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  async close() {
    if (!this.sessionId) return;
    await fetch(this.endpoint, {
      method: "DELETE",
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-session-id": this.sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
    }).catch(() => {});
    this.sessionId = null;
  }
}

function resultText(result) {
  return (result?.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function runLease(args) {
  const result = spawnSync(
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
    { encoding: "utf8", windowsHide: true },
  );
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  return { code: result.status, payload };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    const nodePid = Number(
      (await readFile(path.join(tempRoot, "state", "shared-node.pid"), "utf8")).trim(),
    );
    if (Number.isInteger(nodePid) && nodePid > 0) process.kill(nodePid);
  } catch {
    // The wrapper may already have stopped and removed the managed PID.
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  if (child.exitCode === null) child.kill();
}

async function removeTempRoot() {
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.warn(`WARN: could not remove test runtime: ${lastError.message}`);
}

function stopTestProcesses() {
  const command =
    "$root=$env:PLAYWRIGHT_SHARED_TEST_ROOT; " +
    "Get-CimInstance Win32_Process | Where-Object { " +
    "($_.Name -eq 'chrome.exe' -or $_.Name -eq 'node.exe') -and " +
    "$_.CommandLine -and $_.CommandLine.Contains($root) " +
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: { ...process.env, PLAYWRIGHT_SHARED_TEST_ROOT: tempRoot },
        timeout: 30_000,
      },
    );
  } catch {
    // The exact test-only profile path is retried by removeTempRoot below.
  }
}

try {
  await mkdir(profileRoot, { recursive: true });

  const appPort = await freePort();
  testServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${appPort}`);
    if (requestUrl.pathname === "/idp/select") {
      const account = requestUrl.searchParams.get("account");
      if (!/^(production|nonproduction)$/.test(account || "")) {
        response.statusCode = 400;
        response.end("INVALID_ACCOUNT_CLASS");
        return;
      }
      response.setHeader(
        "Set-Cookie",
        `shared_idp_account=${account}; Path=/; SameSite=Lax`,
      );
      response.end(`<html><title>IDP_SELECTED</title><h1>IDP_SELECTED</h1></html>`);
      return;
    }
    if (requestUrl.pathname === "/idp/clear") {
      response.setHeader(
        "Set-Cookie",
        "shared_idp_account=; Path=/; Max-Age=0; SameSite=Lax",
      );
      response.end("<html><title>IDP_CLEARED</title><h1>IDP_CLEARED</h1></html>");
      return;
    }
    if (requestUrl.pathname === "/rp/check") {
      const expected = requestUrl.searchParams.get("expected");
      const actual = request.headers.cookie?.match(/shared_idp_account=([^;]+)/)?.[1];
      const value = actual === expected ? "FEDERATION_OK" : "IDENTITY_MISMATCH";
      response.end(`<html><title>${value}</title><h1>${value}</h1></html>`);
      return;
    }
    if (request.url === "/set") {
      response.setHeader("Set-Cookie", "shared_browser_auth=present; Path=/; SameSite=Lax");
      response.end("<html><title>COOKIE_SET</title><h1>COOKIE_SET</h1></html>");
      return;
    }
    if (request.url === "/read") {
      const value = request.headers.cookie?.includes("shared_browser_auth=present")
        ? "COOKIE_SHARED"
        : "COOKIE_MISSING";
      response.end(`<html><title>${value}</title><h1>${value}</h1></html>`);
      return;
    }
    if (request.url === "/clear") {
      response.setHeader(
        "Set-Cookie",
        "shared_browser_auth=; Path=/; Max-Age=0; SameSite=Lax",
      );
      response.end("<html><title>COOKIE_CLEARED</title><h1>COOKIE_CLEARED</h1></html>");
      return;
    }
    if (request.url === "/a") {
      response.end("<html><title>CLIENT_A</title><h1>CLIENT_A</h1></html>");
      return;
    }
    if (request.url === "/b") {
      response.end("<html><title>CLIENT_B</title><h1>CLIENT_B</h1></html>");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    testServer.once("error", reject);
    testServer.listen(appPort, "127.0.0.1", resolve);
  });

  const mcpPort = externalEndpoint ? null : await freePort();
  const endpoint = externalEndpoint || `http://localhost:${mcpPort}/mcp`;
  if (!externalEndpoint)
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
      profileRoot,
      "-Port",
      String(mcpPort),
      "-Headless",
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (mcpProcess) {
    mcpProcess.stderr.setEncoding("utf8");
    mcpProcess.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
  }

  const clientA = new HttpMcpClient(endpoint, "shared-browser-a");
  const clientB = new HttpMcpClient(endpoint, "shared-browser-b");
  try {
    await Promise.all([clientA.initialize(), clientB.initialize()]);

    // A shared BrowserContext exposes the same first page to every new client.
    // Each client must claim a new tab before its first navigation.
    await clientA.callTool("browser_tabs", { action: "new" });
    await clientA.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/a`,
    });
    await clientB.callTool("browser_tabs", { action: "new" });
    await clientB.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/b`,
    });

    await clientA.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/set`,
    });
    await clientB.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/read`,
    });
    const cookieSnapshot = resultText(await clientB.callTool("browser_snapshot"));
    if (!cookieSnapshot.includes("COOKIE_SHARED"))
      throw new Error("Client B did not receive Client A's shared cookie.");

    // Generic federation regression: a relying party sees the upstream IdP
    // account stored globally in the shared BrowserContext. A second client
    // with a different account intent receives a mismatch until the auth flow
    // is serialized and the intended account is explicitly selected.
    await clientA.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/idp/select?account=production`,
    });
    await clientB.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/rp/check?expected=nonproduction`,
    });
    const mismatch = resultText(await clientB.callTool("browser_snapshot"));
    if (!mismatch.includes("IDENTITY_MISMATCH"))
      throw new Error("Shared upstream identity did not reproduce the federation mismatch.");

    const leaseA = runLease([
      "-Action",
      "Acquire",
      "-Owner",
      "federation-client-a",
      "-TtlSeconds",
      "60",
    ]);
    if (leaseA.code !== 0 || leaseA.payload.acquired !== true)
      throw new Error(`Client A did not acquire the auth lease: ${JSON.stringify(leaseA)}`);
    const leaseBBlocked = runLease([
      "-Action",
      "Acquire",
      "-Owner",
      "federation-client-b",
      "-TtlSeconds",
      "60",
    ]);
    if (leaseBBlocked.code !== 75 || leaseBBlocked.payload.reason !== "busy")
      throw new Error(`Client B was not blocked by the auth lease: ${JSON.stringify(leaseBBlocked)}`);

    await clientA.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/idp/select?account=nonproduction`,
    });
    await clientA.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/rp/check?expected=nonproduction`,
    });
    const aligned = resultText(await clientA.callTool("browser_snapshot"));
    if (!aligned.includes("FEDERATION_OK"))
      throw new Error("Explicit identity selection did not align the relying party and IdP.");
    const released = runLease([
      "-Action",
      "Release",
      "-LeaseId",
      leaseA.payload.lease_id,
    ]);
    if (released.code !== 0 || released.payload.success !== true)
      throw new Error(`Client A did not release the auth lease: ${JSON.stringify(released)}`);
    const leaseB = runLease([
      "-Action",
      "Acquire",
      "-Owner",
      "federation-client-b",
      "-TtlSeconds",
      "60",
    ]);
    if (leaseB.code !== 0 || leaseB.payload.acquired !== true)
      throw new Error(`Client B did not acquire the released auth lease: ${JSON.stringify(leaseB)}`);
    runLease(["-Action", "Release", "-LeaseId", leaseB.payload.lease_id]);

    await Promise.all([
      clientA.callTool("browser_navigate", { url: `http://127.0.0.1:${appPort}/a` }),
      clientB.callTool("browser_navigate", { url: `http://127.0.0.1:${appPort}/b` }),
    ]);
    const [snapshotA, snapshotB] = await Promise.all([
      clientA.callTool("browser_snapshot"),
      clientB.callTool("browser_snapshot"),
    ]);
    const textA = resultText(snapshotA);
    const textB = resultText(snapshotB);
    if (
      !textA.includes("Page Title: CLIENT_A") ||
      !textA.includes("Page URL: " + `http://127.0.0.1:${appPort}/a`)
    )
      throw new Error(`Client A tab ownership failed. A=${textA} B=${textB}`);
    if (
      !textB.includes("Page Title: CLIENT_B") ||
      !textB.includes("Page URL: " + `http://127.0.0.1:${appPort}/b`)
    )
      throw new Error(`Client B tab ownership failed. A=${textA} B=${textB}`);

    await clientA.close();
    const survivor = resultText(await clientB.callTool("browser_snapshot"));
    if (!survivor.includes("CLIENT_B"))
      throw new Error("Disconnecting Client A disrupted Client B.");

    await clientB.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/clear`,
    });
    await clientB.callTool("browser_navigate", {
      url: `http://127.0.0.1:${appPort}/idp/clear`,
    });
    console.log(
      "PASS: Two HTTP MCP clients shared state, retained distinct tabs, reproduced a generic federated-identity mismatch, serialized account selection, and survived disconnect.",
    );
  } finally {
    await Promise.all([clientA.close(), clientB.close()]);
  }

  if (mcpProcess && mcpProcess.exitCode !== null && mcpProcess.exitCode !== 0)
    throw new Error(`Shared MCP server exited ${mcpProcess.exitCode}: ${stderr}`);
} finally {
  await stopServer(mcpProcess);
  stopTestProcesses();
  if (testServer)
    await new Promise((resolve) => testServer.close(() => resolve()));
  await removeTempRoot();
}
