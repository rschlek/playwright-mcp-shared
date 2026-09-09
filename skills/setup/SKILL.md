---
name: setup
description: >-
  Configure one shared persistent Chrome profile for concurrent agent clients via
  a loopback-only Playwright MCP service: install the pinned server with logon
  autostart, reconcile Claude Code and Codex, and guide the human through optional
  password-manager, single sign-on, and passkey bootstrap without handling
  credentials. Use when agent instances should share cookies, logins, and passkeys,
  when Playwright reports profile locks, or when browser authentication differs
  between sessions. Not for ordinary browser automation or for inspecting or
  repairing profile contents.
---

# Shared Playwright browser setup

Reach this end state:

- One Playwright MCP HTTP service listens only at
  `http://localhost:8931/mcp`.
- The service owns one persistent Chrome profile and uses
  `--shared-browser-context`.
- Every Claude Code and Codex instance sees the same cookies, single sign-on
  sessions, optional extensions, passkeys, and remembered site state.
- Each MCP client claims and retains its own current tab. Other clients' tabs are
  visible but must not be selected or changed.
- The service starts at Windows logon and restarts after failure.
- No credential, cookie, token, extension state, or profile content enters source
  control or agent output.

One profile means one browser identity. It deliberately trades profile isolation
for a consistent authenticated experience across agents.

## Fixed values and assets

- Package: `@playwright/mcp@0.0.79`.
- Endpoint: `http://localhost:8931/mcp`.
- Bind address: `127.0.0.1`.
- Current-user Run value: `PlaywrightMCPShared`.
- Bundled scripts, relative to this SKILL.md:
  - `scripts/playwright-mcp-shared.ps1`
  - `scripts/install-playwright-mcp-shared-autostart.ps1`
  - `scripts/stop-playwright-mcp-shared.ps1`
  - `scripts/playwright-auth-lease.ps1`
  - `scripts/playwright-auth-health.mjs`
  - `scripts/playwright-profile-canary.mjs` (isolated diagnostics only; never
    copied over the managed service)
- Shared behavior asset: `assets/shared-browser-guidance.md`.
- Password-manager choice and service URL are user-provided configuration. This
  plugin does not prescribe, bundle, or automate a credential provider.

Chrome cannot open one user-data directory from multiple browser processes. This
setup avoids that lock by running one browser owner and connecting every MCP
client to it over loopback HTTP.

## Runtime

```text
%LOCALAPPDATA%\playwright-mcp-shared\
  bin\playwright-mcp-shared.ps1
  bin\install-playwright-mcp-shared-autostart.ps1
  bin\stop-playwright-mcp-shared.ps1
  bin\playwright-auth-lease.ps1
  bin\playwright-auth-health.mjs
  package\node_modules\@playwright\mcp\cli.js
  profiles\shared\
  locks\shared-server.lock
  locks\auth-flow.json
  outputs\shared\
  logs\shared-server.stdout.log
  logs\shared-server.stderr.log
  state\shared-server.pid
  state\shared-node.pid
```

The selected shared profile may instead be an existing automation profile path
that the human explicitly chooses during migration. Never enumerate, inspect,
copy, merge, or synchronize profile contents. Unused former pool profiles remain
untouched unless the human separately requests removal.

Treat `outputs\shared` and logs as potentially sensitive. Never commit or retain
them automatically.

## 1. Preflight

1. Confirm Windows, Chrome, Node/npm, and PowerShell 5.1 or later.
2. Confirm port 8931 is free or owned by the existing managed service.
3. Check for Chrome, Node, and PowerShell processes using the intended profile.
   Before changing service or profile configuration, stop the managed service with
   the bundled stop script and ask the human to close any remaining profile window
   normally. Do not kill unrelated Chrome processes.
4. Parse `~/.claude.json` and `~/.codex/config.toml` before editing either.
5. Detect previous direct Playwright, fixed-profile, or pool-launcher entries.
   Those are managed predecessors. Ask before replacing `--extension`,
   `--cdp-endpoint`, another wrapper, or another deliberate custom design.

## 2. Select the shared profile

For a fresh device, use:

`%LOCALAPPDATA%\playwright-mcp-shared\profiles\shared`

For a previously configured device, ask which existing automation profile should
become canonical. Reuse its exact directory only after no process owns it. Do not
copy it. When migrating an existing multi-profile setup and the human has no other
preference, adopt the first established profile so its authenticated state is
preserved.

Every client will share whichever path is selected.

## 3. Install server resources

Copy the three server-management scripts plus `playwright-auth-lease.ps1` and
`playwright-auth-health.mjs` into the runtime `bin` directory. They are managed
files: back up a differing installed copy, write UTF-8 without a BOM, re-read and
require byte equality with the bundled source, then remove the backup. Restore
and stop on any failure. The disposable profile canary remains in the skill and
is never installed over the managed runtime.

