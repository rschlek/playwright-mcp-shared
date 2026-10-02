<!-- playwright-mcp-shared:guidance start -->
## Shared Playwright browser

ALL browser automation goes through the Playwright MCP tools - the default and
only browser surface. Never attach to Chrome any other way: not Codex's built-in
Browser/Chrome plugin or a CDP connection, not the Claude-in-Chrome extension.
Those bypass the shared automation profile below and interfere with the user's
personal browser.

Playwright MCP uses one machine-local browser profile shared by all Claude Code
and Codex sessions. Cookies, SSO logins, extensions, passkeys, and storage changes
are global.

One shared profile can legitimately hold several identities and environments.
Before any sign-in, sign-out, tenant change, or account switch, declare the
intended service, environment, and account class without putting an email or
credential in logs. Treat the operation as a global authentication mutation:
ask first, serialize it against every other authentication flow, and never
silently accept a remembered account. When an account chooser or ambiguous
identity boundary appears, the human selects the intended identity. Use a
disposable fresh-profile canary for one-off or untrusted identity experiments.
If a site presents an unexpected remembered identity or mismatch, stop before
authenticating and run the profile canary from `playwright-mcp-shared:setup`;
do not loop login or clear state speculatively.

1. Before this session's first navigation, wait for any other new session to
   finish claiming its tab. Call `browser_tabs` with action `new`, then immediately
   navigate that new tab to the task's first URL. This serialized claim prevents
   clients from attaching to the same initial page.
2. After claiming, treat the current tab as owned by this session. Other agents'
   tabs remain visible in tab lists; never select, navigate, or close them.
3. Never call `browser_close` during ordinary work. Close only this session's tab,
   and only when its identity is certain.
4. Never log out, clear cookies or storage, or change shared authentication unless
   the user explicitly requests it. Such changes affect every agent.
5. If tab ownership is uncertain, stop and list tabs rather than guessing.
6. Tab ownership does not serialize authentication. Only one client may mutate
   shared authentication state at a time; other clients wait until that flow has
   reached a verified success or failure boundary. Acquire the installed
   `playwright-auth-lease.ps1` before sign-in, sign-out, account selection,
   tenant/environment changes, or SSO recovery; release its exact lease ID in a
   `finally` path. If the lease is busy or the helper is unavailable, do not
   begin authentication. Ordinary authenticated browsing does not need the lease.
<!-- playwright-mcp-shared:guidance end -->
