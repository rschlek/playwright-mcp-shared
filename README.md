# Shared Playwright MCP

Shared Playwright MCP is a Windows setup and operations plugin for running one
loopback-only Playwright MCP service that several agent clients can use at the
same time.

It solves the persistent-profile lock problem by giving one service ownership
of the Chrome profile while Claude Code, Codex, and other MCP clients connect to
that service over localhost. Clients share authentication state but retain
their own current-tab pointers.

## Safety model

- The service binds only to `127.0.0.1`.
- Each client claims and owns its own tab.
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
the shared service. It includes lifecycle scripts and four automated tests for
multi-client behavior, authentication leasing, redacted health checks, and
profile-canary isolation.

## Requirements

- Windows with PowerShell 5.1 or later
- Chrome
- Node.js and npm
- Claude Code, Codex, or another MCP client that supports an HTTP MCP server

The plugin currently pins `@playwright/mcp` to a tested version. Password-manager
choice, identity providers, relying-party applications, and browser credentials
are local user configuration and are not prescribed or bundled.