Install the package once:

```powershell
npm install --prefix "<LOCALAPPDATA>/playwright-mcp-shared/package" `
  --no-audit --no-fund --save-exact @playwright/mcp@0.0.79
```

Verify `package/node_modules/@playwright/mcp/cli.js` exists and its package
metadata reports `0.0.79`. Clients never invoke `npx`.

Run the shared multi-client test:

```powershell
node <SKILL_DIR>/tests/test-playwright-mcp-shared.mjs
```

Require its PASS result. It proves two HTTP clients share a cookie, retain
distinct current tabs after the claim handshake, and survive an independent
client disconnect.

Run the isolated profile-canary test:

```powershell
node <SKILL_DIR>/tests/test-playwright-profile-canary.mjs
```

Require its PASS result. It proves the diagnostic canary uses a separate
temporary runtime and profile, redacts URL query/fragment state, and removes
only its own temporary profile when explicitly told to discard it.

Run the authentication coordination tests:

```powershell
node <SKILL_DIR>/tests/test-playwright-auth-lease.mjs
node <SKILL_DIR>/tests/test-playwright-auth-health.mjs
```

Require both PASS results. The lease test races eight processes and requires one
winner, protected renewal/release, and clean handoff. The health test uses local
fixtures to prove caller-supplied probes accept healthy state, reject generic
identity/access failures, and never expose response content.

## Shared federation model

Every HTTP client receives the same Playwright `BrowserContext` when
`--shared-browser-context` is enabled. Page selection belongs to the client;
cookies, storage, extensions, and upstream identity-provider sessions belong to
the context. A federated authentication succeeds only when both sides agree:

```text
relying-party session <-> upstream identity-provider session
```

This is service-neutral. A stale upstream account can conflict with any relying
party even after that relying party's cookies were cleared. Fresh profiles and
Incognito succeed because both sides start clean, not because the IP or browser
executable changed.

Ordinary page work remains concurrent. Before any client signs in, signs out,
selects an account, changes tenant/environment, or runs SSO recovery, acquire the
global authentication lease:

```powershell
$lease = powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File "<RUNTIME>/bin/playwright-auth-lease.ps1" `
  -Action Acquire -Owner "<harness>:<workflow>" | ConvertFrom-Json
```

If it returns exit 75 / `reason: busy`, do not begin authentication. Wait for the
current holder to finish or for the bounded lease to expire. Renew long human
flows before expiry. Release with the exact `lease_id` in a `finally` path. The
lease records only owner class and timestamps - never identity values or URLs.

Authentication health is workflow-defined, not hardcoded in this plugin. A
domain workflow supplies a credential-free JSON specification:

```json
{
  "probes": [
    {
      "name": "portal-session",
      "url": "https://service.example/session",
      "expectedHosts": ["service.example"],
      "forbidSignals": ["accessDenied", "identityMismatch", "authenticationPrompt"]
    },
    {
      "name": "application-principal",
      "url": "https://app.example/auth/me",
      "forbidSignals": ["accessDenied", "authenticationRequired"],
      "requireNonEmptyJsonObject": true
    }
  ]
}
```

Run `playwright-auth-health.mjs --spec=<path>` against the shared endpoint. It
acquires the same lease, owns and closes only its claimed tab, and reports host
matching, generic failure classes, and non-empty JSON shape. It never prints page
text, principals, emails, URL parameters, cookies, or tokens. The workflow owns
the probe URLs and decides what healthy means for that service.

## Diagnose identity or session mismatch before repair

Use a fresh-profile canary when native Chrome succeeds but the shared Playwright
profile reaches a different identity, repeated login, `access-denied`, an empty
application principal, or an identity-provider mismatch. Do not clear or replace
the shared profile to test a theory.

1. Complete the read-only preflight above. Leave the managed service and shared
   profile running.
