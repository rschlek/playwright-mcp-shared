// Live check of the launch-tab dashboard against the pinned Playwright MCP
// CLI, run headless in a disposable runtime on free ports. On Windows the
// supervisor script runs the service; elsewhere the test starts the node and
// the dashboard itself with the arguments the supervisor uses. Never touches
// the canonical runtime or its service.
//
//   node tests/test-playwright-mcp-dashboard-live.mjs [--evidence=<dir>]
//
// PLAYWRIGHT_MCP_SHARED_CLI points at the pinned @playwright/mcp cli.js when
// it is not in the default runtime root. --evidence writes the dashboard's
// JSON at each stage and a screenshot of the launch tab into <dir>.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const windows = process.platform === "win32";
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(testsDir, "..", "scripts");
const serverScript = path.join(scriptsDir, "playwright-mcp-shared.ps1");
const claimScript = path.join(scriptsDir, "playwright-tab-claim.ps1");
const claimPython = path.join(scriptsDir, "portable", "tab_claim.py");
const dashboardScript = path.join(scriptsDir, "playwright-mcp-dashboard.mjs");
const lib = await import(pathToFileURL(dashboardScript).href);
const defaultRoot = windows
  ? path.join(process.env.LOCALAPPDATA || "", "playwright-mcp-shared")
  : process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "playwright-mcp-shared")
    : path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "playwright-mcp-shared");
const mcpCli = process.env.PLAYWRIGHT_MCP_SHARED_CLI || path.join(defaultRoot, "package", "node_modules", "@playwright", "mcp", "cli.js");
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
const DASHBOARD_ENV = { PLAYWRIGHT_MCP_SHARED_DASHBOARD_POLL_MS: "500", PLAYWRIGHT_MCP_SHARED_DASHBOARD_RESTORE_GRACE_MS: "3000" };
let launcher;
let nodeChild;
let dashboardChild;
let appServer;
let mcpPort;
let dashPort;

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
  async listTools() {
    return await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} });
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

// Claim or release a tab through the platform's claim helper.
function claimHelper({ action, owner = "", task = "", url = "", ttlSeconds, claimId = "" }) {
  let result;
  if (windows) {
    const args = ["-Action", action === "claim" ? "Claim" : "Release"];
    if (action === "claim") args.push("-Owner", owner, "-Task", task, "-Url", url);
    if (ttlSeconds) args.push("-TtlSeconds", String(ttlSeconds));
    if (claimId) args.push("-ClaimId", claimId);
    result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", claimScript, "-RuntimeRoot", tempRoot, ...args],
      { encoding: "utf8", windowsHide: true },
    );
  } else {
    const args = [claimPython, action];
    if (action === "claim") args.push("--owner", owner, "--task", task, "--url", url);
    if (ttlSeconds) args.push("--ttl", String(ttlSeconds));
    if (claimId) args.push("--claim-id", claimId);
    result = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT: tempRoot } });
  }
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

