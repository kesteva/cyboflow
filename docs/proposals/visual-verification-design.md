# cyboflow Layered Visual Verification — Architecture & Plan

Status: **DESIGN APPROVED — decisions locked, implementation not yet started.**
Branch: `visual-verify` (off `main@d9be8e84`). Source design pass: workflow `wf_902f979c-94c`.

Visual verification turns the dead-end `cyboflow-visual-verify` subagent (today:
`tools: Read, Grep, Glob, Bash`, gated by an "enabled" flag that exists nowhere in
the codebase) into a real, tiered capability: capture the rendered deliverable,
judge it against task intent, and feed FAIL back into the implement loop.

The screenshots **plumbing** already shipped (merged to main): `CYBOFLOW_RUN_ARTIFACTS_DIR`
(agent env), `handleVisualArtifactsScan` safety-net, the screenshots artifact gallery
(`artifactImages.ts` + `ArtifactTabRenderer`). What's missing is the **producer**
(capture) + the **judge** + the **scheduler** that makes it parallel-safe.

---

## Locked decisions (user, this session)

1. **Scheduler owns the dev server.** It spawns + leases the dev server per the
   `.cyboflow/verify.json` `start` / `readyWhen` / `${PORT}` contract, centralizing
   port-collision serialization. Lanes do NOT start their own; they pass intent.
2. **Merge-gate is the gate mode.** A lane parks at a new `awaiting-verify` step;
   PASS drives it → `integrated`, FAIL drives it → `implement` with the judge's
   feedback threaded in (reusing the proven `task-verify` loopback). Batch
   integration of the shared worktree is held until all lanes are `integrated`.
   (Advisory mode may still ship first as a stepping stone — see Phased plan.)
3. **VLM judge ON when verification is enabled**, bounded by `maxPerRunJudgeCalls`
   + a confidence threshold + **deterministic-assertions-first** (Playwright a11y
   snapshot/locator, Maestro `assertVisible`) to cap Agent-SDK billing.
4. **Maestro stubbed inert.** Ship the backend stub + matrix entry but leave
   `simulatorPoolSize: 0` so the resolver always drops it from the chain and emits
   an "unavailable" SKIP. Light it up only when a mobile deliverable exists.

