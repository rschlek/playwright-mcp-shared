// Dashboard behavior against a scripted MCP service. The fake service models
// the parts of the shared Playwright MCP server the dashboard relies on: one
// shared page list, a current-tab pointer per session that starts at the
// first page, the pointer moving to a neighbour when its page closes, and
// "Session not found" after a restart.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardScript = path.resolve(testsDir, "..", "scripts", "playwright-mcp-dashboard.mjs");
const lib = await import(pathToFileURL(dashboardScript).href);
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-mcp-dashboard-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function unitTests() {
  assert(lib.redactUrl("https://user:pw@Example.com:443/a/b?token=1#x") === "https://example.com/a/b", "redactUrl keeps only scheme, host, and path");
  assert(lib.redactUrl("about:blank") === "about:blank", "redactUrl keeps about:blank");

  const parsed = lib.parseTabList(
    "### Result\n- 0: (current) [Shared [browser]](http://127.0.0.1:1/)\n- 1: [](about:blank)\n- 2: [x](https://a.test/p?q=1) [crashed]",
  );
  assert(parsed.length === 3, "parseTabList reads every tab line");
  assert(parsed[0].current && parsed[0].title === "Shared [browser]", "parseTabList keeps bracketed titles");
  assert(parsed[2].crashed && parsed[2].url === "https://a.test/p?q=1", "parseTabList reads URL and crash marker");

  let next = 1;
  const allocate = () => next++;
  const first = lib.alignTabs([], [{ url: "D" }, { url: "A" }, { url: "B" }], allocate);
  // Close tab 0; the remaining tabs keep their IDs.
  const closed = lib.alignTabs(first, [{ url: "A" }, { url: "B" }], allocate);
  assert(closed[0].id === first[1].id && closed[1].id === first[2].id, "alignTabs follows tabs across a closure");
  // Tab 0 navigates elsewhere and a new tab opens: tab 0 keeps its ID.
  const drift = lib.alignTabs(first, [{ url: "X" }, { url: "A" }, { url: "B" }, { url: "C" }], allocate);
  assert(drift[0].id === first[0].id && drift[3].id > first[2].id, "alignTabs keeps a navigated tab and appends a new one");
  // Tab 1 closes and another opens with a fresh URL.
  const swap = lib.alignTabs(first, [{ url: "D" }, { url: "B" }, { url: "N" }], allocate);
  assert(swap[0].id === first[0].id && swap[1].id === first[2].id && swap[2].id !== first[1].id, "alignTabs handles a close plus an open");
}

// ---------------------------------------------------------------------------
// Fake MCP service
// ---------------------------------------------------------------------------

class FakeService {
  constructor() {
    this.pages = [];
    this.sessions = new Map();
    this.calls = [];
    this.nextPage = 1;
    this.serverName = "fake";
  }

  open(url, title = "") {
    const page = { pid: this.nextPage++, url, title };
    this.pages.push(page);
    for (const session of this.sessions.values()) if (!session.current) session.current = page;
    return page;
  }

  close(page) {
    const index = this.pages.indexOf(page);
    this.pages.splice(index, 1);
    for (const session of this.sessions.values()) {
      if (session.current === page) session.current = this.pages[Math.min(index, this.pages.length - 1)];
    }
  }

  restart() {
    this.sessions.clear();
  }

  list(session) {
    return this.pages
      .map((page, index) => `- ${index}:${page === session.current ? " (current)" : ""} [${page.title}](${page.url})`)
      .join("\n");
  }

  tool(session, name, args) {
    this.calls.push({ name, args });
    if (name === "browser_tabs" && args.action === "list") {
      if (!session.current) session.current = this.open("about:blank");
    } else if (name === "browser_tabs" && args.action === "new") {
      session.current = this.open(args.url || "about:blank", "Shared browser - launch tab");
    } else if (name === "browser_tabs" && args.action === "select") {
      session.current = this.pages[args.index];
    } else if (name === "browser_navigate") {
      session.current.url = args.url;
      session.current.title = "Shared browser - launch tab";
    } else {
      return { content: [{ type: "text", text: "### Error\nunsupported" }], isError: true };
    }
    return { content: [{ type: "text", text: `### Result\n${this.list(session)}` }] };
  }

