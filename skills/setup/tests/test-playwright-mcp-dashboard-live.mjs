// Live check of the launch-tab dashboard against the pinned Playwright MCP
// CLI, run headless by the Windows supervisor in a disposable runtime on free
// ports. Never touches the canonical runtime or its service.
//
//   node tests/test-playwright-mcp-dashboard-live.mjs [--evidence=<dir>]
//
// --evidence writes the dashboard's JSON at each stage and a screenshot of the
// launch tab into <dir>.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: live dashboard test requires Windows.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testsDir, "..", "scripts", "playwright-mcp-shared.ps1");
const claimScript = path.resolve(testsDir, "..", "scripts", "playwright-tab-claim.ps1");
const mcpCli =
  process.env.PLAYWRIGHT_MCP_SHARED_CLI ||
  path.join(process.env.LOCALAPPDATA || "", "playwright-mcp-shared", "package", "node_modules", "@playwright", "mcp", "cli.js");
if (!fs.existsSync(mcpCli)) {
  console.log("SKIP: live dashboard test needs the pinned Playwright MCP CLI. Set PLAYWRIGHT_MCP_SHARED_CLI.");
  process.exit(0);
}
const evidenceArg = process.argv.find((value) => value.startsWith("--evidence="));
const evidenceDir = evidenceArg ? path.resolve(evidenceArg.slice("--evidence=".length)) : null;
if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });

const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-mcp-dashboard-live-"));
const profileRoot = path.join(tempRoot, "profile");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clients = [];
let launcher;
let appServer;

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
    clients.push(this);
  }
  async post(message) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(message) });
    const assigned = response.headers.get("mcp-session-id");
    if (assigned) this.sessionId = assigned;
    if (!response.ok) {
      const error = new Error(`${this.name}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 202) return null;
    const body = await response.text();
    const payload = (response.headers.get("content-type") || "").includes("text/event-stream")
      ? JSON.parse(body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join(""))
      : JSON.parse(body);
    if (payload.error) throw new Error(`${this.name}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }
  async initialize() {
    this.sessionId = null;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: this.name, version: "1.0.0" } } });
        break;
      } catch (error) {
        if (attempt >= 240) throw error;
        await sleep(250);
      }
    }
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }
  async tool(name, args = {}) {
    const result = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
    const text = (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (result?.isError) throw new Error(`${this.name} ${name}: ${text}`);
    return text;
  }
  async tabs() {
    return (await this.tool("browser_tabs", { action: "list" })).split(/\r?\n/).filter((line) => /^- \d+:/.test(line));
  }
  async close() {
    if (!this.sessionId) return;
    await fetch(this.endpoint, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, "mcp-protocol-version": "2025-03-26" } }).catch(() => {});
    this.sessionId = null;
  }
}

