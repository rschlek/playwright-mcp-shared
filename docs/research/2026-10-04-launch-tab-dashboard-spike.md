# Launch-tab dashboard spike

Date: 2026-10-04. Package: `@playwright/mcp` 0.0.79, which bundles
`playwright-core` 1.63.0-alpha-2026-08-05. Line numbers refer to
`node_modules/playwright-core/lib/coreBundle.js` in that install. All runs used
a disposable runtime, a disposable profile, and a free loopback port, headless,
with `--shared-browser-context` and `PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0` as the
supervisor sets them.

## A list-only client is safe

- Each MCP session gets its own `Context` (line 64744). It wraps every
  existing page in its own `Tab` objects and keeps its own `_currentTab`; on
  creation the first page becomes current (`_onPageCreated`, line 64869).
- `browser_tabs` with action `list` calls `ensureTab` and renders the tabs
  (line 67151). `ensureTab` opens a page only when the session has no current
  tab at all, which happens only when the context has no pages.
- Observed: after an agent claimed a tab, an observer listed tabs six times;
  the tab count did not change and the agent's tab stayed `(current)` for the
  agent. The observer's own current tab was tab 0.
- Restart: with the service down, calls fail with a connection error; after
  it returns, the old session gets HTTP 404 "Session not found" (line 71371)
  and a new `initialize` works. The browser is relaunched with a fresh blank
  first tab.
- The service closes the browser when its last client disconnects
  (`clientCount`, line 73110). A long-lived observer therefore keeps the
  browser open. Observed: with all clients disconnected, the profile's
  `lockfile` disappeared; while the browser ran, opening it failed with EBUSY.
- Every session records requests and events for every page until that
  session navigates the page or the page closes (`_handleRequest`, line 64441;
  cleared at lines 64472 and 64520). A page that polls the network grows every
  session; a single long-lived event stream does not.

## Launch-tab mechanisms

- Launch URL argument: rejected by Playwright before launch with "Arguments can
  not specify page to be opened" (line 43234). Persistent launches always push
  a literal `about:blank` (line 43218).
- `browser.initPage`: the hook runs inside `Tab._initialize` (line 64383) for
  every page in every session. Observed with two sessions and two agent tabs:
  six invocations, five of them on `about:blank`, including a new agent tab
  before its own navigation. A navigating hook would hijack other agents' new
  tabs. The module must also export `default`.
- Navigate from an MCP client: a new session's current tab is the first page,
  so `browser_navigate` from a fresh session replaces the blank launch tab in
  place. Observed: no additional tab, and the other client's current tab was
  unchanged.

## Why a current-tab pointer falls back to tab 0

The pointer is per-session state and is never persisted:

- When a client's MCP session is recreated (service restart, a 404 after the
  service restarted, or a client that reconnects after an error or idle
  teardown), the new session's current tab is the first page again (line
  64869). Observed: a client that re-initialized was `(current)` on tab 0.
- When a session's own tab closes, its pointer moves to the tab at the same
  index or the last tab (`_onPageClosed`, line 64877), which can be another
  agent's tab. Observed: after its tab was closed by another client, the agent
  was current on a third agent's tab.
- The service's own idle heartbeat is disabled by the supervisor
  (`PLAYWRIGHT_MCP_PING_TIMEOUT_MS=0`, line 71608), so the service never drops
  an idle session itself; a fallback after a quiet period comes from the
  client side recreating its session.

Both are behaviour of the pinned package and cannot be changed without
patching it. The dashboard therefore restores an unclaimed launch tab that was
navigated away, and the guidance tells agents to check their current tab after
any reconnect or idle gap.