  handler(port) {
    return (req, res) => {
      if (req.headers.host !== `localhost:${port}`) {
        res.writeHead(403);
        res.end(`Access is only allowed at localhost:${port}`);
        return;
      }
      if (req.method === "GET") {
        res.writeHead(400);
        res.end("Invalid request");
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const sessionId = req.headers["mcp-session-id"];
        if (req.method === "DELETE") {
          this.sessions.delete(sessionId);
          res.writeHead(200);
          res.end();
          return;
        }
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          const id = randomUUID();
          this.sessions.set(id, { current: this.pages[0] });
          res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": id });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "Playwright", version: "0.0.0-fake" }, capabilities: {} } })}\n\n`);
          return;
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }
        if (!("id" in message)) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result = this.tool(session, message.params.name, message.params.arguments || {});
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
      });
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeClaims(claims) {
  fs.mkdirSync(path.join(tempRoot, "locks"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "locks", "tab-claims.json"), JSON.stringify({ schema: 1, claims }));
}

function claim(owner, url, { task = "", ttlSeconds = 600, id = randomUUID().replace(/-/g, "") } = {}) {
  const now = Date.now();
  return {
    claim_id: id,
    owner,
    task,
    url: lib.redactUrl(url),
    claimed_utc: new Date(now).toISOString(),
    renewed_utc: new Date(now).toISOString(),
    expires_utc: new Date(now + ttlSeconds * 1000).toISOString(),
  };
}

function get(port, pathname, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function state(port) {
  return JSON.parse((await get(port, "/api/state")).body);
}

async function waitFor(port, predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await state(port);
      if (predicate(last)) return last;
    } catch {
      // The dashboard may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}. Last state: ${JSON.stringify(last)}. Dashboard stderr: ${children.map((c) => c.stderrText || "").join(" | ")}`);
}

function startDashboard(args) {
  const child = spawn(process.execPath, [dashboardScript, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderrText = "";
  child.stderr.on("data", (chunk) => (child.stderrText += chunk));
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

// Hold the profile's browser lock the way a running Chrome does.
function holdBrowserLock(profile) {
  fs.mkdirSync(profile, { recursive: true });
  if (process.platform === "win32") {
    const lockfile = path.join(profile, "lockfile").replace(/'/g, "''");
    const holder = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$f=[IO.File]::Open('${lockfile}','OpenOrCreate','ReadWrite','None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 60`],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    children.push(holder);
    return new Promise((resolve) => holder.stdout.once("data", () => resolve(() => stopChild(holder))));
  }
  fs.symlinkSync(`testhost-${process.pid}`, path.join(profile, "SingletonLock"));
  return Promise.resolve(async () => fs.rmSync(path.join(profile, "SingletonLock"), { force: true }));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

try {
  unitTests();
  console.log("PASS: Dashboard helpers redact URLs, parse tab lists, and keep tab identity across closes, navigations, and new tabs.");

  const fake = new FakeService();
  const mcpPort = await freePort();
  const mcpServer = http.createServer(fake.handler(mcpPort));
  await new Promise((resolve) => mcpServer.listen(mcpPort, "127.0.0.1", resolve));
  const profile = path.join(tempRoot, "profile");
  const dashPort = await freePort();
  const common = ["--runtime-root", tempRoot, "--mcp-port", String(mcpPort), "--port", String(dashPort), "--profile", profile, "--poll-ms", "150"];

  try {
    // 1. Attach only while a browser owns the profile.
    fake.open("about:blank");
    let dashboard = startDashboard([...common, "--attach", "when-running"]);
    let s = await waitFor(dashPort, (x) => Boolean(x.service.last_poll_utc), "first poll");
    await sleep(600);
    assert(fake.sessions.size === 0, "The dashboard connected while no browser owned the profile.");
    s = await state(dashPort);
    assert(s.launch_tab.status === "detached" && s.service.mcp_reachable === true, `Detached state wrong: ${JSON.stringify(s.launch_tab)}`);
    const release = await holdBrowserLock(profile);
    s = await waitFor(dashPort, (x) => x.launch_tab.status === "dashboard", "attach once the browser runs");
    await release();
    assert(fake.pages.length === 1 && lib.isDashboardUrl(fake.pages[0].url, `http://127.0.0.1:${dashPort}`), `The launch tab does not show the dashboard: ${JSON.stringify(fake.pages)}`);
    assert(s.tabs.length === 1 && s.tabs[0].is_dashboard && s.tabs[0].index === 0, "The dashboard is not marked as tab 0.");
    assert(!fake.pages.some((page) => page.url === "about:blank"), "A blank tab remained.");
    console.log("PASS: The dashboard waits for a running browser, then shows itself in the blank launch tab without opening another tab.");
    // A hard kill cannot close the MCP session; the next run must.
    const killedSession = [...fake.sessions.keys()][0];
    await stopChild(dashboard);

    // 2. Restart of the dashboard adopts the existing dashboard tab.
    const callsBefore = fake.calls.length;
    dashboard = startDashboard([...common, "--attach", "always", "--restore-grace-ms", "800"]);
    s = await waitFor(dashPort, (x) => x.launch_tab.status === "dashboard", "re-adoption");
    await sleep(400);
    assert(fake.pages.length === 1, "A dashboard restart opened another tab.");
    assert(!fake.calls.slice(callsBefore).some((call) => call.name === "browser_navigate"), "A dashboard restart re-navigated the launch tab.");
    assert(!fake.sessions.has(killedSession) && fake.sessions.size === 1, "The previous run's MCP session was not closed.");
    console.log("PASS: A restarted dashboard closes the session its predecessor left behind and adopts the existing dashboard tab without navigating or opening tabs.");

    // 3. Claims join the right tabs, survive navigation, expire, and release.
    const pageA = fake.open("http://app.test/a?secret=1", "Agent A");
    const pageB = fake.open("http://app.test/b", "Agent B");
    const claimA = claim("claude:alpha", "http://app.test/a?other=2", { task: "Read A" });
    const claimB = claim("codex:beta", "http://app.test/b", { task: "Read B" });
    writeClaims([claimA, claimB]);
    s = await waitFor(dashPort, (x) => x.tabs.filter((t) => t.claim).length === 2, "two claims bound");
    const byUrl = Object.fromEntries(s.tabs.map((t) => [t.url, t]));
    assert(byUrl["http://app.test/a"].claim.owner === "claude:alpha" && byUrl["http://app.test/b"].claim.owner === "codex:beta", `Claims bound to the wrong tabs: ${JSON.stringify(s.tabs)}`);
    assert(!JSON.stringify(s).includes("secret"), "The state exposed a URL query.");
    assert(!JSON.stringify(s).includes(claimA.claim_id), "The state exposed a claim ID.");
    pageA.url = "http://app.test/elsewhere";
    pageA.title = "Agent A moved";
    s = await waitFor(dashPort, (x) => x.tabs.some((t) => t.url === "http://app.test/elsewhere"), "navigation seen");
    assert(s.tabs.find((t) => t.url === "http://app.test/elsewhere").claim?.owner === "claude:alpha", "A claim did not follow its tab across navigation.");
    writeClaims([claimA, { ...claimB, expires_utc: new Date(Date.now() - 1000).toISOString() }]);
    s = await waitFor(dashPort, (x) => !x.tabs.find((t) => t.url === "http://app.test/b").claim, "expired claim dropped");
    assert(s.agents.length === 1 && s.agents[0].owner === "claude:alpha", "An expired claim still counted as an active agent.");
    writeClaims([]);
    s = await waitFor(dashPort, (x) => x.tabs.every((t) => !t.claim), "released claim dropped");
    writeClaims([claim("codex:gamma", "http://app.test/nowhere")]);
    s = await waitFor(dashPort, (x) => x.unmatched_claims.length === 1, "unmatched claim listed");
    writeClaims([]);
    console.log("PASS: Claims bind to the right tabs, follow navigation, drop on expiry and release, and never expose claim IDs or URL queries.");

    // 4. Auth lease state.
    fs.writeFileSync(path.join(tempRoot, "locks", "auth-flow.json"), JSON.stringify({ schema: 1, state: "held", lease_id: "f".repeat(32), owner: "codex:signin", expires_utc: new Date(Date.now() + 60000).toISOString() }));
    s = await waitFor(dashPort, (x) => x.auth_lease.state === "held", "lease held");
    assert(s.auth_lease.owner === "codex:signin" && !JSON.stringify(s).includes("f".repeat(32)), "Lease state wrong or exposed the lease ID.");
    fs.writeFileSync(path.join(tempRoot, "locks", "auth-flow.json"), JSON.stringify({ schema: 1, state: "free" }));
    await waitFor(dashPort, (x) => x.auth_lease.state === "free", "lease free");
    console.log("PASS: The dashboard reports who holds the sign-in lease and until when, without the lease ID.");

    // 5. An unclaimed, drifted launch tab is restored after the grace period.
    const launch = fake.pages[0];
    launch.url = "http://app.test/stray";
    s = await waitFor(dashPort, (x) => x.launch_tab.status === "drifted", "drift flagged");
    assert(s.launch_tab.drifted_to === "http://app.test/stray", "Drift target not reported.");
    s = await waitFor(dashPort, (x) => x.launch_tab.last_event?.kind === "restored" && x.launch_tab.status === "dashboard", "drift restored");
    assert(lib.isDashboardUrl(launch.url, `http://127.0.0.1:${dashPort}`) && fake.pages.length === 3, "Restore did not reuse the launch tab.");
    assert(pageB.url === "http://app.test/b" && pageA.url === "http://app.test/elsewhere", "Restore changed another tab.");
    console.log("PASS: An unclaimed launch tab that was navigated away is flagged, then restored after the grace period.");

    // 6. A claimed launch tab is never taken back: the dashboard moves.
    launch.url = "http://app.test/claimed";
    writeClaims([claim("claude:delta", "http://app.test/claimed")]);
    s = await waitFor(dashPort, (x) => x.launch_tab.last_event?.kind === "relocated", "relocation");
    await sleep(1200);
    assert(launch.url === "http://app.test/claimed", "The dashboard navigated a claimed tab.");
    assert(fake.pages.length === 4 && lib.isDashboardUrl(fake.pages[3].url, `http://127.0.0.1:${dashPort}`), "The dashboard did not reopen in a new tab.");
    s = await state(dashPort);
    assert(s.tabs[0].claim?.owner === "claude:delta" && s.tabs[3].is_dashboard, "The claimed tab or the new dashboard tab is not marked.");
    console.log("PASS: When an agent claims the launch tab, the dashboard leaves it alone and reopens in a new tab.");

    // 7. Closing the dashboard tab moves this session's pointer to a neighbour,
    // which must never be navigated.
    const eventBefore = (await state(dashPort)).launch_tab.last_event?.utc;
    const closedPage = fake.pages[3];
    fake.close(closedPage);
    s = await waitFor(dashPort, (x) => x.launch_tab.last_event?.utc !== eventBefore && x.tabs.length === 4 && x.tabs[3]?.is_dashboard, "dashboard reopened after close");
    assert(fake.pages.length === 4 && fake.pages[3] !== closedPage, "The dashboard did not reopen in a new tab.");
    assert(pageB.url === "http://app.test/b", "The dashboard navigated the tab its pointer fell back to.");
    console.log("PASS: When the dashboard tab is closed, the dashboard reopens in a new tab and leaves the neighbouring tab alone.");

    // 8. Service restart: sessions vanish; the dashboard reconnects and
    // re-adopts its tab without creating another.
    fake.restart();
    const before = fake.pages.length;
    await waitFor(dashPort, (x) => x.service.mcp_reachable && x.launch_tab.status === "dashboard" && fake.sessions.size === 1, "reconnect");
    await sleep(500);
    assert(fake.pages.length === before, `Reconnecting opened another tab. pages=${JSON.stringify(fake.pages)} calls=${JSON.stringify(fake.calls.slice(-8))}`);
    console.log("PASS: After a service restart the dashboard reconnects and re-adopts its tab.");

    // 9. Repeated drift pauses automatic restore.
    writeClaims([]);
    const dashPage = fake.pages[3];
    let contested = false;
    for (let round = 0; round < 5 && !contested; round++) {
      dashPage.url = `http://app.test/fight-${round}`;
      s = await waitFor(dashPort, (x) => x.launch_tab.status === "contested" || lib.isDashboardUrl(dashPage.url, `http://127.0.0.1:${dashPort}`), `restore round ${round}`);
      contested = s.launch_tab.status === "contested";
    }
    assert(contested, "Repeated drift never paused automatic restore.");
    const fightUrl = dashPage.url;
    await sleep(1200);
    assert(dashPage.url === fightUrl && !lib.isDashboardUrl(fightUrl, `http://127.0.0.1:${dashPort}`), "Restore was not paused after repeated drift.");
    console.log("PASS: Repeated drift pauses automatic restore and flags the launch tab as contested.");

    // 10. HTTP surface.
    const forbidden = await get(dashPort, "/api/state", "attacker.example");
    assert(forbidden.status === 403, "A non-loopback Host header was served.");
    const page = await get(dashPort, "/");
    assert(page.status === 200 && page.body.includes("Agents: do not select, navigate, or close this tab."), "The page lacks the launch-tab banner.");
    assert(!/<(script|link|img)[^>]+(src|href)=/i.test(page.body), "The page loads an external asset.");
    assert(page.headers["content-security-policy"]?.includes("default-src 'none'"), "The page lacks a restrictive content security policy.");
    console.log("PASS: The page is self-contained, labelled for agents, and refused to non-loopback Host headers.");

    await stopChild(dashboard);
  } finally {
    mcpServer.close();
  }
} finally {
  for (const child of children) await stopChild(child).catch(() => {});
  await rm(tempRoot, { recursive: true, force: true });
}