Recommended defaults for the remaining open items (not yet ratified — see "Open
decisions"): type precedence = agent-declared highest; global default = **OFF**
(opt-in); Playwright = lazy-install chromium-only; low-confidence → non-blocking
`finding`; pools = **5 ports** (= `SPRINT_BATCH_CAP`), **0 simulators**;
config home = `.cyboflow/verify.json` at project root.

---

## Architecture at a glance

Four planes. Decisive choices: **scheduler is a main-process singleton service,
not an agent** (owns OS-scarce resources, outlives mortal lane agents, composes
with the global `mutex`); **capture is centralized, agents only *request*** (one
new MCP tool — granting Peekaboo/Playwright MCP to N parallel lanes would make
them fight over one screen + overlapping ports by construction); **capability
waterfall easy→hard**; **VLM judge is orthogonal "Rung 4"** applied after whichever
capture rung succeeds, fully parallel, never gates throughput.

```
                         LANE AGENT (sprint/ship subagent)
                    cyboflow_request_verification(deliverable, intent)
                                      │  returns {requestId} IMMEDIATELY — lane never blocks
                                      ▼
   cyboflowMcpServer.js ── socket ──► mcpQueryHandler  case 'mcp-request-verification'
                                            │  INSERT verification_requests(status=queued) + nudge()
                                            ▼
 ┌──────────────── VerificationScheduler (main-process singleton) ────────────────┐
 │  drain loop (setImmediate — NOT RunQueueRegistry; no-recursive-enqueue)         │
 │     ▼  WATERFALL SELECT (cheapest rung satisfying required_type)                │
 │  ┌────────────┬────────────┬────────────┬────────────┐  ResourceLeasePool      │
 │  │ Rung 0     │ Rung 1     │ Rung 2     │ Rung 3     │  (over mutex.ts)         │
 │  │ capturePage│ Playwright │ Peekaboo   │ Maestro    │  verify:screen (count 1) │
 │  │ in-process │ lib/child  │ MCP screen │ CLI device │  verify:port:<p> (pool)  │
 │  │ headless ∥ │ headless ∥ │ SERIALIZED │ 1 dev/lane │  verify:sim:<udid> (pool)│
 │  │ NO lease   │ port lease │verify:screen│ verify:sim │  (Rung0/1/judge: none)  │
 │  └─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┘                         │
 │        └────────────┴── PNGs → $CYBOFLOW_RUN_ARTIFACTS_DIR ──┴──► Rung 4: VlmJudge │
 │                                                                  (Claude vision, ∥)│
 │   verdict ◄──────────────────────────────────────────────────────────┘          │
 │     ArtifactRouter (enrich 'screenshots' payload) + ReviewItemRouter (FAIL finding)│
 │     SprintLaneStore.updateLane + sprintLaneEvents → lane: PASS advance / FAIL re-implement │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Three new seams map onto three existing patterns: **resolver + createRun stamp**
(mirrors `substrateResolver` / `executionModelResolver` / `permissionModeResolver`),
the **scheduler singleton** (mirrors `SprintLaneStore.initialize` / `OrchSocketServer`),
and the **request MCP tool** (mirrors `cyboflow_report_finding` via `mcpQueryHandler`).

---

## Components & responsibilities

### 1. `shared/types/visualVerification.ts` — pure shared seam (no IPC/runtime)
Beside `shared/types/substrate.ts`; both main + renderer import it. Declares the
`VerificationType` taxonomy, `VisualBackendId` set, `BACKEND_CAPABILITIES` matrix,
`FALLBACK_CHAINS`. Small + reviewed (4 backends × 5 types) — a wrong matrix entry
silently mis-routes.

```ts
export type VerificationType =
  | 'static-render-snapshot'    // render + roughly look right, no interaction
  | 'interactive-web-behavior'  // navigate/click/type/wait-for; multi-step DOM
  | 'responsive-multi-viewport' // same web artifact across N widths
  | 'native-desktop'            // the REAL running app (incl. cyboflow's OWN renderer)
  | 'mobile-flow';              // iOS/Android build, YAML flow

export type VisualBackendId = 'capturePage' | 'playwright' | 'peekaboo' | 'maestro';

export const FALLBACK_CHAINS: Record<VerificationType, VisualBackendId[]> = {
  'static-render-snapshot':    ['capturePage','playwright','peekaboo'],
  'interactive-web-behavior':  ['playwright','peekaboo'],          // capturePage can't click
  'responsive-multi-viewport': ['capturePage','playwright','peekaboo'],
  'native-desktop':            ['peekaboo'],                       // ONLY Peekaboo (see note)
  'mobile-flow':               ['maestro'],
};
```
Note `native-desktop`: for cyboflow's OWN renderer the chain skips capturePage/playwright
— both fail identically (renderer needs preload-injected `electronTRPC`); Peekaboo wins
because it screenshots the *already-running* app instead of bootstrapping it.

### 2. `visualVerificationResolver.ts` (`main/src/orchestrator/`)
Exact sibling of `substrateResolver.ts`. Given `{ requestedType?, globalConfig,
projectConfig, perRunOverride }` resolves (a) **enabled?** + (b) the **TYPE**, then
the backend **chain** = `FALLBACK_CHAINS[type]` ∩ backends whose host-deps are
available. Resolves ONCE. Precedence: **per-run override > project
`.cyboflow/verify.json:enabled` > global `AppConfig` > false**.

### 3. createRun stamp (`WorkflowRegistry.createRun`)
Enablement / type / chain stamped immutably onto the `workflow_runs` row where
`substrate` / `permissionMode` / `executionModel` resolve today. Three columns,
one migration (**036**), **no UPDATE path** (dual-substrate invariant). A long run
can't change posture mid-flight; per-request `type_override` only *narrows* within
the resolved chain — it cannot turn a disabled run on.

### 4. `VerificationScheduler` singleton (`main/src/orchestrator/verify/verificationScheduler.ts`)
Initialized in `index.ts initializeServices()` next to `SprintLaneStore.initialize`.
Standalone-typecheck invariant: **no direct `electron`/`better-sqlite3` imports** —
DB injected as `DatabaseLike`, backends injected as a narrow
`VerificationBackendRegistry`. Owns the DB-backed request queue, the
`ResourceLeasePool` (built on `mutex.ts`), the waterfall dispatcher, the
round-robin drain loop. `_resetForTesting()` for parity.

### 5. Backends — capability ladder (`main/src/services/visualVerify/`)
Each implements `{ rung; requiredLease(req): string|null; capture(ctx, signal):
Promise<CaptureResult>; healthCheck() }`. All write PNGs into
`$CYBOFLOW_RUN_ARTIFACTS_DIR`.
- **Rung 0 `CapturePageBackend`** (in-process): offscreen `BrowserWindow({show:false})`
  → `loadURL`/`loadFile` → `webContents.capturePage()` → `toPNG()`. Zero deps, zero
  perms, CPU-parallel, **no lease**. Default first rung.
- **Rung 1 `PlaywrightBackend`** (library in a child process, NOT the MCP server —
  deterministic scripting + `BrowserContext`-per-lane; the MCP server's single
  profile can't be shared concurrently). Takes `verify:port` only when it spawns a
  dev server.
- **Rung 2 `PeekabooBackend`** (`mcp__peekaboo__image`/`analyze`): the ONLY backend
  that sees cyboflow's own renderer. Scheduler is its sole client. Requires `pnpm
  dev` + 2 TCC grants on the MCP host binary (recurring SPRINT-031..039 gotcha).
  Takes `verify:screen` (count 1).
- **Rung 3 `MaestroBackend`** (`maestro test` CLI): one `verify:sim:<udid>` per lane.
  **Inert** until `simulatorPoolSize > 0`.

### 6. `VlmJudge` (Rung 4) — `main/src/services/visualVerify/vlmJudge.ts`
Stateless Anthropic vision call. PNGs + intent + optional baseline → structured
`VerdictV1 { status: pass|fail|low_confidence, confidence, issues[], feedback,
judgedFileNames, baselineUsed, model }`. Below threshold → `low_confidence` →
human review_item (never a fabricated verdict). **Deterministic-assertion-first**
+ `maxPerRunJudgeCalls` cap (2026 Agent-SDK billing). The only place the "agent"
(model) appears; scheduling itself is pure/deterministic.

### 7. Config & enablement
- **`AppConfig.visualVerify`** (`main/src/types/config.ts` + `UpdateConfigRequest`):
  global master switch (default **OFF**), `defaultType`, `vlmConfidenceThreshold`
  (0.7), `maxPerRunJudgeCalls`, `devServerPorts[]`, `simulatorDevices[]`. Getter
  mirrors `interactivePtyOnly` / `artifactCommitDir`.
- **`.cyboflow/verify.json`** at PROJECT ROOT (sibling to `.cyboflow/artifacts`):
  the per-deliverable "how to run this" contract — `deliverables[].{id, type, build,
  start, url, readyWhen, viewports, interactions}`. Product config that travels with
  the deliverable; deliberately NOT in `.claude/settings.json` or the DB.

### 8. Static server (S9) — `main/src/services/visualVerify/staticServerManager.ts`
Closes a blank-page class the MVP shipped with: a request that targets a BUILT
html file (no running `url`, no verify.json `start`) was loaded over `file://` by
the rung-0 `CapturePageBackend`. Chromium treats `file://` as an opaque origin and
CORS-blocks every `<script type="module">`, so bundler output silently rendered a
blank styled shell — no error, no signal, just an empty capture a human had to
notice by eye.

- **Zero-config.** No verify.json entry is required — `matchDeliverable` rule (e)
  additionally hydrates a single bare `htmlPath` deliverable (no `start`, honest-
  matching preserved: two-or-more static candidates is still ambiguous ⇒ null;
  any startable deliverable keeps rule (d)'s precedence untouched).
- **Ephemeral loopback HTTP server**, one per request: `StaticServerManager.spawn`
  binds `127.0.0.1:0` (OS-assigned port) and confines itself to a `staticRoot`
  directory — `dirname(htmlPath)` by default, or the deliverable's explicit
  `verify.json` `staticRoot` for a layout whose root-absolute assets (`/assets/...`)
  live ABOVE the html's own directory. No lease is taken (unlike the S2 dev-server
  port pool) — an OS-assigned port never collides, so static captures stay fully
  parallel.
- **Token-prefixed URL space is the authorization boundary.** Binding a loopback
  port grants zero access control by itself — anything on the interface could hit
  it — so every request must present an unguessable 32-hex-char token
  (`randomBytes(16)`, minted fresh per spawn) as the FIRST path segment; a
  mismatched or absent token is a 404 indistinguishable from a missing asset (no
  signal leaked about "how close" a guess was).
- **Dotfile + `node_modules` denylist**, defense-in-depth alongside lexical AND
  realpath containment checks (closes the symlink-escape hole a lexical check
  alone can't see) — see the file's own header for the full per-request pipeline.
- **Fail-soft to the raw `htmlPath` capture.** Every failure mode — no provider/
  resolver wired, the html not found in either checkout, an explicit `staticRoot`
  that doesn't exist or doesn't contain the html, a bind/abort failure mid-spawn —
  is `null` + a log, never a request FAIL. `resolveStaticHtmlContext`
  (`main/src/orchestrator/verifyConfigLoader.ts`) does the worktree-first/project-
  fallback resolution + containment check (mirrors `resolveDeliverableContext`);
  the scheduler then captures the request's own `htmlPath` unchanged, and the
  rung-0 backend's `file://` module-block diagnostic breadcrumb (`CaptureResult.
  diagnostics` — untrusted, human-surfaces-only; see "Judge + feedback loop" below)
  explains the resulting blank shell to a human.
- **`CaptureOrigin` provenance.** Every terminal payload is stamped with which
  server (if any) sourced the capture: `'dev-server' | 'static-server' | 'url' |
  'file'` — human-facing metadata only, never part of the verdict (more in "Judge +
  feedback loop" below).

---

## The collision story (the part that must be right)

Rule: **scarce resources serialize; lanes keep flowing.**

1. **Request is fire-and-continue.** `cyboflow_request_verification` →
   `mcpQueryHandler` does ONE sync thing: `INSERT verification_requests
   (status='queued')` + reply `{requestId}` immediately, then `scheduler.nudge()`.
   The DAG fan-out picks up the next lane (5-concurrent, `spawnKey` per lane) with
   zero verification stall.
2. **Drain runs OUTSIDE any per-run queue.** `nudge()` → `setImmediate` drain on
   the scheduler's OWN loop — deliberately NOT the requesting run's
   `RunQueueRegistry` PQueue (`concurrency:1`, no-recursive-enqueue rule at
   `RunQueueRegistry.ts:9-13`; the request arrives FROM a task already on that
   queue → enqueuing there self-deadlocks).
3. **Serialize ONLY what physics demands.** Drain SELECTs `queued` rows ordered
   `(enqueued_at, id)` (fair round-robin), `requiredLease(req)` decides contention
   via `mutex.acquire(name, timeout) → release` (`mutex.ts:22`):
   - Rung 0 / Rung 1 / VlmJudge → **null lease** → run under a CPU cap, **fully parallel**.
   - Rung 2 (Peekaboo) → `verify:screen` (count 1) — physics: one display/focus/input.
   - Port-bound → first free `verify:port:<p>`; sim-bound → first free `verify:sim:<udid>`.
   `mutex.ts` is count-1 per name; the `ResourceLeasePool` emulates N ports/sims by
   holding N distinct named leases and probing for a free one. Reusing the SAME
   `mutex` instance is why `verify:screen` composes app-wide with PanelManager /
   WorktreeManager holders.
4. **If no slot is free, the REQUEST waits, the LANE does not.** The row stays
   `queued`, retried next drain.
5. **Batch sync point.** Verification reading a shared sprint worktree waits on a
   `mutex` named `sprint-verify-<batchId>` until every lane's task-verify committed.
6. **Verdict delivery, async.** `release()` in `finally`. Verdict written via
   `SprintLaneStore.updateLane` + `sprintLaneEvents`; the lane's programmatic walk
   observes it on its next step boundary.
7. **Crash-safety.** DB-backed queue survives restart; `runRecovery` re-drains
   orphaned `leased`/`running` rows as `timeout`; per-request timeouts (5 min) →
   `signal.abort()`; `cancelForRun(runId)` on cancel/teardown.

---

## The waterfall

| Backend (rung) | Satisfies | Interact | Headless | Parallel cost | Host deps |
|---|---|---|---|---|---|
| **capturePage** (0) | static-render, responsive | no | yes | **free** (CPU) | none |
| **playwright** (1) | static, interactive-web, responsive | yes | yes | cheap (CPU) | browser binaries |
| **peekaboo** (2) | static, interactive, responsive, **native-desktop** | yes | **no** | **single-screen** | GUI + 2 TCC |
| **maestro** (3) | **mobile-flow** | yes | no (device) | one-device-per-lane | Xcode/SDK + device |

**Type determination** (override ladder, mirrors substrate): A) agent-declared
`type_override` (highest) → B) per-project config / `AppConfig.defaultType` → C)
inferred from deliverable kind (floor: `url`/`html` no-interaction →
static-render; `url` + interaction → interactive-web; `app-window` → native-desktop;
`mobile-build` → mobile-flow).

**Three fall-forward triggers:** (1) capability gap (compile-time, matrix-encoded —
capturePage already absent from interactive chains); (2) runtime failure (throw /
timeout / healthCheck fail / no PNG → advance rung); (3) low VLM confidence
(pixels fine, judge unsure → escalate to **human**, not another camera).

> **Honesty note:** trigger (2) as described is the SELECTION-TIME behavior
> (`healthCheck` / registry gaps dropping a backend from the chain BEFORE a
> request is dispatched to it). A RUNTIME capture failure once a backend has
> already been chosen does NOT currently fall forward to the next rung — the
> scheduler's `runChosen` records it 'failed' for that request (see its own doc
> comment: "a capture that fails ... is recorded as 'failed' for THIS slice — full
> fall-forward to the next rung is L2+"). So today trigger (2) in practice covers
> only the selection-time health/registry-drop case; a mid-capture throw/timeout/
> empty-PNG is a terminal failure, not yet an automatic rung advance.

**Host-dep filtering / never-silently-pass:** resolver drops `peekaboo` without
GUI/TCC, `maestro` with `simulatorPoolSize===0`. Empty intersection → emit a
`human_task` review_item and **SKIP** (missing precondition → SKIPPED, never FAIL —
a missing TCC grant must never wedge a sprint).

---

## Judge + feedback loop

Capture plumbing exists; only the JUDGE + gate machinery is net-new. After capture:
prefer a deterministic assertion when the check is exact (free); else SSIM/pixel
pre-diff when a baseline exists (filters AA noise before spending a vision call),
then Claude vision → `VerdictV1`.

Persist through existing chokepoints (no new judge table in MVP):
- **`ArtifactRouter`** enriches the SAME `screenshots` artifact payload (idempotent
  UPSERT) with a `verdict` block → tab renders a verdict banner + per-image issues.
- **`ReviewItemRouter`** creates ONE `kind:'finding'` review_item only on FAIL /
  low_confidence (severity from worst issue, `category:'visual-regression'` or
  `'post-merge-bug'`), and only on the **final exhausted attempt** (no 3-findings-
  per-loop). PASS creates no finding.

**Gate = merge-gate (locked decision #2):** lane parks at a new `awaiting-verify`
step; PASS → `integrated`; FAIL → `cyboflow-implement` with `verdict.feedback`,
bump `attempt`, re-capture, re-judge (same 3× cap as task-verify; then mark lane
`failed`, blocking finding already in inbox, other lanes continue). Batch
integration held until all lanes `integrated`; budget exhaustion routes through the
existing `triageFailure` / escalate seam. LOW_CONFIDENCE never auto-loops →
non-blocking "needs human visual review" finding.

**Golden baselines (later layer):** git-tracked PNGs under
`.cyboflow/artifacts/baselines/<key>/<viewport>.png` (durable project root).
Updated ONLY by an explicit human "Accept as baseline" action. Missing baseline =
intent-only judging = MVP behavior. **Post-S9 caveat:** a baseline accepted BEFORE
the S9 static-server seam landed may have been captured over `file://`
(`CaptureOrigin: 'file'`); the SAME deliverable captured after S9 now renders over
`http://127.0.0.1:<port>/<token>/...` (`CaptureOrigin: 'static-server'`) — a real
origin where module scripts actually execute, vs. the pre-S9 blank/degraded shell.
The two can legitimately mismatch on SSIM pre-diff even though the source is
unchanged; re-accept any pre-S9 baseline for a static `htmlPath` deliverable once
S9 is live.

**`CaptureResult.diagnostics` is UNTRUSTED.** It carries page-controlled text
(console errors, the `file://` module-block breadcrumb, fold-truncation notes),
capped by the backend. Because the CAPTURED PAGE controls this content, it is
metadata for HUMAN surfaces only (the result payload / review item) — it must
NEVER be threaded into `VlmJudge` inputs (a prompt-injection surface) and it never
determines pass/fail.

---

## Phased implementation plan

### MVP — smallest end-to-end useful slice (zero new deps/perms/sims)
Target: visual verification *works* for the most common deliverable (a localhost
URL or HTML file) with Rung 0 only.
1. `shared/types/visualVerification.ts` — types + matrix + chains (pure; no-op until wired).
2. `AppConfig.visualVerify` (default OFF) + ConfigManager getter + Settings toggle.
3. `visualVerificationResolver.ts` + createRun stamp (migration **036**: 3 immutable cols).
4. Migration **036** also adds `verification_requests` + `VerificationScheduler`
   singleton wired in `initializeServices()`.
5. `cyboflow_request_verification` MCP tool + socket envelope + `case
   'mcp-request-verification'` (INSERT + nudge + immediate `{requestId}`). Granted
   to `cyboflow-visual-verify` ONLY (one tool added to frontmatter — preserves
   single-writer: subagents request, never mutate).
6. **Rung 0 `CapturePageBackend`** + **`VlmJudge`** only.
7. Verdict delivery: enrich `screenshots` artifact + finding on FAIL/low_confidence.
   **Decision #2 = merge-gate**: implement the `awaiting-verify` lane step +
   loopback in this slice (or land advisory first as a stepping stone, then
   merge-gate immediately after — see note).
8. Screenshots-tab verdict banner + per-image issues (small frontend add).
9. Wire the `cyboflow-visual-verify` subagent (sprint + ship) to call the tool
   instead of being an undefined-gated stub.
10. Per-request timeout + abort + `cancelForRun` + `runRecovery` orphan re-drain.

> Note on gate sequencing: advisory mode is byte-compatible with today's "optional
> → finding" semantics and is the lower-risk first landing; since the user locked
> **merge-gate**, build advisory → then merge-gate as the immediate follow, OR go
> straight to merge-gate. Either way merge-gate is the shipped target.

### Incremental layers (each additive, behind its own toggle + precondition probe)
- **L2 — Rung 1 Playwright** (child process): interactive-web, multi-viewport,
  a11y exact assertions, the real fallback when capturePage renders blank. Adds the
  `verify:port` pool. (Bundling = lazy-install chromium-only.)
- **L3 — Rung 2 Peekaboo**: native-desktop for cyboflow's own renderer. `verify:screen`
  size-1 lease + TCC host-binary health-check + degrade-to-SKIPPED. Gated on the
  recurring TCC story.
- **L4 — Merge-gate full**: `awaiting-verify` step, loopback with threaded feedback,
  batch-`Mutex` worktree sync, port-pool free-slot probing, per-type timeouts.
  (Folded into MVP per decision #2 if going straight to merge-gate.)
- **L5 — Golden baselines + low-confidence tier**: git-tracked baselines, SSIM
  pre-diff gating the VLM call, "Accept as baseline" commit action, per-project
  judge-call budget caps + cost telemetry.
- **L6 — Verify-Queue panel**: renderer view over `verification_requests`.

### Distinct scope jump — Maestro / mobile (Rung 3)
**Locked decision #4:** ship the backend stub + matrix entry, `simulatorPoolSize:0`
→ inert SKIP. Never the silent-pass path, never the infra burden, until a mobile
deliverable exists.

---

## Open decisions (remaining — recommendations stand unless overridden)

Locked: dev-server ownership = **scheduler** (#8); gate = **merge-gate** (#6);
VLM = **ON + capped + deterministic-first** (#4 cost); Maestro = **stub inert** (#11).

Still defaulting (override anytime):
1. Type precedence — agent-declared highest (rec).
2. Global default — **OFF / opt-in** (rec).
3. Playwright bundling — lazy-install chromium-only (rec; affects packaging).
4. Low-confidence escalation — non-blocking `finding` (rec).
5. Pool sizing — **5 ports** (= `SPRINT_BATCH_CAP`), **0 simulators** (rec).
6. `.cyboflow/verify.json` at project root — yes (rec).

---

## Integration files (absolute)

- `main/src/orchestrator/workflowRegistry.ts` — createRun stamp (resolver imports ~22-24).
- `main/src/orchestrator/substrateResolver.ts` (+ `executionModelResolver.ts`,
  `permissionModeResolver.ts`) — resolver template.
- `main/src/orchestrator/RunQueueRegistry.ts` — no-recursive-enqueue rule (lines 9-13).
- `main/src/utils/mutex.ts` — named-semaphore `acquire` (line 22; singleton line 113).
- `main/src/services/panels/claude/claudeCodeManager.ts` — `composeMcpServers` (~990),
  `composeRunEnv` (~1034), `CYBOFLOW_RUN_ARTIFACTS_DIR` (~1047), `getBaseProjectMcpServers` (~1559).
- `main/src/orchestrator/mcpServer/mcpQueryHandler.ts` — dispatch switch
  (`mcp-report-finding` ~441, `mcp-report-artifact` ~456).
- `main/src/orchestrator/workflows/sprint.md` + `.../sprint/agents/visual-verify.md`
  (+ ship equivalents) — the gated stub to wire.
- `main/src/orchestrator/autoMintArtifacts.ts` — `handleVisualArtifactsScan` safety-net;
  `ArtifactRouter` / `ReviewItemRouter` / `SprintLaneStore` — verdict delivery chokepoints.
- `main/src/types/config.ts` — `AppConfig.visualVerify` (`artifactCommitDir` precedent ~38).
- New: `shared/types/visualVerification.ts`,
  `main/src/orchestrator/visualVerificationResolver.ts`,
  `main/src/orchestrator/verify/verificationScheduler.ts`,
  `main/src/services/visualVerify/{capturePageBackend,playwrightBackend,peekabooBackend,maestroBackend,vlmJudge}.ts`.
