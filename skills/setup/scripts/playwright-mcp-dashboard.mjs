#!/usr/bin/env node
// Live dashboard for the shared Playwright MCP service.
//
// A dependency-free, loopback-only HTTP server that:
//   - acts as one more MCP client of the shared service and lists its tabs on
//     an interval (it never selects, navigates, or closes another client's
//     tab);
//   - shows the dashboard itself in the browser's launch tab, in place of the
//     blank page the browser opens at launch;
//   - joins the live tab list with the tab-claim registry and the
//     authentication lease, and serves the result as one self-contained page
//     plus a JSON endpoint.
//
// It reads the claim registry and the lease; it never writes either.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = Object.freeze({
  mcpPort: 8931,
  port: 8932,
  pollMs: 5000,
  restoreGraceMs: 30000,
  attach: "when-running",
  maxRestores: 3,
  restoreWindowMs: 15 * 60 * 1000,
  failuresBeforeReconnect: 3,
});

const CLIENT_NAME = "shared-browser-dashboard";
export const PAGE_TITLE = "Shared browser - launch tab";
export const BANNER =
  "Shared Playwright browser - launch tab. Agents: do not select, navigate, or close this tab.";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Reduce a URL to scheme, host, and path. Query strings and fragments can
// carry tokens, so they are never stored, compared, or displayed.
export function redactUrl(value) {
  if (typeof value !== "string" || value === "") return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:")
      return `${url.protocol}//${url.host}${url.pathname}`;
    return `${url.protocol}${url.pathname}`;
  } catch {
    return value.split(/[?#]/)[0];
  }
}

// Parse the markdown tab list returned by the browser_tabs tool:
//   - 0: (current) [Title](https://example/path) [crashed]
export function parseTabList(text) {
  const tabs = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^- (\d+):( \(current\))? \[(.*)\]\((\S*)\)( \[crashed\])?$/);
    if (!match) continue;
    tabs.push({
      index: Number(match[1]),
      current: Boolean(match[2]),
      title: match[3],
      url: match[4],
      crashed: Boolean(match[5]),
    });
  }
  return tabs;
}

// Carry stable tab IDs from one poll to the next. Pages are only ever
// appended to the list; any page may close. So the new list is the previous
// list with some entries removed (each surviving entry possibly navigated),
// followed by newly opened tabs. Choose the alignment that keeps the most
// entries whose URL did not change, preferring to keep entries over removing
// them on a tie.
export function alignTabs(previous, next, allocateId) {
  const p = previous.length;
  const n = next.length;
  // best[i][j]: best [matches, kept] aligning previous[i..] with next[j..]
  // where next[j..] tail beyond the kept entries is all new tabs.
  const best = Array.from({ length: p + 1 }, () => new Array(n + 1));
  for (let j = 0; j <= n; j++) best[p][j] = [0, 0];
  for (let i = p - 1; i >= 0; i--) {
    for (let j = n; j >= 0; j--) {
      let choice = best[i + 1][j]; // previous[i] closed
      if (j < n) {
        const pair = best[i + 1][j + 1];
        const same = redactUrl(previous[i].url) === redactUrl(next[j].url) ? 1 : 0;
        const keep = [pair[0] + same, pair[1] + 1];
        if (keep[0] > choice[0] || (keep[0] === choice[0] && keep[1] >= choice[1])) choice = keep;
      }
      best[i][j] = choice;
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < p && j < n) {
    const pair = best[i + 1][j + 1];
    const same = redactUrl(previous[i].url) === redactUrl(next[j].url) ? 1 : 0;
    const keep = [pair[0] + same, pair[1] + 1];
    const drop = best[i + 1][j];
    if (keep[0] > drop[0] || (keep[0] === drop[0] && keep[1] >= drop[1])) {
      result.push({ ...next[j], id: previous[i].id });
      i++;
      j++;
    } else {
      i++;
    }
  }
  for (; j < n; j++) result.push({ ...next[j], id: allocateId() });
  return result;
}

export function isActive(entry, now = Date.now()) {
  const expires = Date.parse(entry?.expires_utc || "");
  return Number.isFinite(expires) && expires > now;
}

// Bind each active claim to one tab. A binding follows its tab by ID across
// navigations; an unbound claim binds to the newest unbound tab whose
// redacted URL equals the URL the claim recorded.
export function bindClaims(claims, tabs, bindings, isDashboardTab) {
  const liveIds = new Set(tabs.map((tab) => tab.id));
  const activeIds = new Set(claims.map((claim) => claim.claim_id));
  for (const [claimId, tabId] of [...bindings]) {
    if (!activeIds.has(claimId) || !liveIds.has(tabId)) bindings.delete(claimId);
  }
  const taken = new Set(bindings.values());
  const ordered = [...claims].sort((a, b) =>
    String(a.claimed_utc).localeCompare(String(b.claimed_utc)),
  );
  for (const claim of ordered) {
    if (bindings.has(claim.claim_id)) continue;
    const want = redactUrl(claim.url);
    if (!want) continue;
    const candidates = tabs.filter(
      (tab) => !taken.has(tab.id) && !isDashboardTab(tab) && redactUrl(tab.url) === want,
    );
    if (!candidates.length) continue;
    const chosen = candidates[candidates.length - 1];
    bindings.set(claim.claim_id, chosen.id);
    taken.add(chosen.id);
  }
  return bindings;
}

export function isDashboardUrl(url, dashboardOrigin) {
  return typeof url === "string" && (url === dashboardOrigin || url.startsWith(`${dashboardOrigin}/`));
}

// ---------------------------------------------------------------------------
// Files: claim registry, lease, PID file
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The PowerShell helpers hold the state file with an exclusive handle while
// they read-modify-write it; retry briefly on a sharing violation.
export function readJsonFile(file) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
      if (!raw.trim()) return { ok: true, value: null };
      return { ok: true, value: JSON.parse(raw) };
    } catch (error) {
      if (error.code === "ENOENT") return { ok: true, value: null };
      if (error instanceof SyntaxError || ["EBUSY", "EPERM", "EACCES"].includes(error.code)) {
        sleepSync(40);
        continue;
      }
      return { ok: false, error: error.code || error.message };
    }
  }
  return { ok: false, error: "busy" };
}

