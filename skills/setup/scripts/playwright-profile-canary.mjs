import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("The Playwright profile canary requires Windows.");
  process.exit(2);
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseTarget(raw) {
  if (!raw) throw new Error("Pass an HTTP(S) target with --url=<url>.");
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("The canary target must use HTTP or HTTPS.");
  if (parsed.username || parsed.password)
    throw new Error("The canary target must not contain credentials.");
  return parsed;
}

const target = parseTarget(option("url"));
const nonInteractive = hasFlag("non-interactive");
const discardOnExit = hasFlag("discard");
const headless = hasFlag("headless");
if (discardOnExit && !nonInteractive)
  throw new Error("Interactive canaries require the explicit DISCARD confirmation.");

const runtimeRoot = path.join(process.env.LOCALAPPDATA, "playwright-mcp-shared");
const mcpCli =
  option("mcp-cli") ||
  path.join(runtimeRoot, "package", "node_modules", "@playwright", "mcp", "cli.js");
await access(mcpCli);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(scriptDir, "playwright-mcp-shared.ps1");
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-profile-canary-"));
const profileRoot = path.join(tempRoot, "profile");
const timeoutMs = 120_000;
let mcpProcess;
let stopped = false;
let discard = discardOnExit;

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
  constructor(endpoint) {
    this.endpoint = endpoint;
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
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    if (response.status === 202) return null;

    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let payload;
    if (contentType.includes("text/event-stream")) {
      const dataLines = body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) throw new Error("Empty MCP event-stream response.");
      payload = JSON.parse(dataLines.join(""));
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
          clientInfo: { name: "playwright-profile-canary", version: "1.0.0" },
        },
      },
      Math.ceil(timeoutMs / 250),
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

function parseEvaluation(result) {
  const text = resultText(result);
  const resultSection = text.match(/### Result\s*\r?\n([\s\S]*?)(?:\r?\n###|$)/);
  const candidate = (resultSection?.[1] || text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Canary status was not structured JSON.");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function status(client) {
  const evaluated = await client.callTool("browser_evaluate", {
    function: `() => {
      const text = (document.body?.innerText || "").toLowerCase();
      const host = location.hostname.toLowerCase();
      const accessDenied = location.pathname.toLowerCase().includes("access-denied") ||
        /access[ -]denied|authentication required/.test(text);
      const emailMismatch = /email.{0,120}(does not match|doesn't match|do not match|mismatch|different)/i.test(text) ||
        /(does not match|doesn't match|do not match|mismatch).{0,120}email/i.test(text);
      return {
        host,
        targetHost: host === ${JSON.stringify(target.hostname.toLowerCase())},
        route: accessDenied ? "access-denied" : host.includes("idbroker") ? "idbroker" :
          host === ${JSON.stringify(target.hostname.toLowerCase())} ? "target" : "other",
        signals: {
          accessDenied,
          emailMismatch,
          authenticationPrompt: /sign in|log in|enter.{0,40}email|email address/.test(text)
        }
      };
    }`,
  });
  const report = parseEvaluation(evaluated);
  console.log(`CANARY_STATUS ${JSON.stringify(report)}`);
  return report;
}

async function navigate(client, url) {
  const parsed = parseTarget(url);
  await client.callTool("browser_navigate", { url: parsed.href });
  await status(client);
}

function stopTempProcesses() {
  const command =
    "$root=$env:PLAYWRIGHT_CANARY_ROOT; " +
    "Get-CimInstance Win32_Process | Where-Object { " +
    "($_.Name -eq 'chrome.exe' -or $_.Name -eq 'node.exe' -or $_.Name -eq 'powershell.exe') -and " +
    "$_.CommandLine -and $_.CommandLine.Contains($root) " +
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: { ...process.env, PLAYWRIGHT_CANARY_ROOT: tempRoot },
        timeout: 30_000,
      },
    );
  } catch {
    // The wrapper or browser may already be stopped.
  }
}

async function stopCanary(client) {
  if (stopped) return;
  stopped = true;
  await client?.close().catch(() => {});
  try {
    const nodePid = Number(
      (await readFile(path.join(tempRoot, "state", "shared-node.pid"), "utf8")).trim(),
    );
    if (Number.isInteger(nodePid) && nodePid > 0) process.kill(nodePid);
  } catch {
    // The temporary MCP process may already be stopped.
  }
  if (mcpProcess && mcpProcess.exitCode === null) mcpProcess.kill();
  stopTempProcesses();
  if (discard) {
    await rm(tempRoot, { recursive: true, force: true });
    console.log("CANARY_DISCARDED");
  } else {
    console.log(`CANARY_RETAINED root=${tempRoot}`);
  }
}

const mcpPort = await freePort();
const endpoint = `http://localhost:${mcpPort}/mcp`;
const powershellArgs = [
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
];
if (headless) powershellArgs.push("-Headless");

mcpProcess = spawn("powershell.exe", powershellArgs, {
  env: process.env,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let stderr = "";
mcpProcess.stderr.setEncoding("utf8");
mcpProcess.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const client = new HttpMcpClient(endpoint);
try {
  await client.initialize();
  console.log(
    `CANARY_READY root=${tempRoot} targetHost=${target.hostname} sharedProfileUntouched=true`,
  );
  await client.callTool("browser_tabs", { action: "new" });
  await navigate(client, target.href);

  if (!nonInteractive) {
    console.log(
      "Complete any approved authentication in the visible canary window. " +
        "Commands: status, navigate <https-url>, finish, discard.",
    );
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    while (true) {
      const command = (await terminal.question("canary> ")).trim();
      if (!command || command === "status") {
        await status(client);
        continue;
      }
      if (command.startsWith("navigate ")) {
        await navigate(client, command.slice("navigate ".length).trim());
        continue;
      }
      if (command === "finish") break;
      if (command === "discard") {
        const confirmation = await terminal.question(
          "Type DISCARD to stop the canary and delete only its temporary profile: ",
        );
        if (confirmation === "DISCARD") {
          discard = true;
          break;
        }
        console.log("Discard cancelled; the canary is still running.");
        continue;
      }
      console.log("Unknown command. Use status, navigate <https-url>, finish, or discard.");
    }
    terminal.close();
  }
} catch (error) {
  const startup = stderr.trim() ? ` Temporary MCP error: ${stderr.trim()}` : "";
  console.error(`CANARY_FAILED ${error.message}.${startup}`);
  process.exitCode = 1;
} finally {
  await stopCanary(client);
}
