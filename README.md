# Shared Playwright MCP

Shared Playwright MCP is a setup and operations plugin for running one
loopback-only Playwright MCP service that several agent clients can use at the
same time.

It solves the persistent-profile lock problem by giving one service ownership
of the Chrome profile while Claude Code, Codex, and other MCP clients connect to
that service over localhost. Clients share authentication state but retain
their own current-tab pointers.

## Safety model

- The service binds only to `127.0.0.1`.
- Each client claims and owns its own tab, and labels the claim in a shared
  registry.
- The browser's first tab shows a loopback-only live dashboard: every open
  tab with the agent that claimed it, the authentication lease, and service
  status. It shows URLs without queries or fragments and puts itself back if
  an unclaimed launch tab is navigated away.
- Authentication mutations are serialized through a lease.
- Ambiguous account selection and credential entry remain human-controlled.
- Health probes report only coarse status and never page text, principals,
  cookies, tokens, or URL parameters.
- A disposable fresh-profile canary diagnoses identity-state problems without
  touching the shared profile.
- Browser-profile contents, extensions, credentials, and generated outputs are
  never part of this repository.

## Included skill

`playwright-mcp-shared:setup` installs, configures, verifies, repairs, or removes
the shared service. It includes lifecycle scripts and automated tests for
multi-client behavior, authentication leasing, tab claims, the launch-tab
dashboard, redacted health checks, and profile-canary isolation, plus the
portable Windows/macOS lifecycle.

## Names you can set

The runtime folder and the startup entry are settings, with these defaults:

- Runtime folder: `%LOCALAPPDATA%\playwright-mcp-shared` on Windows,
  `${XDG_DATA_HOME:-~/.local/share}/playwright-mcp-shared` on Linux. Pass
  `-RuntimeRoot <path>` or set `PLAYWRIGHT_MCP_SHARED_RUNTIME_ROOT`.
- Startup entry: the current-user scheduled task `PlaywrightMCPSharedService`
  on Windows (installer `-TaskName`), the systemd user unit
  `playwright-mcp-shared` on Linux (installer `-UnitName`).

Given an existing installation's runtime folder, setup uses the browser profile
already in it. The installer records the entry name in the runtime, so a later
install of the same runtime keeps it without being told again. The skill
describes the details.

## Requirements

- Windows with PowerShell 5.1 or later; Linux with bash and a systemd user
  session; or macOS preview through the portable lifecycle
- Chrome
- Node.js and npm
- Claude Code, Codex, or another MCP client that supports an HTTP MCP server

The plugin currently pins `@playwright/mcp` to a tested version. Password-manager
choice, identity providers, relying-party applications, and browser credentials
are local user configuration and are not prescribed or bundled.