export function readClaims(runtimeRoot, now = Date.now()) {
  const result = readJsonFile(path.join(runtimeRoot, "locks", "tab-claims.json"));
  if (!result.ok) return { ok: false, claims: [] };
  const list = Array.isArray(result.value?.claims) ? result.value.claims : [];
  return {
    ok: true,
    claims: list
      .filter((claim) => claim && typeof claim.claim_id === "string" && isActive(claim, now))
      .map((claim) => ({
        claim_id: claim.claim_id,
        owner: String(claim.owner || ""),
        task: String(claim.task || ""),
        url: redactUrl(String(claim.url || "")),
        claimed_utc: String(claim.claimed_utc || ""),
        renewed_utc: String(claim.renewed_utc || claim.claimed_utc || ""),
        expires_utc: String(claim.expires_utc || ""),
      })),
  };
}

export function readLease(runtimeRoot, now = Date.now()) {
  const result = readJsonFile(path.join(runtimeRoot, "locks", "auth-flow.json"));
  if (!result.ok) return { state: "unknown" };
  const lease = result.value;
  if (lease && lease.state === "held" && isActive(lease, now))
    return { state: "held", owner: String(lease.owner || ""), expires_utc: String(lease.expires_utc) };
  return { state: "free" };
}

// Whether a browser currently owns the profile. Chrome holds `lockfile`
// open exclusively on Windows and keeps a `SingletonLock` link elsewhere.
export function browserRunning(profile) {
  if (!profile) return null;
  if (process.platform === "win32") {
    const lockfile = path.join(profile, "lockfile");
    try {
      const fd = fs.openSync(lockfile, "r+");
      fs.closeSync(fd);
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      return ["EBUSY", "EPERM", "EACCES"].includes(error.code);
    }
  }
  try {
    const target = fs.readlinkSync(path.join(profile, "SingletonLock"));
    const pid = Number(String(target).split("-").pop());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  } catch {
    return false;
  }
}

function packageVersion(cli) {
  if (!cli) return null;
  const result = readJsonFile(path.join(path.dirname(cli), "package.json"));
  return result.ok && typeof result.value?.version === "string" ? result.value.version : null;
}

