// Linux lifecycle test for the bash supervisor, stop script, and systemd unit.
//
// Every case runs in a temporary runtime on free ports with the dashboard off
// unless the case is about the dashboard. Cases A-F and the installer case use
// a stub CLI (a node script that carries the same argv and only listens on
// --port), so they need no Chrome and no package. Case G runs the real pinned
// CLI headless when one is available (PLAYWRIGHT_MCP_SHARED_CLI, --cli=<path>,
// or the canonical runtime's package) and is skipped otherwise. Case H runs
// only with --systemd, through a transient `systemd-run --user` unit with a
// test-only name; it never touches an installed unit.
//
//   node tests/test-linux-autostart.mjs [--systemd] [--cli=<path>] [--only=A,B]

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("SKIP: Linux lifecycle test requires Linux.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(testsDir, "..", "scripts");
const argValue = (name) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const onlyCases = argValue("only")?.split(",").map((value) => value.trim().toUpperCase());
const wantSystemd = process.argv.includes("--systemd");
const canonicalRoot = process.env.PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT ||
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "playwright-mcp-shared");
const realCli = argValue("cli") || process.env.PLAYWRIGHT_MCP_SHARED_CLI ||
  path.join(canonicalRoot, "package", "node_modules", "@playwright", "mcp", "cli.js");

const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-mcp-linux-autostart-"));
const results = [];
const children = new Set();

const STUB_CLI = `
import http from "node:http";
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const server = http.createServer((request, response) => response.end("stub"));
server.listen(port, "127.0.0.1");
const exitAfter = Number(process.env.STUB_EXIT_AFTER_MS || 0);
if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
    // Never collide with an installed service's default ports.
    if (port !== 8931 && port !== 8932) return port;
  }
}

async function listening(port) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0.
  try {
    return !/\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
}

function processesMatching(fragment) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid && cmdline(pid).includes(fragment));
}

function readPid(file) {
  try {
    return Number(readFileSync(file, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

// A disposable runtime laid out like an installation: the scripts in bin/ and
// the stub CLI at the package's CLI path.
function makeRuntime(name, { stub = true } = {}) {
  const root = path.join(tempRoot, name);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const file of readdirSync(scriptsDir)) {
    if (file.endsWith(".sh") || file.endsWith(".mjs")) {
      copyFileSync(path.join(scriptsDir, file), path.join(bin, file));
      if (file.endsWith(".sh")) chmodSync(path.join(bin, file), 0o755);
    }
  }
  const cli = path.join(root, "package", "node_modules", "@playwright", "mcp", "cli.js");
  if (stub) {
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(path.join(path.dirname(cli), "package.json"), '{"type":"module"}\n');
    writeFileSync(cli, STUB_CLI);
  }
  const state = path.join(root, "state");
  return {
    root,
    cli,
    launcher: path.join(bin, "playwright-mcp-shared.sh"),
    stopScript: path.join(bin, "stop-playwright-mcp-shared.sh"),
    installer: path.join(bin, "install-playwright-mcp-shared-autostart.sh"),
    serverPid: path.join(state, "shared-server.pid"),
    nodePid: path.join(state, "shared-node.pid"),
    dashboardPid: path.join(state, "dashboard.pid"),
    bootstrapLog: path.join(root, "logs", "shared-server.bootstrap.log"),
    profile: path.join(root, "profiles", "shared"),
  };
}

function launcherArgs(runtime, port, extra = []) {
  return [runtime.launcher, "-RuntimeRoot", runtime.root, "-Port", String(port), "-DashboardPort", "0", "-Headless", ...extra];
}

function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PLAYWRIGHT_MCP_SHARED_")) delete env[key];
  }
  return { ...env, ...extra };
}

function startLauncher(runtime, port, extra = [], env = {}) {
  const child = spawn("bash", launcherArgs(runtime, port, extra), {
    env: testEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (chunk) => (child.output += chunk));
  child.stderr.on("data", (chunk) => (child.output += chunk));
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  children.add(child);
  return child;
}

function runSync(program, args, { env = {}, timeout = 60_000 } = {}) {
  const result = spawnSync(program, args, { env: testEnv(env), encoding: "utf8", timeout });
  return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

async function waitForService(runtime, port, label = "service") {
  await waitFor(async () => readPid(runtime.nodePid) > 0 && (await listening(port)), 30_000, `${label} on port ${port}`);
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([child.exited, sleep(20_000)]);
}

async function runCase(id, title, body, skipReason = null) {
  if (onlyCases && !onlyCases.includes(id)) return;
  if (skipReason) {
    results.push({ id, title, status: "SKIP", detail: skipReason });
    console.log(`SKIP ${id} ${title}: ${skipReason}`);
    return;
  }
  const started = Date.now();
  try {
    await body();
    results.push({ id, title, status: "PASS" });
    console.log(`PASS ${id} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    results.push({ id, title, status: "FAIL", detail: error.message });
    console.log(`FAIL ${id} ${title}: ${error.stack || error.message}`);
  }
}