async function waitUntil(predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return Date.now();
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}.`);
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

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// PIDs of browser processes started for this test's profile.
function profileBrowserPids({ mainOnly = false } = {}) {
  if (windows) {
    const command =
      "$p=$env:PLAYWRIGHT_SHARED_TEST_PROFILE; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and (-not $env:PLAYWRIGHT_SHARED_MAIN_ONLY -or -not $_.CommandLine.Contains('--type=')) } | " +
      "ForEach-Object { $_.ProcessId }";
    const out = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, PLAYWRIGHT_SHARED_TEST_PROFILE: profileRoot, PLAYWRIGHT_SHARED_MAIN_ONLY: mainOnly ? "1" : "" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let args;
    try {
      args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (!args.includes(`--user-data-dir=${profileRoot}`)) continue;
    if (mainOnly && args.some((arg) => arg.startsWith("--type="))) continue;
    pids.push(Number(entry));
  }
  return pids;
}

// The browser's main process: the SingletonLock target where there is one.
function browserPid() {
  if (!windows) {
    try {
      const pid = Number(String(fs.readlinkSync(path.join(profileRoot, "SingletonLock"))).split("-").pop());
      if (pid > 0) return pid;
    } catch {
      // Fall back to the process table.
    }
  }
  return profileBrowserPids({ mainOnly: true })[0] || 0;
}

function stopTestProcesses() {
  if (!windows) {
    for (const child of [dashboardChild, nodeChild]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const pid of profileBrowserPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    return;
  }
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

// Outside Windows, start the node the way the supervisor does.
function startNode() {
  fs.mkdirSync(path.join(tempRoot, "state"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "logs"), { recursive: true });
  const log = fs.openSync(path.join(tempRoot, "logs", "shared-server.stderr.log"), "a");
  nodeChild = spawn(
    process.execPath,
    [mcpCli, "--browser", "chrome", "--user-data-dir", profileRoot, "--output-dir", path.join(tempRoot, "outputs"),
      "--port", String(mcpPort), "--host", "127.0.0.1", "--shared-browser-context", "--headless"],
    { cwd: tempRoot, env: { ...process.env, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: "0" }, stdio: ["ignore", log, log] },
  );
  fs.writeFileSync(path.join(tempRoot, "state", "shared-node.pid"), String(nodeChild.pid));
}

function startDashboard() {
  const log = fs.openSync(path.join(tempRoot, "logs", "dashboard.stderr.log"), "a");
  dashboardChild = spawn(
    process.execPath,
    [dashboardScript, "--runtime-root", tempRoot, "--mcp-port", String(mcpPort), "--port", String(dashPort), "--profile", profileRoot,
      "--node-pid-file", path.join(tempRoot, "state", "shared-node.pid"), "--mcp-cli", mcpCli],
    { cwd: tempRoot, env: { ...process.env, ...DASHBOARD_ENV }, stdio: ["ignore", log, log] },
  );
  fs.writeFileSync(path.join(tempRoot, "state", "dashboard.pid"), String(dashboardChild.pid));
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

  mcpPort = await freePort();
  dashPort = await freePort();
  const endpoint = `http://localhost:${mcpPort}/mcp`;
  if (windows) {
    launcher = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", serverScript,
        "-RuntimeRoot", tempRoot, "-McpCli", mcpCli, "-ProfilePath", profileRoot, "-Port", String(mcpPort),
        "-Headless", "-RestartDelaySeconds", "0", "-MaxRestarts", "1", "-DashboardPort", String(dashPort)],
      {
        // The service writes relative output files under its working directory.
        cwd: tempRoot,
        env: { ...process.env, ...DASHBOARD_ENV },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    launcher.stderr.setEncoding("utf8");
    launcher.stderr.on("data", () => {});
  } else {
    startNode();
    startDashboard();
  }

  // The dashboard comes up with the service and waits for a browser.
  let state = await waitFor(dashPort, (s) => s.service.mcp_reachable && s.launch_tab.status === "detached", "dashboard detached before any agent");
  if (state.launch_tab.detail !== lib.DETAIL_NOT_RUNNING) throw new Error(`Unexpected detached detail: ${state.launch_tab.detail}`);
  const dashboardPid = readPid("dashboard.pid");
  if (!dashboardPid) throw new Error("The supervisor did not record a dashboard PID.");
  const pinned = JSON.parse(fs.readFileSync(path.join(path.dirname(mcpCli), "package.json"), "utf8")).version;
  if (state.service.mcp_package_version !== pinned)
    throw new Error(`The dashboard reports @playwright/mcp ${state.service.mcp_package_version}, expected ${pinned}.`);
  evidence("01-before-any-agent.json", state);

  // Connecting and listing tools does not start the browser; only a tool
  // call does.
  const agentA = new HttpMcpClient(endpoint, "agent-a");
  await agentA.initialize();
  await agentA.listTools();
  await sleep(2000);
  if (lib.browserRunning(profileRoot) || profileBrowserPids().length)
    throw new Error("The browser started before any tool call.");
  console.log("PASS: The browser does not start when the service starts or when an agent connects and lists tools.");

  // Agent A starts the browser by claiming a tab in one call, then
  // registers the claim.
  await agentA.tool("browser_tabs", { action: "new", url: app("a") });
  const claimA = claimHelper({ action: "claim", owner: "claude:agent-a", task: "Reading page A", url: `${app("a")}?session=hidden` });
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
  const claimB = claimHelper({ action: "claim", owner: "codex:agent-b", task: "Reading page B", url: app("b") });
  const agentC = new HttpMcpClient(endpoint, "agent-c");
  await agentC.initialize();
  await agentC.tool("browser_tabs", { action: "new", url: app("c") });
  const claimC = claimHelper({ action: "claim", owner: "claude:agent-c", task: "Short-lived claim", url: app("c"), ttlSeconds: 60 });
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
  const releaseB = claimHelper({ action: "release", claimId: claimB.payload.claim_id });
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

  // A person closes the browser (a SIGTERM to its main process stands in for
  // closing the window). The service keeps running, the agents stay
  // connected, and nothing starts the browser again: not the dashboard,
  // which detaches, and not the idle agents.
  const nodeBeforeClose = readPid("shared-node.pid");
  const chromePid = browserPid();
  if (!chromePid) throw new Error("Could not find the browser's main process.");
  const closedAt = Date.now();
  process.kill(chromePid, "SIGTERM");
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "detached" && s.launch_tab.detail === lib.DETAIL_CLOSED, "dashboard detached after the browser closed", 15_000);
  await sleep(Math.max(0, closedAt + 15_000 - Date.now()));
  const leftover = profileBrowserPids();
  if (lib.browserRunning(profileRoot) || leftover.length)
    throw new Error(`The browser is running 15 s after it was closed: ${leftover}`);
  state = await getJson(dashPort, "/api/state");
  if (state.launch_tab.status !== "detached" || state.browser.running !== false || state.tabs.length)
    throw new Error(`The dashboard did not stay detached: ${JSON.stringify(state.launch_tab)} ${JSON.stringify(state.browser)}`);
  if (!alive(nodeBeforeClose) || readPid("shared-node.pid") !== nodeBeforeClose) throw new Error("The service node did not survive the browser closing.");
  evidence("07-browser-closed.json", state);
  console.log("PASS: After the browser is closed with the dashboard attached, it stays closed for 15 s, the dashboard reports detached, and the service keeps running.");

  // An agent's next tool call starts the browser again, and the dashboard
  // takes the new launch tab with no extra blank tab.
  await agentA.tool("browser_tabs", { action: "new", url: app("a-relaunched") });
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "dashboard" && s.tabs.length === 2 && s.tabs[0].is_dashboard, "dashboard after the relaunch", 30_000);
  tabs = await agentA.tabs();
  if (tabs.some((line) => line.includes("(about:blank)")) || tabs.filter((line) => line.includes(`127.0.0.1:${dashPort}`)).length !== 1 || tabs.length !== 2)
    throw new Error(`Unexpected tabs after the relaunch: ${tabs}`);
  evidence("08-relaunched.json", state);
  console.log("PASS: An agent's tool call starts the browser again and the dashboard takes the new launch tab with no extra blank tab.");

  // An idle agent still counts: with agent A connected and quiet, the
  // browser stays open while the dashboard keeps polling.
  const idleSince = Date.now();
  await sleep(8000);
  if (!lib.browserRunning(profileRoot)) throw new Error("The browser closed while an idle agent was still connected.");
  state = await getJson(dashPort, "/api/state");
  if (Date.parse(state.service.last_poll_utc) <= idleSince || state.launch_tab.status !== "dashboard")
    throw new Error(`The dashboard stopped polling or lost its tab while an agent was idle: ${JSON.stringify(state.launch_tab)}`);
  console.log("PASS: An idle but connected agent keeps the browser open.");

  // The last agent session goes away: the browser closes, because the
  // dashboard is not a client between polls, and the dashboard keeps polling.
  for (const client of [agentA, agentB, agentC]) await client.close();
  const goneAt = Date.now();
  const closedBy = await waitUntil(() => !lib.browserRunning(profileRoot) && profileBrowserPids().length === 0, "the browser to close after the last agent left", 30_000);
  const pollAfterClose = Date.now();
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "detached" && Date.parse(s.last_poll_utc || s.service.last_poll_utc) > pollAfterClose, "dashboard still polling after the browser closed", 15_000);
  await sleep(3000);
  if (lib.browserRunning(profileRoot) || profileBrowserPids().length) throw new Error("Something started the browser again after the last agent left.");
  if (!alive(dashboardPid)) throw new Error("The dashboard exited when the browser closed.");
  evidence("09-last-agent-left.json", state);
  console.log(`PASS: When the last agent session is deleted the browser closes (${((closedBy - goneAt) / 1000).toFixed(1)} s) and the dashboard keeps polling without starting it again.`);

  // The node restarts (browser and every session lost). The dashboard keeps
  // running, reconnects, and takes the new launch tab once an agent starts
  // the browser again: still exactly one dashboard tab and no blank tab.
  const nodePid = readPid("shared-node.pid");
  process.kill(nodePid);
  if (windows) {
    for (let attempt = 0; attempt < 240 && (readPid("shared-node.pid") === nodePid || !readPid("shared-node.pid")); attempt++) await sleep(250);
  } else {
    // Stand in for the supervisor's restart.
    await waitUntil(() => nodeChild.exitCode !== null || nodeChild.signalCode !== null, "the node to exit", 15_000);
    startNode();
  }
  await agentA.initialize();
  await agentA.tool("browser_tabs", { action: "new", url: app("a-again") });
  state = await waitFor(dashPort, (s) => s.launch_tab.status === "dashboard" && s.tabs.length === 2 && s.tabs[0].is_dashboard, "dashboard after node restart");
  tabs = await agentA.tabs();
  if (tabs.some((line) => line.includes("(about:blank)")) || tabs.filter((line) => line.includes(`127.0.0.1:${dashPort}`)).length !== 1)
    throw new Error(`Unexpected tabs after the restart: ${tabs}`);
  if (readPid("dashboard.pid") !== dashboardPid) throw new Error("The dashboard process was restarted with the node.");
  evidence("10-after-node-restart.json", state);
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
  if (nodeChild && nodeChild.exitCode === null && nodeChild.signalCode === null) {
    await Promise.race([new Promise((resolve) => nodeChild.once("exit", resolve)), sleep(10_000)]);
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