2. Start the visible canary against the failing login entry point:

   ```powershell
   node <SKILL_DIR>/scripts/playwright-profile-canary.mjs `
     --url=https://service.example/login
   ```

   The script starts another Playwright MCP service on an ephemeral loopback
   port, creates a randomized profile under the Windows temporary directory,
   claims a new tab, and immediately navigates it. It never reads from or writes
   to the shared profile.
3. Before authentication, tell the human that a fresh visible canary window is
   ready and ask permission for the human single sign-on, multifactor, or
   password-manager step. The human enters credentials and completes prompts
   directly in Chrome. Never automate or transcribe them.
4. Use `status` after each human step. Output is deliberately limited to the
   current hostname, a coarse route class, and boolean mismatch/access-denied/
   prompt signals. It never prints page text, email values, URL queries,
   fragments, cookies, tokens, or storage.
5. Use `finish` to stop the isolated server and retain its temporary profile for
   follow-up. Retention is the default because deleting a profile clears site
   state. To delete it, use `discard` and type the explicit `DISCARD`
   confirmation. This removes only the randomized canary root.

Interpret the controlled comparison before changing anything:

| Fresh canary | Shared profile | Conclusion and next action |
|---|---|---|
| Reaches the intended account and site | Identity or email mismatch | Stale or conflicting remembered site identity in the shared profile is proven. Offer the targeted repair below. |
| Shows the same identity mismatch | Identity or email mismatch | The mismatch is upstream account/tenant mapping, not shared-profile state. Do not clear the profile; escalate through the identity or site owner. |
| Reaches the intended identity | A separate application still returns an empty principal or `access-denied` | Treat that application's Security Assertion Markup Language (SAML) handoff as a separate problem. Do not delete unrelated site state as a speculative fix. |
| Cannot complete device health, multifactor, or identity-provider authentication | Native Chrome succeeds | Investigate browser/device trust or policy differences. The canary has not implicated shared cookies. |

### Targeted shared-profile repair

Only offer this after the canary proves that the shared profile alone carries
the wrong remembered identity. It is intentionally human-controlled:

1. State which browser-visible relying-party and identity-provider hostnames were implicated
   without inspecting cookie or profile files.
2. Ask explicit permission to stop the managed service, close the shared-profile
   Chrome window normally, and clear only those sites' state. These are three
   user-visible effects; approval must cover them.
3. Run the bundled managed stop script. If any window still owns the selected
   profile, ask the human to close it normally. Never kill unrelated Chrome.
4. Launch standalone Chrome with the exact selected `--user-data-dir` and open
   Chrome's site-data settings. Remove the approved parent-domain group so Chrome
   includes browser-managed and partitioned data for every displayed subdomain;
   clearing cookies plus a guessed list of origins is not equivalent. The human
   then performs the intended single sign-on login in the visible browser. Do not
   automate credentials, multifactor prompts, password-manager sign-in/unlock,
   or passkeys.
5. Ask the human to close Chrome normally, verify no process owns the profile,
   restart the managed service through the installed autostart script, and
   verify the loopback listener and logs.
6. In a newly claimed shared tab, retest the original relying-party entry point
   and then the separate application. A relying-party success plus continued application
   `access-denied` is evidence for an application-principal problem, not a reason
   to broaden state deletion.

If the mismatch survives Chrome's parent-domain site-data deletion, stop retrying.
Run one reversible extension-isolation test only when the fresh canary differs
from the shared profile and the fresh profile did not load extensions: temporarily
disable the suspected autofill/password-manager extension without deleting its
configuration, repeat the cleared-site login once, and re-enable it immediately.
If the failure persists, the extension is exonerated and the old profile contains
identity/session state outside safely targetable site data.

At that boundary, never inspect, edit, or copy profile files. Offer two explicit,
approval-gated escalations in order:

1. Complete the browser/profile 2x2 before clearing broadly: test the same failing
   user-data directory in ordinary Chrome with the Playwright service stopped. If
   it fails there too, Playwright and its network path are exonerated. Then test an
   Incognito window attached to that same user-data directory. Incognito success
   isolates the fault to persistent regular-profile browsing state; Incognito
   failure points to deeper profile identity/configuration.
2. When Incognito succeeds, clear all non-password browsing data from Chrome for
   all time while preserving extensions, password-manager configuration,
   passwords, and passkeys. Include cookies/site data, cache, and non-password
   form autofill. This signs every site out but avoids rebuilding the password
   manager.
3. If Incognito also fails, or the evidenced browsing-data reset fails, leave the
   old profile untouched as rollback and bootstrap a new
   canonical profile under the managed runtime. Do not copy or merge the old
   profile; install or unlock the chosen password manager and establish important
   single sign-on sessions through visible human steps.

### Prevent recurrence

- Multiple legitimate identities are supported. Distinguish the application
  environment (for example dev/stage/prod) from the identity principal (for
  example production, non-production directory, or service-scoped account).
  Do not record email values or credentials in source, logs, or memory.
- Before authentication, declare the intended service, environment, and account
  class. Treat every sign-in, sign-out, tenant change, and account switch as a
  global authentication mutation that requires explicit approval and an
  exclusive authentication lock across all clients.
- Never auto-select a remembered account at an ambiguous identity boundary. The
  human chooses the intended identity. A same-principal dev/stage/prod flow may
  share the profile; identities that must stay concurrently logged in and
  isolated deserve separate named profile lanes. Use the disposable canary for
  one-off identity experiments.
- At the first unexpected remembered identity, email mismatch, or automatic
  denial, stop. Do not retry, sign out, broaden deletion, or overwrite the
  identity. Run the redacted fresh-profile canary and compare the same login
  boundary.
- Before a critical workflow that depends on a specific identity, verify the
  shared profile crosses that service's login boundary without mismatch. This is
  a health check, not permission to refresh or change authentication.
- Keep application-principal failures separate from browser-identity failures.
  A clean relying-party login does not prove a downstream application's SAML principal;
  retest the application and escalate its handoff independently if it still
  returns an empty principal or `access-denied`.

## 4. Bootstrap the shared profile

Skip this step only when the human explicitly selected an already bootstrapped
automation profile.

Otherwise launch visible standalone Chrome with the selected
`--user-data-dir`. Ask the human to:

1. Optionally install their preferred password-manager extension from a trusted
   source and configure its service URL directly in Chrome.
2. Sign in and unlock without placing any credential in chat or the shell.
3. Configure password-manager and browser passkey prompts according to their
   preference.
4. Complete any important single sign-on login once in this shared profile.
5. Close Chrome normally.

Verify no Chrome process owns the path before starting the service. Never weaken
password-manager timeout or lock settings automatically.

## 5. Install and start current-user autostart

Run the installed autostart script with the selected profile:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File "<RUNTIME>/bin/install-playwright-mcp-shared-autostart.ps1" `
  -RuntimeRoot "<RUNTIME>" `
  -ProfilePath "<SELECTED_PROFILE>" `
  -Port 8931 -Start