// A: a node that exits cleanly is restarted; the restart limit ends the run.
await runCase("A", "restart after a clean exit", async () => {
  const runtime = makeRuntime("a");
  const port = await freePort();
  const result = runSync("bash", launcherArgs(runtime, port, ["-RestartDelaySeconds", "0", "-MaxRestarts", "1"]), {
    env: { STUB_EXIT_AFTER_MS: "1000" },
  });
  const log = readText(runtime.bootstrapLog);
  assert(result.code === 0, `launcher exit ${result.code}: ${result.stderr}`);
  assert(count(log, "Playwright MCP node process started") === 2, `expected two starts:\n${log}`);
  assert(count(log, "Playwright MCP node process exited with code 0; restarting after 0 seconds") === 1, `expected one restart:\n${log}`);
  assert(count(log, "Playwright MCP node process exited with code 0; restart limit reached") === 1, `expected the limit line:\n${log}`);
  assert(!existsSync(runtime.serverPid) && !existsSync(runtime.nodePid), "the launcher left its PID files");
});

// B: a port held by anything but the managed node is refused, and no PID file
// changes.
await runCase("B", "foreign port owner", async () => {
  const runtime = makeRuntime("b");
  const port = await freePort();
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(port, "127.0.0.1", resolve));
  try {
    mkdirSync(path.dirname(runtime.serverPid), { recursive: true });
    writeFileSync(runtime.serverPid, "4194300");
    writeFileSync(runtime.nodePid, "4194301");
    const result = runSync("bash", launcherArgs(runtime, port));
    assert(result.code === 70, `expected exit 70, got ${result.code}: ${result.stderr}`);
    const expected = `Loopback port ${port} is already in use by process ${process.pid} (`;
    assert(result.stderr.includes(expected), `missing the owner message: ${result.stderr}`);
    assert(
      result.stderr.includes("which is not this runtime's managed Playwright MCP node."),
      `missing the managed-node wording: ${result.stderr}`,
    );
    assert(readText(runtime.serverPid) === "4194300", "shared-server.pid changed");
    assert(readText(runtime.nodePid) === "4194301", "shared-node.pid changed");
    assert(!existsSync(runtime.dashboardPid), "dashboard.pid was written");
  } finally {
    holder.close();
  }
});