function claimHelper(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", claimScript, "-RuntimeRoot", tempRoot, ...args],
    { encoding: "utf8", windowsHide: true },
  );
  return { code: result.status, payload: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) };
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(port, predicate, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await getJson(port, "/api/state");
      if (predicate(last)) return last;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}. Last state: ${JSON.stringify(last)}`);
}

function evidence(name, value) {
  if (!evidenceDir) return;
  fs.writeFileSync(path.join(evidenceDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function readPid(name) {
  try {
    return Number(fs.readFileSync(path.join(tempRoot, "state", name), "utf8").trim());
  } catch {
    return 0;
  }
}

function stopTestProcesses() {
  const command =
    "$root=$env:PLAYWRIGHT_SHARED_TEST_ROOT; $slashRoot=$root.Replace('\\','/'); " +
    "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe') -and $_.ProcessId -ne $PID -and " +
    "$_.CommandLine -and ($_.CommandLine.Contains($root) -or $_.CommandLine.Contains($slashRoot)) } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, PLAYWRIGHT_SHARED_TEST_ROOT: tempRoot },
      timeout: 30_000,
    });
  } catch {
    // Retried by the temp-root removal below.
  }
}

const tabsOf = (state) => state.tabs.map((tab) => `${tab.index}:${tab.url}:${tab.is_dashboard ? "dashboard" : tab.claim?.owner || "unclaimed"}`);

try {
  const appPort = await freePort();
  appServer = http.createServer((request, response) => {
    const name = request.url.split("?")[0].slice(1) || "root";
    response.setHeader("content-type", "text/html");
    response.end(`<html><title>APP_${name}</title><h1>${name}</h1></html>`);
  });
  await new Promise((resolve) => appServer.listen(appPort, "127.0.0.1", resolve));
  const app = (name) => `http://127.0.0.1:${appPort}/${name}`;

  const mcpPort = await freePort();
  const dashPort = await freePort();
  const endpoint = `http://localhost:${mcpPort}/mcp`;
  launcher = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", serverScript,
      "-RuntimeRoot", tempRoot, "-McpCli", mcpCli, "-ProfilePath", profileRoot, "-Port", String(mcpPort),
      "-Headless", "-RestartDelaySeconds", "0", "-MaxRestarts", "1", "-DashboardPort", String(dashPort)],
    {
      // The service writes relative output files under its working directory.
      cwd: tempRoot,
      env: { ...process.env, PLAYWRIGHT_MCP_SHARED_DASHBOARD_POLL_MS: "500", PLAYWRIGHT_MCP_SHARED_DASHBOARD_RESTORE_GRACE_MS: "3000" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let launcherStderr = "";
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk) => (launcherStderr += chunk));

  // The dashboard comes up with the service and waits for a browser.
  let state = await waitFor(dashPort, (s) => s.service.mcp_reachable && s.launch_tab.status === "detached", "dashboard detached before any agent");
  const dashboardPid = readPid("dashboard.pid");
  if (!dashboardPid) throw new Error("The supervisor did not record a dashboard PID.");
  const pinned = JSON.parse(fs.readFileSync(path.join(path.dirname(mcpCli), "package.json"), "utf8")).version;
  if (state.service.mcp_package_version !== pinned)
    throw new Error(`The dashboard reports @playwright/mcp ${state.service.mcp_package_version}, expected ${pinned}.`);
  evidence("01-before-any-agent.json", state);

  // Agent A starts the browser by claiming a tab in one call, then
  // registers the claim.
  const agentA = new HttpMcpClient(endpoint, "agent-a");
  await agentA.initialize();
  await agentA.tool("browser_tabs", { action: "new", url: app("a") });
  const claimA = claimHelper(["-Action", "Claim", "-Owner", "claude:agent-a", "-Task", "Reading page A", "-Url", `${app("a")}?session=hidden`]);
  if (claimA.code !== 0) throw new Error(`Claim A failed: ${JSON.stringify(claimA)}`);

  state = await waitFor(dashPort, (s) => s.launch_tab.status === "dashboard" && s.tabs[0]?.is_dashboard, "dashboard in the launch tab");
  let tabs = await agentA.tabs();
  if (tabs.some((line) => line.includes("(about:blank)")))
    throw new Error(`A blank tab remained after the dashboard took the launch tab: ${tabs}`);
  if (tabs.length !== 2 || !tabs[0].includes(`http://127.0.0.1:${dashPort}/`) || !tabs[1].includes("(current)"))
    throw new Error(`Unexpected tabs after the dashboard attached: ${tabs}`);
  console.log("PASS: The dashboard replaced the blank launch tab without opening another tab, and the agent kept its own current tab.");

  // Agents B and C claim tabs; C uses the shortest TTL.
  const agentB = new HttpMcpClient(endpoint, "agent-b");
  await agentB.initialize();
  await agentB.tool("browser_tabs", { action: "new", url: app("b") });
  const claimB = claimHelper(["-Action", "Claim", "-Owner", "codex:agent-b", "-Task", "Reading page B", "-Url", app("b")]);
  const agentC = new HttpMcpClient(endpoint, "agent-c");
  await agentC.initialize();
  await agentC.tool("browser_tabs", { action: "new", url: app("c") });
  const claimC = claimHelper(["-Action", "Claim", "-Owner", "claude:agent-c", "-Task", "Short-lived claim", "-Url", app("c"), "-TtlSeconds", "60"]);
  const claimedAt = Date.now();
  if (claimB.code !== 0 || claimC.code !== 0) throw new Error("Claims B or C failed.");

  state = await waitFor(dashPort, (s) => s.tabs.filter((tab) => tab.claim).length === 3, "three claims shown");
  const owners = Object.fromEntries(state.tabs.map((tab) => [tab.url, tab.claim?.owner]));
  if (owners[app("a")] !== "claude:agent-a" || owners[app("b")] !== "codex:agent-b" || owners[app("c")] !== "claude:agent-c")
    throw new Error(`Claims are shown against the wrong tabs: ${tabsOf(state)}`);
  if (JSON.stringify(state).includes("hidden")) throw new Error("The dashboard exposed a URL query.");
  evidence("02-three-claims.json", state);
  console.log(`PASS: Claims are shown against the right tabs: ${tabsOf(state).join(", ")}.`);

  // Agent A navigates; its claim follows the tab.
  await agentA.tool("browser_navigate", { url: app("a-next") });
  state = await waitFor(dashPort, (s) => s.tabs.some((tab) => tab.url === app("a-next") && tab.claim?.owner === "claude:agent-a"), "claim follows navigation");
  console.log("PASS: A claim follows its tab when the agent navigates.");

  // Release B.
  const releaseB = claimHelper(["-Action", "Release", "-ClaimId", claimB.payload.claim_id]);
  if (releaseB.code !== 0) throw new Error("Release B failed.");
  state = await waitFor(dashPort, (s) => s.tabs.some((tab) => tab.url === app("b") && !tab.claim), "released claim shows unclaimed");
  evidence("03-released.json", state);
  console.log("PASS: A released claim shows its tab as unclaimed.");

  // A reconnected session's current tab falls back to the first tab, the
  // dashboard. Its stray navigate is flagged, then undone.
  const stray = new HttpMcpClient(endpoint, "reconnected-agent");
  await stray.initialize();
  const strayTabs = await stray.tabs();
  if (!strayTabs[0].includes("(current)")) throw new Error(`A new session did not start on the first tab: ${strayTabs}`);
  await stray.tool("browser_navigate", { url: app("stray") });
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "drifted", "drift flagged", 15_000);
  evidence("04-drifted.json", state);
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "dashboard" && s.launch_tab.last_event?.kind === "restored", "drift restored", 30_000);
  tabs = await agentA.tabs();
  if (!tabs[0].includes(`http://127.0.0.1:${dashPort}/`) || !tabs.some((line) => line.includes(app("a-next")) && line.includes("(current)")))
    throw new Error(`Restore disturbed another tab: ${tabs}`);
  await stray.close();
  evidence("05-restored.json", state);
  console.log("PASS: A stray navigate into the unclaimed launch tab is flagged and then restored; agent tabs are untouched.");

  // C's claim expires.
  state = await waitFor(dashPort, (s) => s.tabs.some((tab) => tab.url === app("c") && !tab.claim), "expired claim drops", 90_000);
  const waited = Math.round((Date.now() - claimedAt) / 1000);
  if (waited < 55) throw new Error(`Claim C dropped after ${waited}s, before its 60s TTL.`);
  evidence("06-expired.json", state);
  console.log(`PASS: An expired claim drops off after its TTL (${waited}s).`);

  if (evidenceDir) {
    const observer = new HttpMcpClient(endpoint, "evidence-observer");
    await observer.initialize();
    // A new session's current tab is the first tab: the dashboard.
    const reply = await observer.tool("browser_take_screenshot", { filename: "launch-tab.png" });
    const saved = [...reply.matchAll(/\(([^()]*launch-tab\.png)\)/g)].map((match) => match[1]).at(-1);
    const candidates = [saved, "launch-tab.png"].filter(Boolean);
    const shot = candidates
      .flatMap((file) => (path.isAbsolute(file) ? [file] : [path.join(tempRoot, file), path.join(tempRoot, "outputs", "shared", file)]))
      .find((file) => fs.existsSync(file));
    if (shot) fs.copyFileSync(shot, path.join(evidenceDir, "launch-tab.png"));
    else evidence("launch-tab-screenshot-reply.txt", reply);
    await observer.close();
  }

  // The node restarts (browser and every session lost). The dashboard keeps
  // running, reconnects, and takes the new launch tab once an agent starts
  // the browser again: still exactly one dashboard tab and no blank tab.
  const nodePid = readPid("shared-node.pid");
  process.kill(nodePid);
  for (let attempt = 0; attempt < 240 && (readPid("shared-node.pid") === nodePid || !readPid("shared-node.pid")); attempt++) await sleep(250);
  await agentA.initialize();
  await agentA.tool("browser_tabs", { action: "new", url: app("a-again") });
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "dashboard" && s.tabs.length === 2 && s.tabs[0].is_dashboard, "dashboard after node restart");
  tabs = await agentA.tabs();
  if (tabs.some((line) => line.includes("(about:blank)")) || tabs.filter((line) => line.includes(`127.0.0.1:${dashPort}`)).length !== 1)
    throw new Error(`Unexpected tabs after the restart: ${tabs}`);
  if (readPid("dashboard.pid") !== dashboardPid) throw new Error("The dashboard process was restarted with the node.");
  evidence("07-after-node-restart.json", state);
  console.log("PASS: After the service restarts, the same dashboard process takes the new launch tab again, with no blank or duplicate tab.");
} finally {
  for (const client of clients) await client.close();
  const nodePid = readPid("shared-node.pid");
  if (nodePid) {
    try {
      process.kill(nodePid);
    } catch {
      // Already gone.
    }
  }
  if (launcher && launcher.exitCode === null) {
    await Promise.race([new Promise((resolve) => launcher.once("exit", resolve)), sleep(20_000)]);
  }
  stopTestProcesses();
  if (appServer) await new Promise((resolve) => appServer.close(() => resolve()));
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      break;
    } catch {
      await sleep(500);
    }
  }
}
