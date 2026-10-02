import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("The Playwright authentication health check requires Windows.");
  process.exit(2);
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function target(raw) {
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Health-check targets must be credential-free HTTP(S) URLs.");
  return parsed;
}

const endpoint = option("endpoint") || "http://localhost:8931/mcp";
const runtimeRoot =
  option("runtime-root") || path.join(process.env.LOCALAPPDATA, "playwright-mcp-shared");
const specPath = option("spec");
if (!specPath) throw new Error("Pass a service-neutral probe specification with --spec=<path>.");
const spec = JSON.parse(await readFile(specPath, "utf8"));
if (!Array.isArray(spec.probes) || !spec.probes.length)
  throw new Error("The health specification requires at least one probe.");
const probes = spec.probes.map((probe) => {
  if (!probe || typeof probe !== "object") throw new Error("Each probe must be an object.");
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(probe.name || ""))
    throw new Error("Probe names use letters, digits, period, underscore, colon, or hyphen.");
  const url = target(probe.url);
  const expectedHosts = Array.isArray(probe.expectedHosts)
    ? probe.expectedHosts.map((value) => String(value).toLowerCase())
    : [url.hostname.toLowerCase()];
  const allowedSignals = new Set([
    "accessDenied",
    "identityMismatch",
    "authenticationRequired",
    "authenticationPrompt",
  ]);
  const forbidSignals = Array.isArray(probe.forbidSignals) ? probe.forbidSignals : [];
  if (forbidSignals.some((value) => !allowedSignals.has(value)))
    throw new Error(`Probe ${probe.name} contains an unknown forbidden signal.`);
  return {
    name: probe.name,
    url,
    expectedHosts,
    forbidSignals,
    requireNonEmptyJsonObject: probe.requireNonEmptyJsonObject === true,
  };
});
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const leaseScript = path.join(scriptDir, "playwright-auth-lease.ps1");
const leaseOwner = `health-check-${process.pid}`;
let leaseId;
let client;
let claimed = false;

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
      runtimeRoot,
      ...args,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    throw new Error("Authentication lease returned invalid output.");
  }
  return { code: result.status, payload };
}

class HttpMcpClient {
  constructor(url) {
    this.endpoint = url;
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
    const assigned = response.headers.get("mcp-session-id");
    if (assigned) this.sessionId = assigned;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    if (response.status === 202) return null;
    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let payload;
    if (contentType.includes("text/event-stream")) {
      const data = body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (!data.length) throw new Error("Empty MCP event-stream response.");
      payload = JSON.parse(data.join(""));
    } else {
      payload = JSON.parse(body);
    }
    if (payload.error) throw new Error(`MCP error ${payload.error.code}`);
    return payload.result;
  }

  async initialize() {
    await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "playwright-auth-health", version: "1.0.0" },
        },
      },
      480,
    );
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
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

function evaluation(result) {
  const text = resultText(result);
  const section = text.match(/### Result\s*\r?\n([\s\S]*?)(?:\r?\n###|$)/)?.[1] || text;
  const start = section.indexOf("{");
  const end = section.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Health evaluation was not structured JSON.");
  return JSON.parse(section.slice(start, end + 1));
}

async function inspectCurrent(probe) {
  const result = await client.callTool("browser_evaluate", {
    function: `() => {
      const text = (document.body?.innerText || "").toLowerCase();
      let nonEmptyJsonObject = false;
      try {
        const parsed = JSON.parse(document.body?.innerText || "");
        nonEmptyJsonObject = Boolean(parsed && typeof parsed === "object" && Object.keys(parsed).length);
      } catch {}
      return {
        finalHost: location.hostname.toLowerCase(),
        accessDenied: /access[ -]denied/.test(text) || location.pathname.toLowerCase().includes("access-denied"),
        identityMismatch: /(?:email|account|identity|user|tenant).{0,160}(?:does not match|doesn't match|do not match|mismatch|different|conflict)/i.test(text) ||
          /(?:does not match|doesn't match|do not match|mismatch|conflict).{0,160}(?:email|account|identity|user|tenant)/i.test(text),
        authenticationRequired: /authentication required/.test(text),
        authenticationPrompt: /sign in|log in|enter.{0,40}email|email address/.test(text),
        nonEmptyJsonObject
      };
    }`,
  });
  return evaluation(result);
}

let report;
try {
  const acquired = runLease([
    "-Action",
    "Acquire",
    "-Owner",
    leaseOwner,
    "-TtlSeconds",
    "180",
  ]);
  if (acquired.code !== 0 || acquired.payload.acquired !== true) {
    console.log(
      `AUTH_HEALTH ${JSON.stringify({ healthy: false, status: "auth-flow-busy" })}`,
    );
    process.exitCode = 75;
  } else {
    leaseId = acquired.payload.lease_id;
    client = new HttpMcpClient(endpoint);
    await client.initialize();
    const results = [];
    for (const [index, probe] of probes.entries()) {
      if (index === 0) {
        await client.callTool("browser_tabs", { action: "new" });
        claimed = true;
      }
      await client.callTool("browser_navigate", { url: probe.url.href });
      const observed = await inspectCurrent(probe);
      const hostMatches = probe.expectedHosts.includes(observed.finalHost);
      const forbiddenSignals = probe.forbidSignals.filter((signal) => observed[signal] === true);
      const healthy =
        hostMatches &&
        forbiddenSignals.length === 0 &&
        (!probe.requireNonEmptyJsonObject || observed.nonEmptyJsonObject);
      results.push({
        name: probe.name,
        healthy,
        hostMatches,
        forbiddenSignals,
        nonEmptyJsonObject: observed.nonEmptyJsonObject,
      });
    }
    const healthy = results.every((result) => result.healthy);
    report = {
      healthy,
      status: healthy ? "healthy" : "unhealthy",
      probes: results,
    };
    console.log(`AUTH_HEALTH ${JSON.stringify(report)}`);
    process.exitCode = healthy ? 0 : 3;
  }
} catch (error) {
  console.log(
    `AUTH_HEALTH ${JSON.stringify({ healthy: false, status: "error", error: error.message })}`,
  );
  process.exitCode = 2;
} finally {
  if (claimed && client) await client.callTool("browser_tabs", { action: "close" }).catch(() => {});
  if (client) await client.close().catch(() => {});
  if (leaseId)
    runLease(["-Action", "Release", "-LeaseId", leaseId]);
}
