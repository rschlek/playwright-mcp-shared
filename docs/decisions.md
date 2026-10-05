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