// C: a stopped launcher removes only PID files that still hold its own values.
await runCase("C", "own-value PID cleanup", async () => {
  const runtime = makeRuntime("c");
  const port = await freePort();

  let launcher = startLauncher(runtime, port);
  await waitForService(runtime, port);
  const firstNode = readPid(runtime.nodePid);
  writeFileSync(runtime.serverPid, "4194300");
  writeFileSync(runtime.nodePid, "4194301");
  launcher.kill("SIGTERM");
  const stopped = await launcher.exited;
  assert(stopped.code === 143, `expected exit 143 after TERM, got ${JSON.stringify(stopped)}`);
  assert(readText(runtime.serverPid) === "4194300", "a foreign shared-server.pid was removed");
  assert(readText(runtime.nodePid) === "4194301", "a foreign shared-node.pid was removed");
  await waitFor(() => !alive(firstNode), 10_000, "the node to stop with its launcher");

  // A normal stop removes the launcher's own files.
  launcher = startLauncher(runtime, port);
  await waitFor(async () => readPid(runtime.nodePid) > 0 && readPid(runtime.nodePid) !== 4194301 && (await listening(port)), 30_000, "second service");
  assert(readPid(runtime.serverPid) === launcher.pid, "shared-server.pid does not hold the launcher PID");
  launcher.kill("SIGTERM");
  await launcher.exited;
  assert(!existsSync(runtime.serverPid), "the launcher left its own shared-server.pid");
  assert(!existsSync(runtime.nodePid), "the launcher left its own shared-node.pid");
  assert(!(await listening(port)), "the port is still listening after the stop");
});

// D: a supervisor killed outright leaves its node serving; the next launcher
// adopts it instead of failing on the port, and restarts it when it exits.
await runCase("D", "adoption of a managed node", async () => {
  const runtime = makeRuntime("d");
  const port = await freePort();
  const detach = runSync("bash", launcherArgs(runtime, port, ["-Detach", "-RestartDelaySeconds", "0"]));
  assert(detach.code === 0, `detached launch failed: ${detach.stderr}`);
  await waitForService(runtime, port, "detached service");
  await waitFor(() => readPid(runtime.serverPid) > 0, 10_000, "shared-server.pid");
  const supervisor = readPid(runtime.serverPid);
  const node = readPid(runtime.nodePid);

  // The node must not hold the singleton lock (fd 9) of its supervisor.
  const lockPath = path.join(runtime.root, "locks", "shared-server.lock");
  for (const fd of readdirSync(`/proc/${node}/fd`)) {
    let target = "";
    try {
      target = readlinkSync(`/proc/${node}/fd/${fd}`);
    } catch {
      continue;
    }
    assert(target !== lockPath, `the node inherited the singleton lock on fd ${fd}`);
  }

  process.kill(supervisor, "SIGKILL");
  await waitFor(() => !alive(supervisor), 10_000, "the supervisor to die");
  assert(alive(node), "the node died with its supervisor");

  const adopter = startLauncher(runtime, port, ["-RestartDelaySeconds", "0"]);
  try {
    await waitFor(() => readText(runtime.bootstrapLog).includes(`Playwright MCP node process adopted pid=${node}`), 15_000, "adoption");
    const log = readText(runtime.bootstrapLog);
    assert(log.includes("loopback port owned by the managed Playwright MCP node process"), "missing the port-owner log line");
    assert(readPid(runtime.nodePid) === node, "shared-node.pid changed on adoption");
    assert(readPid(runtime.serverPid) === adopter.pid, "shared-server.pid does not hold the adopting launcher");
    assert(processesMatching(runtime.cli).length === 1, `expected one node, found ${processesMatching(runtime.cli)}`);

    process.kill(node, "SIGTERM");
    await waitFor(
      async () => readPid(runtime.nodePid) > 0 && readPid(runtime.nodePid) !== node && (await listening(port)),
      20_000,
      "the adopting supervisor to restart the node",
    );
    assert(
      readText(runtime.bootstrapLog).includes("Playwright MCP node process exited with code unknown; restarting after 0 seconds"),
      "missing the adopted-node restart line",
    );
    assert(processesMatching(runtime.cli).length === 1, "more than one node after the restart");
  } finally {
    await stopChild(adopter);
  }
  assert(!(await listening(port)), "the port is still listening after the adopter stopped");
});

