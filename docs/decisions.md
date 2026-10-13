# Decisions

## 2026-10-04: The launch tab shows a live dashboard of tabs and claims

Decided: the supervisor runs a dependency-free Node.js dashboard on a second
loopback port (default 8932). It is one more MCP client of the service, lists
tabs on an interval, joins them with a new tab-claim registry
(`locks/tab-claims.json`, written by `playwright-tab-claim.ps1` and
`tab_claim.py`) and the authentication lease, and shows itself in the
browser's launch tab.

Why: the blank launch tab confused people and agents, and nothing recorded
which session used which tab. The spike recorded in
`docs/research/2026-10-04-launch-tab-dashboard-spike.md` showed that a
list-only client creates no tab and moves no other client's pointer.

How the launch tab is taken: the dashboard's own MCP session starts on the
first tab, and the dashboard navigates it once it is confirmed blank. Rejected:
a launch URL argument, because Playwright refuses page arguments for
persistent contexts; and the `initPage` configuration hook, because it runs for
every page in every client session, including tabs other agents are opening.

Tab identity: the tool exposes only indexes, which shift. The dashboard
follows each tab across polls by aligning successive lists (pages are only
appended; any may close) and binds a claim to the newest unclaimed tab whose
URL matches, then keeps that binding across navigation. Rejected: the
`browser_run_code_unsafe` tool, which would give exact page identity but runs
arbitrary code in the service process.

Self-heal: a recreated session starts on the first tab, so a stray navigate
can land there. The dashboard restores an unclaimed launch tab after a grace
period, pauses after repeated restores, and never navigates a claimed tab or a
tab its own pointer fell back to after its tab closed.

Attach only while a browser runs: a connected client keeps the service from
closing the browser, so attaching at service start would open Chrome at logon.
The dashboard attaches when the profile is locked by a running browser.

Live updates use one server-sent event stream: every connected client's
session records each request a page makes for as long as the page lives, so a
polling page would grow every agent's session without bound.

Privacy: URLs are reduced to scheme, host, and path in the registry, the page,
and the JSON; claim and lease IDs are never shown; only loopback Host headers
are served.

## 2026-10-12: The browser runs on demand, and the dashboard never holds it open

Decided: the shared browser starts when an agent needs it and closes when no
agent is attached. A person closing the browser window is a close: nothing
starts it again until an agent's next tool call. The dashboard no longer keeps
an MCP session between polls, and its `--attach always` option (with the
launcher's `-DashboardAttach` and `PLAYWRIGHT_MCP_SHARED_DASHBOARD_ATTACH`) is
removed.

Why: the pinned service already launches the browser lazily on a session's
first tool call and closes it when its count of clients with a browser backend
reaches zero (the backend's dispose callback in the shared-browser factory
closes the context and the browser). Two things in the dashboard defeated that.
Once attached, it listed tabs on every poll, and any tool call starts the
browser, so it relaunched a browser a person had closed within one poll. And
its long-lived session counted as a client, so the browser stayed open after
the last agent left.

How: before every poll the dashboard checks that a browser owns the profile;
if not, it forgets its tabs, reports `detached` ("The browser was closed. It
starts again when an agent needs it."), and calls no tool. While a browser
runs, each poll opens its own MCP session, lists tabs, does any launch-tab
work, and deletes the session, so the dashboard's share of the client count
lasts only for the poll. The launch tab belongs to the shared context, not to
a session, so the dashboard follows it by tab identity across sessions; a new
session starts on the first tab, so the launch tab is navigated without being
selected, and any other tab is selected only right before a restore. A
session left by a dashboard killed mid-poll is recorded and deleted by the
next poll. Accepted: a browser that closes in the moment between the check
and the poll's call is started again and closes when the poll's session is
deleted.

Idle agents count. A connected agent session that has made a tool call holds
a browser backend however long it stays quiet, so it keeps the browser open.
No idle pruning was added and the ping timeout stays 0.

Trade-offs: the first tool call after a close waits for a cold browser start,
about 1 to 3 seconds. A password manager extension whose vault locks on
browser restart comes back locked. Session-only cookies are lost; persistent
cookies and saved logins remain in the profile. Tab indexes reset, so tab
claims recorded before the close point at tabs that no longer exist until
their TTL expires. Each relaunch opens one blank tab, which the dashboard
takes as its launch tab.
