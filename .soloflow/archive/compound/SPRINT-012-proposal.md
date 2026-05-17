---
sprints: [SPRINT-012]
span_label: SPRINT-012
created: "2026-05-16T00:00:00.000Z"
counters_start:
  ideas: 16
summary:
  cleanups: 1
  backlog_tasks: 5
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-012

## A. Clean-up items (execute now)

### A1. Document cross-run read scope and trusted-socket boundary in system design
- **Summary:** Add a `## Trust boundaries` subsection to `docs/cyboflow_system_design.md` documenting that the cyboflow MCP server treats the local Unix socket as a trusted channel, that `mcp-list-pending-approvals` returns approvals across all runs by design, and that `mcp-get-run` accepts any `targetRunId` — preventing a future contributor from mistaking the wide SELECT scope for a missing filter.
- **Source-Sprint:** SPRINT-012
- **Rationale:** The cross-run read scope is intentional and described in tool JSDoc, but absent from the product spec. Without a spec-level note, a future contributor narrowing either query handler's SQL to `WHERE run_id = ?` would break the day-3 review-queue UX. The fix is a few prose sentences — no code changes, zero blast radius.
- **Blast radius:** `docs/cyboflow_system_design.md` only; trivial
- **Source:** FIND-SPRINT-012-17 (sprint-code-reviewer); evidence: `main/src/orchestrator/mcpServer/mcpQueryHandler.ts:116-178` — `handleListPendingApprovals` has no `WHERE run_id = ?` filter; `handleGetRun` accepts any `targetRunId`; `cyboflowMcpServer.ts` tool descriptions say "cross-run review queue" and "by ID" but `docs/cyboflow_system_design.md` has no corresponding trust-boundary section.
- **Proposed change:**
  ```diff
  # In docs/cyboflow_system_design.md, after the existing "## 6. MCP Server"
  # (or the nearest architectural section) add:

  + ## Trust Boundaries
  +
  + **Local Unix socket = trusted channel.** The cyboflow MCP server communicates
  + with the orchestrator exclusively over a Unix domain socket at
  + `CYBOFLOW_ORCH_SOCKET`. There is no authentication on this channel — it is
  + process-local and accessible only to processes that know the socket path (which
  + is injected by the orchestrator at session spawn time). Do not expose this socket
  + over the network or to untrusted processes.
  +
  + **Cross-run read scope is intentional.** `cyboflow_list_pending_approvals`
  + returns approvals across *all* workflow runs (no `WHERE run_id = ?` filter).
  + This is the design: the review queue is workspace-scoped, aggregating every
  + pending approval regardless of which run produced it. Narrowing this SELECT
  + to the caller's own `run_id` would break the day-3 review-queue UX.
  + Similarly, `cyboflow_get_run` accepts any `targetRunId` — a running agent can
  + inspect the status of sibling runs. Do NOT add a run-scoped WHERE clause to
  + either handler without revisiting this product decision.
  +
  + **Checkpoint run_id.** `cyboflow_submit_checkpoint` writes `run_id` from
  + the caller's `CYBOFLOW_RUN_ID` env var. The singleton orchestrator server
  + uses the sentinel value `orchestrator`; see the `## Sentinel run_id` note in
  + `main/src/orchestrator/mcpServer/mcpServerLifecycle.ts` for the FK
  + implication and the resolved handling strategy.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep "Trust\|trust boundar"` against both `docs/cyboflow_system_design.md` and `docs/ARCHITECTURE.md` returns zero hits, and `mcpQueryHandler.ts:116-178` confirms the wide SELECT scope is intentional — a docs-only addition with zero code blast radius preventing a contributor from "fixing" the cross-run query into a regression.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix FK violation: `mcp-submit-checkpoint` inserts `run_id='orchestrator'` against FK-enforced table
- **Summary:** The singleton MCP server's `cyboflow_submit_checkpoint` handler inserts `run_id='orchestrator'` into `raw_events`, which has `FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE` — enforced at runtime via `PRAGMA foreign_keys = ON` in `database.ts:67` — causing a constraint violation and crashing any checkpoint call made through the singleton server.
- **Source-Sprint:** SPRINT-012
- **Source:** FIND-SPRINT-012-16 (sprint-code-reviewer); evidence: `main/src/orchestrator/mcpServer/mcpQueryHandler.ts:195` — `stmt.run(msg.runId, payload, now)` where `msg.runId` is the sentinel `'orchestrator'`; `main/src/database/migrations/006_cyboflow_schema.sql:40` — FK on `raw_events.run_id`; `main/src/database/database.ts:67` — `PRAGMA foreign_keys = ON`; `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:85` — test explicitly sets `foreign_keys = OFF` to work around this.
- **Problem:** `McpServerLifecycle` spawns the subprocess with `CYBOFLOW_RUN_ID=orchestrator` (the sentinel for the singleton side, per `mcpServerLifecycle.ts:41-52`). When that subprocess calls `cyboflow_submit_checkpoint`, `McpQueryHandler.handleSubmitCheckpoint` inserts `run_id='orchestrator'` which has no row in `workflow_runs`. With FK enforcement on, the insert throws `FOREIGN KEY constraint failed`. The test suite disables FK enforcement to allow this path, masking the production failure.
- **Proposed direction:** Two viable fixes: (a) **Reject at the handler level** — `handleSubmitCheckpoint` checks `if (msg.runId === 'orchestrator') { return ok: false, error: 'checkpoint_requires_real_run' }`. This is clean but means the singleton server can never write checkpoints, which may be intentional for the orchestrator role. (b) **Seed a sentinel row** — insert a `workflow_runs` row with `id='orchestrator'` in migration 006 (or in the orchestrator bootstrap) so the FK is satisfied. This allows checkpoint logging from the orchestrator context at the cost of a phantom run in queries. Option (a) is preferred because it makes the constraint explicit and aligns with the intended tool semantics (checkpoints belong to real user runs). Whichever option is chosen: update `mcpQueryHandler.test.ts:85` to re-enable `foreign_keys = ON` and add a test for the rejection/acceptance path.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Evidence triangulated — `migrations/006_cyboflow_schema.sql:40` defines the FK, `database.ts:67` enables `PRAGMA foreign_keys = ON` in prod, `mcpServerLifecycle.ts:44` passes the `'orchestrator'` sentinel to `CYBOFLOW_RUN_ID`, and `mcpQueryHandler.test.ts:85` explicitly sets `foreign_keys = OFF` to mask the failure — this is a latent runtime crash, not theoretical.
- **Counterfactual:** If singleton-server checkpoints were a non-feature (i.e. the orchestrator process is never expected to call `submit_checkpoint`), a simpler doc-only "do not call" note plus the test fix might suffice — but the FK violation should still be made explicit at the handler.

### B2. Resolve redundant dual asar strategy for `cyboflowMcpServer.js` and validate packaged-DMG path
- **Summary:** `cyboflowMcpServer.js` is handled by two independent strategies — an `asarUnpack` glob in `package.json` AND a runtime extract-to-`~/.cyboflow/` in `scriptPath.ts` — with a likely mismatch in the asarUnpack glob that means the runtime extraction runs unconditionally, making the asarUnpack entry dead weight; a packaged-DMG smoke test is needed to verify and pick one strategy.
- **Source-Sprint:** SPRINT-012
- **Source:** FIND-SPRINT-012-6 and FIND-SPRINT-012-12 (both from TASK-454 verifier and sprint-code-reviewer); evidence: `package.json:106` — `"main/dist/orchestrator/mcpServer/**/*.js"` in `asarUnpack`; `main/tsconfig.json` includes from `main/src/`, so tsc output lands at `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js` (extra `main/src/` segment), not `main/dist/orchestrator/mcpServer/cyboflowMcpServer.js`; `main/src/orchestrator/mcpServer/scriptPath.ts:43-58` — extraction runs whenever `app.isPackaged && candidatePath.includes('.asar')`, which is always true in a packaged DMG.
- **Problem:** (1) The asarUnpack glob likely never matches real output, so the `asarUnpack` entry adds a misleading build config entry that may confuse future maintainers. (2) The runtime extraction in `scriptPath.ts` has no memoization — it performs `readFileSync + mkdirSync + writeFileSync + chmodSync` on every call, which fires once per `McpServerLifecycle._spawn()` and once per `composeMcpServers()` call, giving N×4 sync main-thread syscalls for N parallel sessions. (3) Neither the glob correctness nor the packaged execution path has been smoke-tested against a real DMG build (`pnpm build:mac:arm64`).
- **Proposed direction:** Run `pnpm build:mac:arm64` and inspect `Contents/Resources/app.asar.unpacked/` to determine whether the asarUnpack glob matches. If the unpacked directory is absent or the glob path is wrong: (a) either fix the glob to `main/dist/main/src/orchestrator/mcpServer/**/*.js` to match real tsc output, or (b) remove the asarUnpack entry entirely and keep the extract-to-`~/.cyboflow/` runtime path. If keeping runtime extraction, add module-level memoization so extraction only runs once per app launch (addresses FIND-012-13 simultaneously). The standard Electron Builder pattern for option (a) would be `process.resourcesPath + '/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js'` — cleaner than the `~/.cyboflow/` write if the glob can be corrected.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed mismatch — `ls main/dist/orchestrator/mcpServer/` returns "No such file or directory" while `main/dist/main/src/orchestrator/mcpServer/` is the real output path, so `package.json:106` "main/dist/orchestrator/mcpServer/**/*.js" cannot match anything; this folds in FIND-012-13's per-spawn re-extract cost (also confirmed in `scriptPath.ts:43-58` with no memoization) so one task resolves three findings.

### B3. Eager-populate `cachedNodePath` at boot to prevent first-session MCP spawn failure
- **Summary:** `claudeCodeManager.composeMcpServers()` falls back to the bare string `'node'` for the first session because `findNodeExecutable()` is resolved asynchronously via fire-and-forget, causing the first spawned Claude session to inject a broken MCP server entry in environments (packaged DMG, nvm/asdf without shell PATH enrichment) where `node` is not on the default PATH.
- **Source-Sprint:** SPRINT-012
- **Source:** FIND-SPRINT-012-5 (TASK-454 verifier) and FIND-SPRINT-012-15 (sprint-code-reviewer); evidence: `main/src/services/panels/claude/claudeCodeManager.ts:432-455` — `const nodeCmd = this.cachedNodePath ?? 'node'` then `void findNodeExecutable().then(...)` fires off without being awaited; on the first call `this.cachedNodePath` is `undefined`, so Claude Code receives `command: 'node'` in the `.mcp.json` entry, which fails in packaged DMGs where no `node` is on PATH.
- **Problem:** The fire-and-forget caching pattern races with the first session spawn. The `setOrchSocketPath()` setter is the one deterministic boot moment where the orchestrator socket is known before any session starts — populating `cachedNodePath` there eliminates the race entirely. The TASK-454 done report (`findings remaining open: FIND-SPRINT-012-5`) explicitly called this out as "eager population via setOrchSocketPath is a cleaner TASK-455 hook."
- **Proposed direction:** In `ClaudeCodeManager.setOrchSocketPath()`, immediately kick off `findNodeExecutable()` and store the resulting promise in a field; in `composeMcpServers()`, `await` that field if it is still pending (or `buildSdkOptions`, which already returns a `Promise`, can propagate the await chain). If `findNodeExecutable()` rejects (no node found), log a warning and skip the cyboflow MCP entry entirely — failing loudly is better than injecting a broken `command: 'node'` entry. Remove the existing fire-and-forget block in `composeMcpServers()`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `claudeCodeManager.ts:438-445` confirms the exact race — `nodeCmd = this.cachedNodePath ?? 'node'` with `void findNodeExecutable().then(...)` fire-and-forget, and the same defect surfaced from two independent reviewers (TASK-454 verifier FIND-5 and sprint-code-reviewer FIND-15), so the first packaged-DMG session reliably gets a broken `command: 'node'` entry.

### B4. Unify `OrchestratorHealth` singleton injection and extract shared `HEALTH_STARTING` constant
- **Summary:** The `OrchestratorHealth` singleton is injected via two independent module-level setters — `setCyboflowHealth()` in `main/src/ipc/cyboflow.ts` and `setHealthProvider()` in `main/src/orchestrator/trpc/routers/health.ts` — each with its own `HEALTH_STARTING` fallback constant, requiring the bootstrap caller to call both setters or risk IPC and tRPC returning divergent health snapshots.
- **Source-Sprint:** SPRINT-012
- **Source:** FIND-SPRINT-012-11 (sprint-code-reviewer); evidence: `main/src/ipc/cyboflow.ts:43-55` — `let _orchestratorHealth` + `const HEALTH_STARTING = { status: 'starting', restartAttempts: 0 }`; `main/src/orchestrator/trpc/routers/health.ts:20-29` — `let _health` + inline `{ status: 'starting' as const, restartAttempts: 0 }` in the procedure fallback. `shared/types/mcpHealth.ts` defines the canonical `McpServerHealth` type but no shared constant for the starting default.
- **Problem:** Any future change to the starting-state shape (e.g. adding a new field) must be made in two places. More critically, the bootstrap in `main/src/index.ts` must know to call both setters — if only `setCyboflowHealth` is wired, tRPC returns stale yellow forever; if only `setHealthProvider` is wired, the IPC channel returns stale yellow. Neither has a runtime warning to detect the missed call.
- **Proposed direction:** (a) Export a `HEALTH_STARTING` constant from `shared/types/mcpHealth.ts` so both modules import the same default. (b) Pick one injection point: the cleanest is to construct `OrchestratorHealth` in `main/src/index.ts` and pass it to a single `setOrchestratorHealth(h)` function in `main/src/ipc/cyboflow.ts` that immediately calls `setHealthProvider(h)` on the tRPC router, keeping the two consumers in sync from one call site. Alternatively, push `OrchestratorHealth` into `AppServices` and have both consumers read from `services` — this aligns with the existing `WorkflowRegistry`/`RunLauncher` pattern in `cyboflow.ts`. Either way, document the chosen approach in `docs/CODE-PATTERNS.md` (see C1 below).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Both setters confirmed at `ipc/cyboflow.ts:43,53` and `trpc/routers/health.ts:20,27` with duplicate `{ status: 'starting', restartAttempts: 0 }` fallbacks, and `mcpHealth.ts` defines the type but not the constant — the divergence risk is real, though severity is currently "silent" since neither setter is wired at boot yet, making this best done jointly with the bootstrap wiring task rather than in isolation.
- **Counterfactual:** If the bootstrap wiring is imminent in a near-term sprint, folding both changes into that wiring task is cleaner than landing B4 standalone; otherwise the dual-setter trap will bite during integration.

### B5. Extract `executeMcpQuery` helper in `cyboflowMcpServer.ts` to eliminate three-way duplicate scaffolding
- **Summary:** The three `CallToolRequestSchema` case branches in `cyboflowMcpServer.ts:181-282` each duplicate the same ~9-line response-handling scaffold (sendQuery → unchecked cast → ok-check → content wrap → catch → error content), and the `as { ok: boolean; ... }` cast is unchecked, meaning a malformed orchestrator response silently yields `{}` to Claude.
- **Source-Sprint:** SPRINT-012
- **Source:** FIND-SPRINT-012-1 (TASK-453 code-reviewer, carried in TASK-454-done.md); evidence: `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts:184-200`, `216-232`, `258-276` — three near-identical try/catch blocks each casting the response as `{ ok: boolean; data?: unknown; error?: string }` and constructing `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
- **Problem:** The code-reviewer flagged this as "worth doing before any 4th tool is added." The unchecked cast is a latent correctness issue: if the orchestrator ever sends a response without `ok`, `resp.error` is `undefined`, `JSON.stringify({ error: undefined })` produces `{}`, and Claude receives an empty error object with no diagnostic information.
- **Proposed direction:** Extract `async function executeMcpQuery(type: string, params: Record<string, unknown>): Promise<CallToolResult>` that: (1) calls `await sendQuery(type, params)`, (2) performs a runtime type-guard on the response object (check `typeof response === 'object' && response !== null && 'ok' in response`), (3) branches on `ok` to return data or error content, and (4) catches/converts thrown errors. Each case branch in the switch becomes the arg-guard + `return executeMcpQuery(type, params)`. This eliminates 18 lines of duplication and ensures malformed orchestrator responses produce a meaningful error string, not `{}`. The 30s timeout logic in `sendQuery()` already handles the timeout path; no changes needed there.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Three near-identical blocks confirmed at `cyboflowMcpServer.ts:184-200, 216-232, 258-276` with the unchecked `as { ok: boolean; ... }` cast in each, and the latent `JSON.stringify({ error: undefined }) === '{}'` correctness bug is real — proportionality holds because it's a single-file extraction with no new abstraction surface, and the code-reviewer explicitly flagged "before any 4th tool is added."
- **Counterfactual:** If v1 is genuinely frozen at 3 tools and the malformed-response branch is provably unreachable (orchestrator-side handler always sets `ok`), the duplication alone wouldn't clear the bar — but the unchecked-cast correctness concern carries it.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document tRPC router dependency-injection pattern — when to use module-level singleton vs. ctx/factory
- **Summary:** Add a `### tRPC router dependency injection` entry to `docs/CODE-PATTERNS.md` documenting the two patterns now in use (module-level singleton setter vs. `throwNotImplemented` stub), when each is appropriate, and what the migration path looks like — preventing future routers from choosing arbitrarily between the two.
- **Source-Sprint:** SPRINT-012
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after `### Database access` (within `## Recurring Patterns`)
- **Status:** ready
- **source_item:** C1
- **Rationale:** FIND-SPRINT-012-14; TASK-455 introduced `let _health + setHealthProvider()` in `main/src/orchestrator/trpc/routers/health.ts`, diverging from the `throwNotImplemented` stub pattern used by sibling routers. Multi-consumer guidance dropped — that's B4's territory; doc it here once B4 lands.
- **Proposed change:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ ## Recurring Patterns
   `main/src/services/database.ts` is the singleton. All mutations go through the main process —
   the renderer never accesses SQLite directly. SQL is hand-written (no ORM); use parameterized
   queries. Migrations are plain `.sql` files in `main/src/database/migrations/`, named to sort
   in application order.
  +
  +### tRPC router dependency injection
  +
  +Two patterns coexist in `main/src/orchestrator/trpc/routers/`:
  +
  +- **Stateless stub** (`runs.ts`, `approvals.ts`, `workflows.ts`, `events.ts`): procedure body
  +  calls `throwNotImplemented()`. No module-level state. Use this until the router needs to
  +  reach a real singleton.
  +- **Module-level setter** (`health.ts`): `let _x: T | null = null` + an exported `setX(x)`
  +  called once from `main/src/index.ts` at boot. Use when the router wraps a live singleton.
  +
  +Don't mix the two in one router — when a stub gains state, migrate it fully in one task.
  +Long-term target is `ctx`-injected state via `createContext()` in `trpc.ts`; the setter
  +pattern is the interim.
   
   ### `@cyboflow-hidden` annotation
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The proposed rule itself admits "long-term target is `ctx`-injected state via `createContext()` in `trpc.ts`; the setter pattern is the interim" — and the orchestrator-and-trpc-router epic has ~14 in-flight task plans (251-255, 586, 598-608) that will likely obsolete this guidance, so codifying an interim pattern now risks rule drift before any future agent benefits; also the two-pattern dichotomy is already incomplete (`events.ts` uses a third pattern — module-level `EventEmitter` singleton — neither listed).
- **Counterfactual:** If the orchestrator epic is paused or deferred beyond the next ~3 sprints, documenting the interim convention becomes worthwhile — but at that point the rule should reflect all three patterns currently in `routers/`, not just the two.

---

## Reconciled Findings (informational)

No stale-open findings found. The 10 findings with `status: open` in `SPRINT-012-findings.md` have no `**Findings resolved:**` claims in any of the five done reports. FIND-1, FIND-5, and FIND-6 are mentioned in TASK-454-done.md as "remaining open / queued for compound" — consistent with their open status.