// E: a second launch while a supervisor is alive exits 0 and changes nothing.
await runCase("E", "second launch exits quietly", async () => {
  const runtime = makeRuntime("e");
  const port = await freePort();
  const launcher = startLauncher(runtime, port);
  try {
    await waitForService(runtime, port);
    const before = {
      server: readText(runtime.serverPid),
      node: readText(runtime.nodePid),
      log: readText(runtime.bootstrapLog),
    };
    const second = runSync("bash", launcherArgs(runtime, port));
    assert(second.code === 0, `second launch exit ${second.code}: ${second.stderr}`);
    assert(second.stderr.includes("The shared Playwright MCP server is already running."), `unexpected output: ${second.stderr}`);
    assert(readText(runtime.serverPid) === before.server, "shared-server.pid changed");
    assert(readText(runtime.nodePid) === before.node, "shared-node.pid changed");
    assert(readText(runtime.bootstrapLog) === before.log, "the second launch wrote to the bootstrap log");
    assert(processesMatching(runtime.cli).length === 1, "a second node started");
  } finally {
    await stopChild(launcher);
  }
});

// F: the stop script frees the port and removes the PID files, and never
// signals a recorded PID that now belongs to another program.
await runCase("F", "stop script", async () => {
  const runtime = makeRuntime("f");
  const port = await freePort();
  const unitName = `pwmcp-test-${process.pid}-absent`;
  const detach = runSync("bash", launcherArgs(runtime, port, ["-Detach"]));
  assert(detach.code === 0, `detached launch failed: ${detach.stderr}`);
  await waitForService(runtime, port);
  await waitFor(() => readPid(runtime.serverPid) > 0, 10_000, "shared-server.pid");
  const supervisor = readPid(runtime.serverPid);
  const node = readPid(runtime.nodePid);

  const stop = runSync("bash", [runtime.stopScript, "-RuntimeRoot", runtime.root, "-Port", String(port), "-UnitName", unitName]);
  assert(stop.code === 0, `stop exit ${stop.code}: ${stop.stderr}`);
  assert(stop.stdout.includes("Shared Playwright MCP server stopped."), `unexpected stop output: ${stop.stdout}`);
  assert(!(await listening(port)), "the port is still listening");
  assert(!alive(supervisor) && !alive(node), "a managed process survived the stop");
  for (const file of [runtime.serverPid, runtime.nodePid, runtime.dashboardPid]) {
    assert(!existsSync(file), `${path.basename(file)} survived the stop`);
  }

  const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
  children.add(bystander);
  try {
    writeFileSync(runtime.serverPid, String(bystander.pid));
    writeFileSync(runtime.nodePid, String(bystander.pid));
    const refuse = runSync("bash", [runtime.stopScript, "-RuntimeRoot", runtime.root, "-Port", String(port), "-UnitName", unitName]);
    assert(refuse.code === 0, `stop exit ${refuse.code}: ${refuse.stderr}`);
    assert(
      refuse.stderr.includes(`PID ${bystander.pid} does not match the managed Playwright command; refusing to stop it`),
      `missing the refusal: ${refuse.stderr}`,
    );
    assert(alive(bystander.pid), "the stop script signalled an unrelated process");
    assert(!existsSync(runtime.serverPid) && !existsSync(runtime.nodePid), "stale PID files were kept");
  } finally {
    bystander.kill("SIGKILL");
  }
});