function fileAgeSeconds(file) {
  if (!file) return null;
  try {
    return Math.max(0, Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal streamable-HTTP MCP client
// ---------------------------------------------------------------------------

export class McpSession {
  constructor(port, timeoutMs = 60000) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.nextId = 1;
    this.serverInfo = null;
  }

  request(method, body) {
    return new Promise((resolve, reject) => {
      const headers = {
        // The service only answers requests addressed to localhost.
        host: `localhost:${this.port}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const req = http.request(
        { host: "127.0.0.1", port: this.port, path: "/mcp", method, headers, timeout: this.timeoutMs },
        (res) => {
          const assigned = res.headers["mcp-session-id"];
          if (assigned) this.sessionId = String(assigned);
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), body: data }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("MCP request timed out")));
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async rpc(message) {
    const response = await this.request("POST", message);
    if (response.status === 202) return null;
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`MCP HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const json = response.type.includes("text/event-stream")
      ? response.body
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : response.body;
    const payload = JSON.parse(json);
    if (payload.error) throw new Error(`MCP error ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  async initialize() {
    this.sessionId = null;
    const result = await this.rpc({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
      },
    });
    this.serverInfo = result?.serverInfo || null;
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async callTool(name, args) {
    const result = await this.rpc({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const text = (result?.content || [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return { text, isError: Boolean(result?.isError) };
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.request("DELETE");
    } catch {
      // The service may already be gone.
    }
    this.sessionId = null;
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export class Dashboard {
  constructor(options) {
    this.options = { ...DEFAULTS, ...options };
    this.origin = `http://127.0.0.1:${this.options.port}`;
    this.dashboardUrl = `${this.origin}/`;
    this.startedAt = Date.now();
    this.packageVersion = packageVersion(this.options.mcpCli);
    this.session = null;
    this.tabs = [];
    this.nextTabId = 1;
    this.bindings = new Map();
    this.dashTabId = null;
    this.failures = 0;
    this.blankSeenAt = null;
    this.blankTabId = null;
    this.mcp = { reachable: false, version: null, error: null };
    this.browser = { attached: false, running: null };
    this.launch = { status: "detached", detail: "", drifted_since_utc: null, drifted_to: null, restores: [], last_restore_utc: null, last_event: null };
    // A dashboard that was killed cannot close its MCP session, and the
    // service keeps idle sessions forever. Remember the session so the next
    // run can close it.
    this.sessionFile = path.join(this.options.runtimeRoot, "state", "dashboard-session.json");
    this.staleSessionId = this.readStaleSession();
    this.claims = [];
    this.lease = { state: "unknown" };
    this.lastPollUtc = null;
    this.listeners = new Set();
    this.timer = null;
    this.stopped = false;
  }

  allocateId() {
    return this.nextTabId++;
  }

  readStaleSession() {
    const result = readJsonFile(this.sessionFile);
    const value = result.ok ? result.value : null;
    return value && value.mcp_port === this.options.mcpPort && typeof value.session_id === "string" ? value.session_id : null;
  }

  rememberSession(sessionId) {
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      const temp = `${this.sessionFile}.tmp`;
      if (sessionId) {
        fs.writeFileSync(temp, JSON.stringify({ mcp_port: this.options.mcpPort, session_id: sessionId }));
        fs.renameSync(temp, this.sessionFile);
      } else {
        fs.rmSync(this.sessionFile, { force: true });
      }
    } catch {
      // Cleanup of a stale session is best effort.
    }
  }

  async closeStaleSession() {
    if (!this.staleSessionId) return;
    const stale = new McpSession(this.options.mcpPort, 5000);
    stale.sessionId = this.staleSessionId;
    this.staleSessionId = null;
    await stale.close();
  }

  event(kind, detail) {
    this.launch.last_event = { kind, utc: new Date().toISOString(), detail };
  }

  // A tab showing the dashboard is never bound to a claim. A launch tab that
  // was navigated elsewhere can be, so an agent's claim on it is honoured.
  showsDashboard(tab) {
    return isDashboardUrl(tab.url, this.origin);
  }

  async resetSession(deleteSession) {
    const session = this.session;
    this.session = null;
    this.tabs = [];
    this.dashTabId = null;
    this.blankSeenAt = null;
    this.bindings.clear();
    this.browser.attached = false;
    if (session && deleteSession) await session.close();
  }

  async list() {
    const { text, isError } = await this.session.callTool("browser_tabs", { action: "list" });
    if (isError) throw new Error(text.replace(/\s+/g, " ").slice(0, 200));
    const parsed = parseTabList(text);
    this.tabs = alignTabs(this.tabs, parsed, () => this.allocateId());
    return this.tabs;
  }

  claimedTabIds() {
    return new Set(this.bindings.values());
  }

  async openOwnDashboardTab(reason) {
    await this.session.callTool("browser_tabs", { action: "new", url: this.dashboardUrl });
    await this.list();
    const current = this.tabs.find((tab) => tab.current);
    this.dashTabId = current && isDashboardUrl(current.url, this.origin) ? current.id : null;
    this.setHealthy("");
    this.event("relocated", reason);
  }

  // First poll of a new session: the session's current tab is the first
  // page of the shared context, which is the browser's launch tab.
  async establishLaunchTab() {
    const current = this.tabs.find((tab) => tab.current);
    if (current && isDashboardUrl(current.url, this.origin)) {
      this.dashTabId = current.id;
      this.setHealthy(current.index === 0 ? "" : "The dashboard is not in the first tab.");
      return;
    }
    const existing = this.tabs.find((tab) => isDashboardUrl(tab.url, this.origin));
    if (existing) {
      await this.session.callTool("browser_tabs", { action: "select", index: existing.index });
      await this.list();
      this.dashTabId = existing.id;
      this.setHealthy(existing.index === 0 ? "" : "The dashboard is not in the first tab.");
      return;
    }
    if (current && current.index === 0 && current.url === "about:blank" && !this.claimedTabIds().has(current.id)) {
      // A tab another client just opened is blank only for a moment, so
      // require the blank launch tab on two consecutive polls.
      if (this.blankSeenAt === null || this.blankTabId !== current.id) {
        this.blankSeenAt = Date.now();
        this.blankTabId = current.id;
        this.launch.status = "blank";
        this.launch.detail = "Waiting to confirm the blank launch tab.";
        return;
      }
      await this.session.callTool("browser_navigate", { url: this.dashboardUrl });
      await this.list();
      const now = this.tabs.find((tab) => tab.current);
      if (now && isDashboardUrl(now.url, this.origin)) {
        this.dashTabId = now.id;
        this.setHealthy("");
      }
      return;
    }
    if (this.tabs.length === 0) return;
    await this.openOwnDashboardTab("The first tab already held a page, so the dashboard opened in a new tab.");
  }

  setHealthy(detail) {
    this.launch.status = "dashboard";
    this.launch.detail = detail;
    this.launch.drifted_since_utc = null;
    this.launch.drifted_to = null;
  }

  recentRestores(now) {
    this.launch.restores = this.launch.restores.filter((at) => now - at < this.options.restoreWindowMs);
    return this.launch.restores.length;
  }

  async checkLaunchTab() {
    const dash = this.tabs.find((tab) => tab.id === this.dashTabId);
    if (!dash) {
      // The dashboard's tab closed; this session's pointer moved to some
      // other tab, which must not be touched.
      const existing = this.tabs.find((tab) => isDashboardUrl(tab.url, this.origin));
      if (existing) {
        await this.session.callTool("browser_tabs", { action: "select", index: existing.index });
        await this.list();
        this.dashTabId = existing.id;
        this.setHealthy("");
        this.event("readopted", "The dashboard tab was closed; another dashboard tab was adopted.");
        return;
      }
      if (this.tabs.length === 0) return;
      await this.openOwnDashboardTab("The launch tab was closed, so the dashboard reopened in a new tab.");
      return;
    }
    if (!dash.current) {
      this.launch.status = "uncertain";
      this.launch.detail = "The dashboard lost track of its own tab; no tab is changed.";
      return;
    }
    if (isDashboardUrl(dash.url, this.origin)) {
      if (this.launch.status !== "dashboard") this.setHealthy("");
      return;
    }

    // The launch tab was navigated away from the dashboard.
    const now = Date.now();
    if (!this.launch.drifted_since_utc) this.launch.drifted_since_utc = new Date(now).toISOString();
    this.launch.drifted_to = redactUrl(dash.url);
    if (this.claimedTabIds().has(dash.id)) {
      // An agent registered a claim on this page; never take it back.
      await this.openOwnDashboardTab("An agent claimed the launch tab, so the dashboard moved to a new tab.");
      return;
    }
    const since = Date.parse(this.launch.drifted_since_utc);
    if (this.recentRestores(now) >= this.options.maxRestores) {
      this.launch.status = "contested";
      this.launch.detail = "The launch tab keeps being navigated away; automatic restore is paused.";
      return;
    }
    if (now - since < this.options.restoreGraceMs) {
      this.launch.status = "drifted";
      this.launch.detail = "The launch tab was navigated away and will be restored if it stays unclaimed.";
      return;
    }
    // Confirm on a fresh list right before restoring.
    await this.list();
    const again = this.tabs.find((tab) => tab.id === this.dashTabId);
    if (!again || !again.current || isDashboardUrl(again.url, this.origin)) return;
    bindClaims(this.claims, this.tabs, this.bindings, (tab) => this.showsDashboard(tab));
    if (this.claimedTabIds().has(again.id)) return;
    await this.session.callTool("browser_navigate", { url: this.dashboardUrl });
    await this.list();
    this.launch.restores.push(Date.now());
    this.launch.last_restore_utc = new Date().toISOString();
    const restored = this.tabs.find((tab) => tab.id === this.dashTabId);
    if (restored && isDashboardUrl(restored.url, this.origin)) {
      const target = this.launch.drifted_to || "another page";
      this.setHealthy("");
      this.event("restored", `The unclaimed launch tab had been navigated to ${target}; the dashboard was restored.`);
    }
  }

  async tick() {
    const now = Date.now();
    const claimRead = readClaims(this.options.runtimeRoot, now);
    if (claimRead.ok) this.claims = claimRead.claims;
    this.lease = readLease(this.options.runtimeRoot, now);
    this.lastPollUtc = new Date(now).toISOString();

    if (!this.session) {
      const running = browserRunning(this.options.profile);
      this.browser.running = running;
      if (this.options.attach === "when-running" && running === false) {
        // No browser, so a stale session holds nothing open; close it now.
        await this.closeStaleSession();
        this.launch.status = "detached";
        this.launch.detail = "The browser is not running. The dashboard attaches when an agent starts it.";
        this.tabs = [];
        this.mcp.reachable = await this.probeMcp();
        return;
      }
      const session = new McpSession(this.options.mcpPort);
      try {
        await session.initialize();
      } catch (error) {
        this.mcp = { reachable: false, version: null, error: String(error.message || error).slice(0, 200) };
        this.launch.status = "detached";
        this.launch.detail = "The shared service is not answering.";
        return;
      }
      this.session = session;
      this.rememberSession(session.sessionId);
      // Close the previous run's session only after this one is open, so the
      // service never sees zero clients and closes the browser in between.
      await this.closeStaleSession();
      this.mcp = { reachable: true, version: session.serverInfo?.version || null, error: null };
      this.browser.attached = true;
      this.failures = 0;
    }

    try {
      await this.list();
      this.failures = 0;
      this.mcp.error = null;
      this.browser.running = true;
    } catch (error) {
      this.failures++;
      this.mcp.error = String(error.message || error).slice(0, 200);
      const gone = error.status === 404 || /closed|disconnected|ECONNREFUSED|ECONNRESET/i.test(this.mcp.error);
      if (error.status === 404 || this.failures >= this.options.failuresBeforeReconnect || gone) {
        await this.resetSession(error.status !== 404);
        this.launch.status = "detached";
        this.launch.detail = "Reconnecting to the shared service.";
      }
      return;
    }

    bindClaims(this.claims, this.tabs, this.bindings, (tab) => this.showsDashboard(tab));
    try {
      if (this.dashTabId === null) await this.establishLaunchTab();
      else await this.checkLaunchTab();
    } catch (error) {
      this.mcp.error = String(error.message || error).slice(0, 200);
    }
    bindClaims(this.claims, this.tabs, this.bindings, (tab) => this.showsDashboard(tab));
  }

  async probeMcp() {
    return await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: this.options.mcpPort, path: "/mcp", method: "GET", timeout: 2000, headers: { host: `localhost:${this.options.mcpPort}` } },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
      req.end();
    });
  }

  snapshot() {
    const now = Date.now();
    const claimById = new Map(this.claims.map((claim) => [claim.claim_id, claim]));
    const claimByTab = new Map();
    for (const [claimId, tabId] of this.bindings) {
      const claim = claimById.get(claimId);
      if (claim) claimByTab.set(tabId, claim);
    }
    const publicClaim = (claim) => ({
      owner: claim.owner,
      task: claim.task,
      url: claim.url,
      claimed_utc: claim.claimed_utc,
      renewed_utc: claim.renewed_utc,
      expires_utc: claim.expires_utc,
      age_seconds: Math.max(0, Math.round((now - Date.parse(claim.claimed_utc)) / 1000)) || 0,
    });
    const tabs = this.tabs.map((tab) => {
      const claim = claimByTab.get(tab.id);
      return {
        id: tab.id,
        index: tab.index,
        title: tab.title,
        url: redactUrl(tab.url),
        crashed: tab.crashed,
        is_dashboard: tab.id === this.dashTabId,
        claim: claim ? publicClaim(claim) : null,
      };
    });
    const bound = new Set(this.bindings.keys());
    const owners = new Map();
    for (const claim of this.claims) owners.set(claim.owner, (owners.get(claim.owner) || 0) + 1);
    return {
      schema: 1,
      generated_utc: new Date(now).toISOString(),
      service: {
        mcp_port: this.options.mcpPort,
        mcp_endpoint: `http://localhost:${this.options.mcpPort}/mcp`,
        mcp_reachable: this.mcp.reachable,
        mcp_package_version: this.packageVersion,
        playwright_version: this.mcp.version,
        mcp_uptime_seconds: fileAgeSeconds(this.options.nodePidFile),
        dashboard_port: this.options.port,
        dashboard_url: this.dashboardUrl,
        dashboard_uptime_seconds: Math.round((now - this.startedAt) / 1000),
        poll_ms: this.options.pollMs,
        attach: this.options.attach,
        last_poll_utc: this.lastPollUtc,
        last_error: this.mcp.error,
      },
      browser: { attached: this.browser.attached, running: this.browser.running },
      launch_tab: {
        status: this.launch.status,
        detail: this.launch.detail,
        index: tabs.find((tab) => tab.is_dashboard)?.index ?? null,
        drifted_since_utc: this.launch.drifted_since_utc,
        drifted_to: this.launch.drifted_to,
        restores_recent: this.launch.restores.length,
        last_restore_utc: this.launch.last_restore_utc,
        last_event: this.launch.last_event,
      },
      agents: [...owners].map(([owner, claims]) => ({ owner, claims })),
      tabs,
      unmatched_claims: this.claims.filter((claim) => !bound.has(claim.claim_id)).map(publicClaim),
      auth_lease: this.lease,
    };
  }

  publish() {
    const payload = `event: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const res of this.listeners) res.write(payload);
  }

  async loop() {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (error) {
      this.mcp.error = String(error.message || error).slice(0, 200);
    }
    this.publish();
    if (!this.stopped) this.timer = setTimeout(() => this.loop(), this.options.pollMs);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const res of this.listeners) res.end();
    this.listeners.clear();
    if (this.session) {
      await this.session.close();
      this.rememberSession(null);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createHttpServer(dashboard) {
  const port = dashboard.options.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return http.createServer((req, res) => {
    // Refuse any Host but loopback so a web page cannot read this state
    // through DNS rebinding.
    if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Forbidden host");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", ...SECURITY_HEADERS });
      res.end();
      return;
    }
    const url = new URL(req.url, dashboard.origin);
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
      res.end(req.method === "HEAD" ? undefined : renderPage(dashboard.snapshot()));
      return;
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(dashboard.snapshot()));
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", ...SECURITY_HEADERS });
      res.write(`retry: 5000\nevent: state\ndata: ${JSON.stringify(dashboard.snapshot())}\n\n`);
      dashboard.listeners.add(res);
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        dashboard.listeners.delete(res);
      });
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Not found");
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The page is fully self-contained: inline style and script, no external
// assets. It renders the embedded state at once and then follows one
// server-sent event stream, so polling adds no new requests to the tab.
export function renderPage(state) {
  const initial = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(PAGE_TITLE)}</title>
<style>
:root { --bg:#f7f7f5; --panel:#ffffff; --text:#1d1d1b; --muted:#66655f; --line:#e2e1dc; --accent:#2f5d9e; --ok:#2e7d4f; --warn:#a15c00; --bad:#b3261e; --chip:#eef1f6; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --panel:#1f1f1d; --text:#ecebe6; --muted:#a3a29b; --line:#33332f; --accent:#8fb3ea; --ok:#7cc79a; --warn:#e0a85a; --bad:#f08b84; --chip:#2a2f38; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:16px 20px; border-bottom:1px solid var(--line); background:var(--panel); }
header h1 { margin:0; font-size:18px; }
header p { margin:4px 0 0; color:var(--muted); }
.banner { margin:0; padding:10px 20px; background:var(--accent); color:var(--panel); font-weight:600; }
main { padding:16px 20px; display:grid; gap:16px; max-width:1200px; }
section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 16px; overflow-x:auto; }
h2 { font-size:14px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }
th { border-top:none; color:var(--muted); font-weight:600; }
td.url { font-family:ui-monospace, Consolas, monospace; font-size:12px; word-break:break-all; }
.chip { display:inline-block; padding:1px 8px; border-radius:999px; background:var(--chip); font-size:12px; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .muted { color:var(--muted); }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:8px 16px; }
.kv span { color:var(--muted); }
</style>
</head>
<body>
<p class="banner">${escapeHtml(BANNER)}</p>
<header>
<h1>${escapeHtml(PAGE_TITLE)}</h1>
<p>Which agents are active and which tab each is using. Updates live; nothing here changes the browser.</p>
</header>
<main>
<section id="launch"></section>
<section><h2>Tabs</h2><table><thead><tr><th>#</th><th>Title</th><th>URL</th><th>Claim</th></tr></thead><tbody id="tabs"></tbody></table></section>
<section id="unmatched"></section>
<section><h2>Sign-in lease</h2><div id="lease"></div></section>
<section><h2>Service</h2><div id="service" class="grid"></div></section>
</main>
<script>
const initial = ${initial};
let state = initial;
let receivedAt = Date.now();
const el = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? "")));
  return node;
};
const duration = (seconds) => {
  if (seconds == null || !isFinite(seconds)) return "-";
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
};
const until = (iso) => duration((Date.parse(iso) - Date.now()) / 1000);
const since = (iso) => duration((Date.now() - Date.parse(iso)) / 1000);
const claimCell = (claim) => claim
  ? el("div", {}, el("strong", {}, claim.owner), claim.task ? el("div", {}, claim.task) : "",
      el("div", { class: "muted" }, "claimed " + since(claim.claimed_utc) + " ago, expires in " + until(claim.expires_utc)))
  : el("span", { class: "muted" }, "unclaimed");
function render() {
  const s = state;
  const launch = document.getElementById("launch");
  const statusClass = { dashboard: "ok", blank: "muted", drifted: "bad", contested: "bad", uncertain: "warn", detached: "muted" }[s.launch_tab.status] || "muted";
  const lastEvent = s.launch_tab.last_event;
  launch.replaceChildren(el("h2", {}, "Launch tab"),
    el("div", {}, el("span", { class: "chip " + statusClass }, s.launch_tab.status), " ", s.launch_tab.detail || ""),
    s.launch_tab.drifted_to ? el("div", { class: "bad" }, "Navigated to " + s.launch_tab.drifted_to + (s.launch_tab.drifted_since_utc ? " (" + since(s.launch_tab.drifted_since_utc) + " ago)" : "")) : "",
    lastEvent ? el("div", { class: "warn" }, since(lastEvent.utc) + " ago: " + lastEvent.detail) : "");
  const body = document.getElementById("tabs");
  if (!s.tabs.length) body.replaceChildren(el("tr", {}, el("td", { colspan: "4", class: "muted" }, s.browser.attached ? "No tabs." : "The browser is not running.")));
  else body.replaceChildren(...s.tabs.map((tab) => el("tr", {},
    el("td", {}, String(tab.index)),
    el("td", {}, tab.title || "(untitled)", tab.crashed ? el("span", { class: "bad" }, " crashed") : ""),
    el("td", { class: "url" }, tab.url),
    el("td", {}, tab.is_dashboard ? el("span", { class: "chip" }, "this dashboard - launch tab") : claimCell(tab.claim)))));
  const unmatched = document.getElementById("unmatched");
  unmatched.replaceChildren(el("h2", {}, "Claims without a matching tab"),
    s.unmatched_claims.length ? el("table", {}, el("tbody", {}, ...s.unmatched_claims.map((claim) => el("tr", {},
      el("td", {}, claimCell(claim)), el("td", { class: "url" }, claim.url))))) : el("div", { class: "muted" }, "None."));
  const lease = s.auth_lease;
  document.getElementById("lease").replaceChildren(lease.state === "held"
    ? el("div", {}, el("span", { class: "chip warn" }, "held"), " by ", el("strong", {}, lease.owner), ", expires in " + until(lease.expires_utc))
    : el("div", {}, el("span", { class: "chip ok" }, lease.state), lease.state === "free" ? " - no sign-in flow is in progress" : ""));
  const sv = s.service;
  const kv = (label, value) => el("div", { class: "kv" }, el("span", {}, label + ": "), value);
  const live = (Date.now() - receivedAt) / 1000;
  document.getElementById("service").replaceChildren(
    kv("MCP endpoint", sv.mcp_endpoint),
    kv("MCP", sv.mcp_reachable ? "answering" : "not answering"),
    kv("Versions", "@playwright/mcp " + (sv.mcp_package_version || "?") + ", Playwright " + (sv.playwright_version || "?")),
    kv("MCP uptime", duration(sv.mcp_uptime_seconds == null ? null : sv.mcp_uptime_seconds + live)),
    kv("Browser", s.browser.attached ? "attached" : (s.browser.running === false ? "not running" : "not attached")),
    kv("Dashboard", sv.dashboard_url + " (up " + duration(sv.dashboard_uptime_seconds + live) + ")"),
    kv("Last poll", sv.last_poll_utc ? since(sv.last_poll_utc) + " ago" : "-"),
    sv.last_error ? kv("Last error", el("span", { class: "warn" }, sv.last_error)) : "");
}
render();
setInterval(render, 1000);
if (window.EventSource) {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => { state = JSON.parse(event.data); receivedAt = Date.now(); render(); });
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultRuntimeRoot() {
  const override = process.env.PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT;
  if (override) return path.resolve(override);
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "playwright-mcp-shared");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "playwright-mcp-shared");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "playwright-mcp-shared");
}

function intOption(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}

export function parseOptions(argv, env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unexpected argument: ${argv[i]}`);
    args[match[1]] = match[2] !== undefined ? match[2] : argv[++i];
  }
  const runtimeRoot = path.resolve(args["runtime-root"] || defaultRuntimeRoot());
  const options = {
    runtimeRoot,
    mcpPort: intOption(args["mcp-port"] ?? env.PLAYWRIGHT_MCP_SHARED_PORT ?? DEFAULTS.mcpPort, "--mcp-port", 1024, 65535),
    port: intOption(args.port ?? env.PLAYWRIGHT_MCP_SHARED_DASHBOARD_PORT ?? DEFAULTS.port, "--port", 1024, 65535),
    profile: path.resolve(args.profile || env.PLAYWRIGHT_MCP_SHARED_PROFILE || path.join(runtimeRoot, "profiles", "shared")),
    nodePidFile: args["node-pid-file"] ? path.resolve(args["node-pid-file"]) : null,
    mcpCli: args["mcp-cli"] ? path.resolve(args["mcp-cli"]) : path.join(runtimeRoot, "package", "node_modules", "@playwright", "mcp", "cli.js"),
    pollMs: intOption(args["poll-ms"] ?? env.PLAYWRIGHT_MCP_SHARED_DASHBOARD_POLL_MS ?? DEFAULTS.pollMs, "--poll-ms", 100, 600000),
    restoreGraceMs: intOption(args["restore-grace-ms"] ?? env.PLAYWRIGHT_MCP_SHARED_DASHBOARD_RESTORE_GRACE_MS ?? DEFAULTS.restoreGraceMs, "--restore-grace-ms", 0, 86400000),
    attach: args.attach || env.PLAYWRIGHT_MCP_SHARED_DASHBOARD_ATTACH || DEFAULTS.attach,
  };
  if (!["when-running", "always"].includes(options.attach))
    throw new Error("--attach must be when-running or always.");
  if (options.port === options.mcpPort) throw new Error("--port must differ from --mcp-port.");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`Shared browser dashboard: ${error.message}`);
    return 64;
  }
  const dashboard = new Dashboard(options);
  const server = createHttpServer(dashboard);
  const listening = await new Promise((resolve) => {
    server.once("error", (error) => {
      console.error(`Shared browser dashboard could not listen on 127.0.0.1:${options.port}: ${error.code || error.message}`);
      resolve(false);
    });
    server.listen(options.port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return 75;
  console.error(`Shared browser dashboard listening on ${dashboard.dashboardUrl}`);
  const shutdown = async () => {
    await dashboard.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  void dashboard.loop();
  return null;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await main();
  if (code !== null) process.exit(code);
}

export const SCRIPT_PATH = fileURLToPath(import.meta.url);