```

Verify:

- the `PlaywrightMCPShared` value exists under the current user's Windows
  Run key and points at the installed hidden launcher;
- it is running;
- only `127.0.0.1:8931` is listening;
- the owning process belongs to the managed Playwright command;
- the stderr log contains the expected localhost listening message and no startup
  failure.

Use `stop-playwright-mcp-shared.ps1` for upgrades or profile changes. It validates
managed PIDs before stopping anything.

## 6. Reconcile both clients

Current sessions retain their previous MCP transport. Changes apply to new
sessions.

### Claude Code

Merge only `mcpServers.playwright` in `~/.claude.json`:

```json
{
  "type": "http",
  "url": "http://localhost:8931/mcp"
}
```

Preserve every unrelated key and MCP server.

### Codex

Replace only the Playwright server and its obsolete pool `env` subtable:

```toml
[mcp_servers.playwright]
url = "http://localhost:8931/mcp"
startup_timeout_sec = 120.0
```

Preserve every unrelated table, key, comment, and ordering choice.

For each file: back up, make the smallest edit, write UTF-8 without a BOM, re-read
and parse, verify unrelated state, then remove the backup. Restore and stop on any
failed check.

## 7. Apply the shared-browser operating contract

Read `assets/shared-browser-guidance.md`. Insert or refresh its marker-scoped
block in both:

- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`

Replace only the existing `playwright-mcp-shared:guidance` block, or append it after a
blank line. Preserve everything outside the markers byte-for-byte - but scan that
surrounding content for guidance contradicting the block (for example text that
gates Playwright behind an explicit request or endorses Codex's Browser/Chrome
plugin or the Claude-in-Chrome extension as a browser surface) and ask the human
to reconcile it; do not silently rewrite their content.

The essential runtime rule is serialized tab claiming: a new client creates a new
tab and immediately anchors it with its first navigation before another new client
claims a tab. Afterward, each client retains an independent current-tab pointer
while sharing profile state.

## 8. Verification

1. Confirm the five installed runtime scripts match their bundled sources.
2. Confirm package version, autostart identity, loopback listener, selected profile,
   and logs.
3. Confirm both configs parse and resolve Playwright to the same HTTP endpoint.
4. Confirm both guidance blocks are present exactly once.
5. In two new clients:
   - let client A claim and anchor a new tab;
   - then let client B claim and anchor a different tab;
   - set or observe shared login state in one;
   - confirm the other sees it;
   - navigate both concurrently and confirm snapshots remain on their own pages;
   - disconnect one and confirm the other still works.
6. Confirm Chrome uses the selected profile and is not launched with
   `--disable-extensions`.

Do not create a synthetic passkey. The next real passkey or SSO flow is the
functional authentication test.

## Safety

- Never call `browser_close` on the shared server during ordinary work.
- Never select, navigate, or close a tab another agent owns.
- Never log out, clear cookies/storage, or change shared authentication without
  explicit user approval.
- Never expose port 8931 beyond loopback.
- Never inspect, copy, commit, or retain profile contents or managed browser
  outputs.
- Never automate password-manager sign-in or unlock.