// Installer: the unit it writes, checked against a stand-in systemctl so no
// real unit is created or started.
await runCase("U", "installer unit (stand-in systemctl)", async () => {
  const runtime = makeRuntime("u");
  const configHome = path.join(tempRoot, "u-config");
  const shim = path.join(tempRoot, "u-shim");
  mkdirSync(shim, { recursive: true });
  const calls = path.join(shim, "calls.log");
  writeFileSync(
    path.join(shim, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *is-enabled*) echo enabled ;; *is-active*) echo active ;; esac\nexit 0\n`,
  );
  chmodSync(path.join(shim, "systemctl"), 0o755);
  const unitName = `pwmcp-test-${process.pid}`;
  const result = runSync(
    "bash",
    [runtime.installer, "-RuntimeRoot", runtime.root, "-Port", "18931", "-DashboardPort", "18932", "-UnitName", unitName, "-Start"],
    { env: { XDG_CONFIG_HOME: configHome, PATH: `${shim}:${process.env.PATH}`, DISPLAY: "", WAYLAND_DISPLAY: "" } },
  );
  assert(result.code === 0, `installer exit ${result.code}: ${result.stderr}`);
  const unit = readText(path.join(configHome, "systemd", "user", `${unitName}.service`));
  for (const line of [
    "After=graphical-session.target",
    "PartOf=graphical-session.target",
    "Restart=always",
    "RestartSec=5",
    "WantedBy=graphical-session.target",
    `"${runtime.launcher}" -RuntimeRoot "${runtime.root}"`,
    "-Port 18931 -DashboardPort 18932",
    "-NodePath",
  ]) {
    assert(unit.includes(line), `unit lacks ${line}:\n${unit}`);
  }
  assert(!/KillMode=/.test(unit), "the unit overrides KillMode");
  const config = JSON.parse(readText(path.join(runtime.root, "state", "linux-service-config.json")));
  assert(config.UnitName === unitName && config.Port === 18931 && config.DashboardPort === 18932, "service configuration mismatch");
  const log = readText(calls);
  assert(log.includes(`enable ${unitName}`) && log.includes(`restart ${unitName}`), `unexpected systemctl calls:\n${log}`);
  assert(!log.includes("playwright-mcp-shared"), "the installer addressed the default unit");
});

// ---- Case G: the real CLI, on demand -------------------------------------

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
        response = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(message) });
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        await sleep(250);
      }
    }
    const assigned = response.headers.get("mcp-session-id");
    if (assigned) this.sessionId = assigned;
    if (!response.ok) throw new Error(`${this.name}: HTTP ${response.status} ${await response.text()}`);
    if (response.status === 202) return null;
    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let payload;
    if (contentType.includes("text/event-stream")) {
      const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
      payload = JSON.parse(data.join(""));
    } else {
      payload = JSON.parse(body);
    }
    if (payload.error) throw new Error(`${this.name}: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  async initialize() {
    await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: this.name, version: "1.0.0" } },
      },
      200,
    );
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async listTools() {
    return await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} });
  }

  async callTool(name, args = {}) {
    return await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
  }

  async close() {
    if (!this.sessionId) return;
    await fetch(this.endpoint, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId, "mcp-protocol-version": "2025-03-26" },
    }).catch(() => {});
    this.sessionId = null;
  }
}

function resultText(result) {
  return (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

// The Chrome browser process for a profile: the one launched with that
// user-data directory and no --type= (renderers and helpers carry one).
function chromePids(profile) {
  return processesMatching(`--user-data-dir=${profile}`).filter((pid) => !cmdline(pid).includes(" --type="));
}

function singletonLockPid(profile) {
  try {
    return Number(readlinkSync(path.join(profile, "SingletonLock")).split("-").pop()) || 0;
  } catch {
    return 0;
  }
}

async function noChromeFor(profile, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    assert(chromePids(profile).length === 0, `Chrome is running ${label}`);
    await sleep(500);
  }
}

async function closeChromeLikeAHuman(profile) {
  const pid = singletonLockPid(profile) || chromePids(profile)[0];
  assert(pid > 0, "no Chrome process to close");
  process.kill(pid, "SIGTERM");
  await waitFor(() => chromePids(profile).length === 0, 15_000, "Chrome to exit");
}

const gSkip = existsSync(realCli)
  ? null
  : `no Playwright MCP CLI at ${realCli} (set PLAYWRIGHT_MCP_SHARED_CLI or pass --cli=<path>)`;

// The dashboard half of G needs a dashboard that lets a closed browser stay
// closed. One that still offers `--attach always` predates that change and
// reopens Chrome within a poll, so that half is skipped against it.
const dashboardSource = readText(path.join(scriptsDir, "playwright-mcp-dashboard.mjs"));
const dashboardOnDemand = !/\["when-running", "always"\]/.test(dashboardSource);

await runCase(
  "G1",
  "browser starts on demand and a closed browser stays closed",
  async () => {
    const runtime = makeRuntime("g1", { stub: false });
    const port = await freePort();
    const endpoint = `http://localhost:${port}/mcp`;

    const launcher = startLauncher(runtime, port, ["-McpCli", realCli, "-RestartDelaySeconds", "0"]);
    const agent = new HttpMcpClient(endpoint, "linux-autostart-agent");
    try {
      await waitForService(runtime, port);
      const node = readPid(runtime.nodePid);
      await noChromeFor(runtime.profile, 2_000, "after the service started");
      await agent.initialize();
      await agent.listTools();
      await noChromeFor(runtime.profile, 2_000, "after initialize and tools/list");
      await agent.callTool("browser_tabs", { action: "list" });
      await waitFor(() => chromePids(runtime.profile).length > 0, 30_000, "a tool call to start Chrome");

      await closeChromeLikeAHuman(runtime.profile);
      assert(readPid(runtime.nodePid) === node, "the node restarted when Chrome closed");
      assert(await listening(port), "the port stopped listening when Chrome closed");
      await noChromeFor(runtime.profile, 15_000, "15 s after it was closed (no dashboard)");
      await agent.close();
    } finally {
      await stopChild(launcher);
    }
    await waitFor(() => chromePids(runtime.profile).length === 0, 15_000, "Chrome to exit with the service");
  },
  gSkip,
);

await runCase(
  "G2",
  "with the dashboard attached a closed browser stays closed",
  async () => {
    const runtime = makeRuntime("g2", { stub: false });
    const port = await freePort();
    const dashboardPort = await freePort();
    const endpoint = `http://localhost:${port}/mcp`;

    const launcher = startLauncher(runtime, port, ["-McpCli", realCli, "-RestartDelaySeconds", "0", "-DashboardPort", String(dashboardPort)]);
    const second = new HttpMcpClient(endpoint, "linux-autostart-agent-2");
    try {
      await waitForService(runtime, port);
      await waitFor(() => readPid(runtime.dashboardPid) > 0, 15_000, "the dashboard to start");
      const dashboard = readPid(runtime.dashboardPid);
      await second.initialize();
      await second.callTool("browser_tabs", { action: "list" });
      await waitFor(() => chromePids(runtime.profile).length > 0, 30_000, "a tool call to start Chrome");
      const dashboardUrl = `http://127.0.0.1:${dashboardPort}/`;
      const tabsShowDashboard = async () => {
        const tabs = resultText(await second.callTool("browser_tabs", { action: "list" }));
        return tabs.includes(dashboardUrl) && !tabs.includes("(about:blank)");
      };
      await waitFor(tabsShowDashboard, 30_000, "the dashboard to take the launch tab");

      await closeChromeLikeAHuman(runtime.profile);
      await noChromeFor(runtime.profile, 15_000, "15 s after it was closed with the dashboard attached");
      assert(readPid(runtime.dashboardPid) === dashboard, "the dashboard restarted");

      // An agent tool call starts it again, and the dashboard takes the new
      // launch tab without leaving a blank tab.
      await second.callTool("browser_tabs", { action: "list" });
      await waitFor(() => chromePids(runtime.profile).length > 0, 30_000, "a tool call to restart Chrome");
      await waitFor(tabsShowDashboard, 30_000, "the dashboard to take the relaunched launch tab");
      const tabs = resultText(await second.callTool("browser_tabs", { action: "list" }));
      assert(count(tabs, dashboardUrl) === 1, `expected one dashboard tab:\n${tabs}`);
      await second.close();
    } finally {
      await stopChild(launcher);
    }
    await waitFor(() => chromePids(runtime.profile).length === 0, 15_000, "Chrome to exit with the service");
  },
  gSkip ||
    (dashboardOnDemand
      ? null
      : "the bundled dashboard still keeps the browser open (it offers --attach always)"),
);

// ---- Case H: systemd ---------------------------------------------------------

function systemdUserAvailable() {
  const result = runSync("systemctl", ["--user", "is-system-running"], { timeout: 10_000 });
  return !result.error && /running|degraded/.test(result.stdout);
}

let hSkip = null;
if (!wantSystemd) hSkip = "pass --systemd to run it";
else if (!systemdUserAvailable()) hSkip = "no systemd --user manager";

await runCase(
  "H",
  "transient systemd unit restarts and a stop stays stopped",
  async () => {
    const runtime = makeRuntime("h");
    const port = await freePort();
    const unit = `pwmcp-test-${process.pid}`;
    assert(unit !== "playwright-mcp-shared", "refusing the installed unit name");
    const show = (property) =>
      runSync("systemctl", ["--user", "show", "-p", property, "--value", `${unit}.service`]).stdout.trim();
    const start = runSync("systemd-run", [
      "--user",
      `--unit=${unit}`,
      "-p", "Restart=always",
      "-p", "RestartSec=1",
      "-p", "TimeoutStopSec=30",
      `--setenv=PATH=${process.env.PATH}`,
      "bash",
      ...launcherArgs(runtime, port, ["-NodePath", process.execPath]),
    ]);
    try {
      assert(start.code === 0, `systemd-run failed: ${start.stderr}`);
      await waitForService(runtime, port, "unit service");
      const firstMain = Number(show("MainPID"));
      assert(firstMain > 0 && cmdline(firstMain).includes(runtime.launcher), "MainPID is not the launcher");

      process.kill(firstMain, "SIGKILL");
      await waitFor(
        async () => {
          const main = Number(show("MainPID"));
          return main > 0 && main !== firstMain && (await listening(port));
        },
        30_000,
        "systemd to restart the launcher",
      );
      assert(processesMatching(runtime.cli).length === 1, "more than one node after the unit restart");

      const stop = runSync("bash", [runtime.stopScript, "-RuntimeRoot", runtime.root, "-Port", String(port), "-UnitName", unit], {
        timeout: 90_000,
      });
      assert(stop.code === 0, `stop exit ${stop.code}: ${stop.stderr}`);
      assert(!(await listening(port)), "the port is still listening after the stop");
      await sleep(3_000);
      const state = runSync("systemctl", ["--user", "is-active", `${unit}.service`]).stdout.trim();
      assert(state !== "active" && state !== "activating", `the unit came back: ${state}`);
    } finally {
      runSync("systemctl", ["--user", "stop", `${unit}.service`]);
      runSync("systemctl", ["--user", "reset-failed", `${unit}.service`]);
    }
  },
  hSkip,
);

// ---- teardown ----------------------------------------------------------------

for (const child of children) {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}
for (const pid of processesMatching(tempRoot)) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
await sleep(500);
await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((error) =>
  console.warn(`WARN: could not remove the test runtime: ${error.message}`),
);

const failed = results.filter((result) => result.status === "FAIL");
console.log(
  `${failed.length ? "FAIL" : "PASS"}: ${results.filter((r) => r.status === "PASS").map((r) => r.id).join(",") || "none"} passed` +
    `; skipped ${results.filter((r) => r.status === "SKIP").map((r) => r.id).join(",") || "none"}` +
    (failed.length ? `; failed ${failed.map((r) => r.id).join(",")}` : ""),
);
process.exit(failed.length ? 1 : 0);
