<!-- Produced 2026-07-03 by a multi-agent design workflow (5 readers / 3 designers / 3 judges / 1 synthesis). Status: PROPOSED, not yet implemented. -->

# CI Gate + Mocked-SDK Integration Suite — Final Recommendation

## Decision summary

**Chosen mock strategy (3 sentences).** We build one shared, *typed* fake-SDK fixture module (`main/src/test/fakes/fakeSdk.ts`) whose event builders extend the existing production builders in `main/src/orchestrator/programmatic/syntheticEvents.ts`, end in `satisfies SDKMessage` against `@anthropic-ai/claude-agent-sdk`'s own exported types, and drive the *real* `RunExecutor → ClaudeCodeManager → query() → McpQueryHandler → TaskChangeRouter/ReviewItemRouter → raw_events` chain through a module-level `vi.mock('@anthropic-ai/claude-agent-sdk')` — nothing below the SDK call is faked. This is packaged as a four-tier cost-per-signal pyramid: a compile-time + narrow-time contract test (near-free, in `test:unit`), the existing per-file SDK mocks re-pointed at the shared module, fast in-process chokepoint tests folded into `test:unit`, and a small headless-orchestrator tier that becomes a new blocking CI job.

**Why the alternatives lost.** *Recorded-replay* has the highest raw fidelity (true pre-narrow wire bytes) but its primary artifact is opaque JSONL that fights the repo's grain — the codebase already has typed builders and a Zod narrowing layer, and replay's scrubbing/consistent-id-map is a heavy, error-prone maintenance surface (a blind id-replace silently breaks `tool_use ↔ tool_result` pairing). *Pure scripted-fake* has the cleanest single seam and the best authoring ergonomics, but it stops at the `sdk` substrate and leaves the entity-model chokepoints, dual-substrate parity, and CI economics as an afterthought. The layered pyramid subsumes scripted-fake's best mechanism (typed `satisfies SDKMessage` builders as a free drift gate) and grafts replay's nightly behavioral-drift backstop, while being the only design that gives the currently-uncovered concurrent-runs / out-of-order-approval / resume-and-stream path a deterministic PR gate.

---

## Where we are today (verified against the repo)

- The **only** blocking gate is `.github/workflows/quality.yml`: job `quality-checks` (typecheck + lint) → job `test` (install → `pnpm rebuild better-sqlite3` → `pnpm test:unit`, `timeout-minutes: 10`) → four report-only coverage steps (`if: always()`, `continue-on-error`, each `timeout-minutes: 10`) that roughly double the job's wall-clock envelope while gating nothing.
- `pnpm test:unit` chains `main` vitest → `frontend` vitest → `verify:schema` → two node script tests → `test:build`. It never invokes Playwright, `test:gate`, or `smoke:sdk`.
- The one test that wires real orchestration end-to-end, `main/src/orchestrator/__tests__/cyboflowDayGate.test.ts` (via `tests/helpers/cyboflowTestHarness.ts`), calls the **real** `query()` (`cyboflowTestHarness.ts:13` import, `:176` call site) against a live `claude` CLI. It self-skips without `claude` on PATH and runs in **no** CI workflow.
- Production has exactly **one** workflow-run SDK call: `main/src/services/panels/claude/claudeCodeManager.ts:4` (import), `:859` (`const q = query({ prompt, options: { ...activeOptions, abortController } })`). The two other importers — `monitorQuery.ts:27` and `evalJudgeQuery.ts:27` — are already DI-clean.
- Three test files hand-roll their own `vi.mock('@anthropic-ai/claude-agent-sdk')` with divergent helper shapes; there is no shared fake.
- `GATE_SCHEMA` (`main/src/database/__test_fixtures__/registrySchema.ts:39`) has **confirmed drifted**: its `workflow_runs` table lacks `substrate`, `execution_model`, `model`, `eval_enabled`, `session_id`, and `spec_hash` — all of which `WorkflowRegistry.createRun`'s INSERT writes — and `scripts/verify-schema-parity.js` explicitly excludes it (lines 15–19).
- `main/src/__tests__/dualSubstrateIntegration.test.ts` and `main/src/orchestrator/programmatic/__tests__/programmaticIntegration.test.ts` already establish the "real collaborators over a migration-backed DB, fake at one seam" precedent — but neither invokes `RunExecutor.execute()` with a real `ClaudeCodeManager` beneath it.

---

## The mock strategy in detail

**Core seam — no production refactor required.** We mock at the module level: `vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: makeFakeQuery(...) }))`, exactly the proven pattern at `claudeCodeManagerWiring.test.ts:66-76`. This leaves `ClaudeCodeManager`, `RunExecutor`, `SubstrateDispatchFacade`, `WorkflowRegistry`, the two chokepoints, `ApprovalRouter`/`QuestionRouter`, `TypedEventNarrowing → RawEventsSink → raw_events`, and `runEventBridge` all **real**. (Because `monitorQuery.ts`/`evalJudgeQuery.ts` are already DI-clean via `StructuredQueryFn`/`EvalStructuredQueryFn`, those paths take an injected fake fn and need no module mock at all.)

**Shared fixture module — `main/src/test/fakes/fakeSdk.ts`.** It exports:
1. Typed event builders extending `syntheticEvents.ts` to the full catalog the ad-hoc mocks currently hand-type as `unknown`: `systemInit`, `assistantText`, `assistantToolUse`, `userToolResult`, `permissionDenied`, `resultSuccess`, `resultError`. **Every builder ends `satisfies SDKMessage`** and lives under `main/src`, so an `@anthropic-ai/claude-agent-sdk` bump that changes message shapes fails the **existing** `pnpm typecheck` gate for free (grafted from scripted-fake — the single cheapest drift signal available).
2. A fluent `scenario()` DSL (grafted from scripted-fake) — `.systemInit().assistantText('…').toolUse('cyboflow_create_task', {…}).requestPermission('Bash', {…}).resultSuccess({usage})` — compiling to `(options) => AsyncGenerator<SDKMessage>`. `requestPermission` **invokes the real `options.canUseTool` callback and awaits it**, reproducing the SDK's pause/resume so the real `ApprovalRouter.requestApproval` path executes; each exposes a `Deferred` the harness resolves out-of-band (approve/reject) — deterministic, no sleeps.
3. `makeFakeQuery`, `makeRejectingQuery`, `makeThenRejectQuery` (error paths), plus an options-capture handle to assert on `buildSdkOptions` output.
4. A **runId-keyed scenario registry** (grafted from scripted-fake) keyed off `options.env.CYBOFLOW_RUN_ID`, which `ClaudeCodeManager` already stamps — one module mock serves concurrent planner+sprint runs.

**Built-in honesty check.** Because fake events flow through the real `TypedEventNarrowing` (`typedEventNarrowing.ts:30`, fail-soft to `{kind:'__unknown__'}`), every integration test asserts **zero `__unknown__` `raw_events` rows** for well-formed steps. Combined with compile-time `satisfies SDKMessage`, a malformed fake fails loudly at both compile and run time.

**DB truth: migration-replay, not GATE_SCHEMA.** All new integration tests build the DB via the real 42-file migration chain (`DatabaseService` + `withTempDir()`, the `fullChainContinuity.test.ts`/`programmaticIntegration.test.ts` pattern), wrapped in `dbAdapter()`. This eliminates the GATE_SCHEMA drift class outright and re-anchors onto the current entity-model/review-queue tables (migrations 015/016).

---

## CI changes (concrete)

**1. Extract and harden the better-sqlite3 ABI flip.** Add `scripts/rebuild-better-sqlite3-host.mjs` that runs the rebuild **then asserts** `new Database(':memory:')` opens and logs `NODE_MODULE_VERSION`, exiting non-zero on a stale/arch-mismatched `.node`. This closes the silent-flip gap (confirmed live in this environment: a stale x86_64 `better_sqlite3.node` dlopen-failed until a source rebuild was forced). Wire it as a shared step before both DB-touching jobs, replacing the bare `pnpm rebuild better-sqlite3` inline step.

**2. Keep `test` job running `pnpm test:unit`**, now including Tiers 0–2 (contract + chokepoint tests are node-env, Electron-free, sub-second — budget < 30s added).

**3. Add a new blocking job `integration`** (`needs: quality-checks`, `ubuntu-latest`, headless) running `pnpm test:integration` → `vitest run --config vitest.config.integration.ts` (node env; include `main/src/orchestrator/__tests__/integration/**`; `pool:'forks'`, `poolOptions.forks.singleFork:true`; `testTimeout: 120000`; setupFiles = `main/src/test/setup.ts` + a new `integration.setup.ts` that installs the fake-SDK mock and `_resetForTesting()`s every singleton in `beforeEach`/`afterEach`). It runs **in parallel** with `test` (both only need `quality-checks`), so PR critical-path wall-clock stays flat at `max(test, integration)`, not their sum. `timeout-minutes: 8`, target ≤ 3–4 min.

**4. Move report-only coverage off the PR critical path** — to its own `coverage` job (`needs: test`, `if: always()`) or restrict to push-to-main + `workflow_dispatch`. This reclaims the wall-clock the four `always()` steps currently burn for zero gating value.

**5. Nightly drift canaries in `e2e.yml`** (macOS, `continue-on-error`, gated on `claude` on PATH + repo secret): (a) re-scope the real-API `test:gate` from "manual/never" to a nightly **wire-shape canary**; (b) add `smoke:sdk` as a **protocol canary** (catches *when* `canUseTool` fires / event reordering the typed builders cannot); (c) add a **re-record-and-diff** step (grafted from replay) that captures a fresh scrubbed transcript from a real `test:gate` run and structurally diffs it against a committed reference — the only mechanism that catches new event kinds / callback-ordering drift. All report-only; a diff uploads a candidate artifact for a human to promote.

**6. Flake-quarantine policy** (grafted from layered-pyramid, mirroring `e2e.yml`'s existing "green twice" convention): a `*.quarantine.test.ts` convention excluded from blocking configs and run in a report-only `flake-watch` job; a test that fails twice on unrelated PRs is quarantined within 24h with a tracking task, fixed/deleted within a week, and promoted back after two consecutive green nightlies.

---

## Highest-value integration test scenarios

**Tier 0 — contract (`main/src/test/fakes/__tests__/sdkContract.test.ts`, in `test:unit`):**
- Every `fakeSdk.ts` builder is assignable to the real `SDKMessage` union (compile-time) **and** survives `TypedEventNarrowing.narrow()` without a `__unknown__` fallback (runtime).
- A committed `@anthropic-ai/claude-agent-sdk` version + discriminant snapshot fails loudly with a "regenerate against SDK vX" message on a bump beyond `^0.2.141`.

**Tier 2 — chokepoint/router (`main/src/orchestrator/__tests__/integration/`, in `test:unit`), driving `McpQueryHandler.handleMessage()` directly over a migration-replay DB:**
- `cyboflow_create_task` then `cyboflow_set_task_stage` → assert `TaskChangeRouter` wrote `ideas/tasks` + `entity_events` deltas and no direct-table UPDATE bypassed the chokepoint.
- `cyboflow_report_finding` → `review_items(kind=finding)`; `cyboflow_resolve_finding` resolves + emits `ReviewItemChangedEvent`.
- Q1 plan-gate: planner creates pending/invisible task drafts, approve-plan reveals them (`approved_at` PENDING→VISIBLE); rejection triggers `deleteRunCreatedEntities` sweep.
- `cyboflow_create_sprint_batch` fans out a DAG through `SprintLaneStore` → assert `task_dependencies` + lane rows.

**Tier 3 — headless orchestrator (new `integration` job), real `RunExecutor` + real `ClaudeCodeManager`, `query()` mocked, real temp `git init` worktree:**
- **Concurrent planner+sprint, approved out of order** — approve the *second* run first, then the first; both resume, stream further events, and rest in `awaiting_review`. This is the exact `cyboflowDayGate.test.ts` scenario, now deterministic and CI-safe — the flagship win.
- Happy path: `raw_events` row count == scripted event count, `workflow_runs.status` running→awaiting_review, and `selectRunUnifiedMessages` re-projects the same `UnifiedMessage[]` the live `cyboflow:stream` envelopes carry (asserted via a spy `StreamEventPublisher`).
- Permission `ask` verdict → real `makeCanUseTool` → `ApprovalRouter.requestApproval` co-writes `approvals` + `workflow_runs` + `review_items(kind=permission,blocking=1)` in one txn; `respond('allow')` resolves and the run resumes. Deny variant: run rests without applying the tool.
- Model-availability fallback: scripted SDK error marks the model unavailable (`ModelAvailabilityService`) and retries on Opus; assert singleton state resets between cases.
- Terminal-error propagation: `makeThenRejectQuery()` mid-stream → `RunExecutor` transitions to failed and persists already-streamed `raw_events`.
- Programmatic `execution_model`: `WorkflowController` DAG walk with `SpawnStepRunner` on the fake query → `ReviewQueueHumanGate → HumanStepManager` writes `review_items(kind=human_task)` and `current_step_id` advances.
- Crash-safe resume: strand a programmatic run mid-walk, run `runRecovery.recoverActiveStateOrphans`, re-drive via `setPendingResumeStep`/`setPendingCompletedSteps` to a clean rest.
- Dual-substrate parity: `SubstrateDispatchFacade` with a real `ClaudeCodeManager` (mocked query) as `sdkManager` and the canonical `FakePty`/`FakeTranscriptSource` `InteractiveClaudeManager` — assert byte-identical `StreamEnvelope` shape + equal `raw_events` count across substrates (extends `dualSubstrateIntegration.test.ts` to actually invoke `RunExecutor.execute()`).
- Cost fold: `result.usage` → `run_usage.cost_usd` is the SDK `total_cost_usd` **verbatim** (per the run-cost source-of-truth invariant), not recomputed.

**Single opt-in canary (not a broad tier):** spawn the real `cyboflowMcpServer.ts` child process against a live `OrchSocketServer` on a temp Unix socket and round-trip one `cyboflow_report_step` — the socket/framing transport the in-process handler skips.

---

## Phased milestone plan (each ships independently)

- **M1 — shared fake, zero CI change.** Build `fakeSdk.ts` (typed builders `satisfies SDKMessage` + `scenario()` DSL + `makeFakeQuery`/reject variants + runId registry). Refactor `claudeCodeManagerWiring.test.ts`, `monitorQuery.test.ts`, `evalJudgeQuery.test.ts` onto it. Green suite = drop-in parity proof; kills the 3-way duplication immediately.
- **M2 — contract keystone.** Add `sdkContract.test.ts` (assignability + narrow-acceptance + version/discriminant pin), folded into `test:unit`. The anti-drift keystone; land before anything depends on the fakes for a gate.
- **M3 — harden the ABI seam.** `scripts/rebuild-better-sqlite3-host.mjs` with the post-rebuild `:memory:` smoke assertion; replace the bare rebuild step in `quality.yml`. De-risks every DB-touching tier downstream.
- **M4 — Tier 2 chokepoint tests** over migration-replay DB, folded into `test:unit`. First real coverage of the entity-model/review-queue chokepoints the old gate harness never touched.
- **M5 — kill GATE_SCHEMA drift + injectable harness.** Switch `cyboflowTestHarness.ts` off GATE_SCHEMA to migration-replay and inject `query` as a factory param (default = real SDK). Add GATE_SCHEMA to `verify-schema-parity.js` scope or delete it.
- **M6 — Tier 3 headless gate.** `headlessRun` + mocked day-3 gate (concurrent/out-of-order/resume), `vitest.config.integration.ts`, `pnpm test:integration`, and the new **parallel blocking `integration` job**. This is the milestone that moves the uncovered path onto the PR gate.
- **M7 — CI economics + drift canaries.** Move coverage off the critical path; wire `test:gate` + `smoke:sdk` + the nightly re-record-and-diff into `e2e.yml`; add the `flake-watch` quarantine job. Optional M8: real-subprocess MCP-over-socket canary.

---

## Risks (honest)

- **SDK-version drift is the central hazard, defended in three layers of decreasing cost.** (1) `satisfies SDKMessage` + `pnpm typecheck` catches *shape* changes on every PR for free. (2) `TypedEventNarrowing` acceptance catches Zod-schema drift at runtime. (3) The nightly re-record-and-diff + `smoke:sdk` canaries catch **behavioral/protocol** drift — *when* `canUseTool` fires, hook ordering, new event kinds — that no typecheck or narrow-check can see. The gap that remains: a semantically-changed-yet-type-valid payload (a new field the app reads but Zod treats as optional) can stay green until a canary catches it. This is inherent to any hand-authored fake and must be stated so nobody over-trusts a green gate.
- **Fakes test the pipeline, not model correctness.** A green integration gate proves plumbing (`RunExecutor → narrowing → raw_events → chokepoints`) is correct for a realistic stream shape; it does **not** prove the agent behaves well. Keep `test:gate` as a nightly canary; do not delete it.
- **Behavioral-drift detection depends on the nightly macOS runner staying authenticated** (`claude` on PATH + creds) — the same fragility that keeps `test:gate` out of CI today. If auth lapses, protocol drift goes undetected silently. Mitigation: alert on canary-skipped nights.
- **Process-wide singletons** (`ApprovalRouter`, `QuestionRouter`, `ReviewItemRouter`, `TaskChangeRouter`, `ModelAvailabilityService`, `SprintLaneStore`) force `singleFork` serialization and carry `_resetForTesting()` hooks of varying completeness — a missed reset surfaces as an order-dependent flake. This caps parallelism and makes Tier 3 the wall-clock long pole; the quarantine policy exists to absorb the residual.
- **The `canUseTool` interleave is the most fragile component** — the fake must invoke the real callback and await it. Kept event/promise-driven (no sleeps) to avoid flake, but its fidelity to real SDK ordering is only validated by the nightly diff.
- **better-sqlite3 ABI flip stays structurally fragile.** The smoke assertion catches a broken flip loudly but does not auto-fix; a Node/Electron bump can still red the gate until someone reruns `electron:rebuild`. The migration-replay temp-file DBs make this tier *more* ABI-sensitive than the `:memory:` unit tests.
- **Scope.** Eight milestones is the broadest of the three designs. Mitigated by strict independent shippability — M1 alone (dedup) lands value even if the gate never ships — but `fakeSdk.ts` becomes a single shared contract whose sloppy edit can red-cascade the SDK-touching suite; treat it as a contract, not a scratch fixture.

---

## Flake quarantine

**Convention.** A test that must be pulled out of a *blocking* suite is renamed to the `*.quarantine.test.ts` (unit/`test:unit`) or `*.quarantine.itest.ts` (integration/`test:integration`) suffix. The blocking vitest configs exclude both patterns, so the rename is the only edit needed to remove a flaky test from the PR critical path:

- `main/vitest.config.ts` — `exclude` adds `**/*.quarantine.test.ts`.
- `frontend/vitest.config.ts` — `exclude` = `[...configDefaults.exclude, '**/*.quarantine.test.ts']` (frontend previously relied on vitest's default exclude, so the defaults are spread back in).
- `vitest.config.integration.ts` — `exclude` = `[...configDefaults.exclude, '**/*.quarantine.itest.ts']` (its `include` is `main/src/**/*.itest.ts`, which would otherwise re-collect a quarantined file).

**Report-only runner.** `e2e.yml`'s `flake-watch` job (macOS, nightly, no `continue-on-error` needed at job level — the run step is best-effort) `find`s any `*.quarantine.test.ts` / `*.quarantine.itest.ts` under `main`/`frontend`, exits 0 with a `::notice::` when there are none, and otherwise runs them via `pnpm exec vitest run <files>`. It never blocks; it exists to keep quarantined tests visible and to gather the two-green-nightlies signal for promotion.

**Policy** (mirrors `e2e.yml`'s existing "green twice" promotion convention):

1. **Quarantine within 24h.** A test that fails twice on *unrelated* PRs (i.e. the failure is not caused by the PR's own change) is renamed to the `*.quarantine.*` suffix within 24 hours, with a tracking task filed. This removes it from the blocking gate immediately so it stops taxing every unrelated PR.
2. **Fix within one week.** The tracking task carries a one-week SLA to root-cause and fix (or delete) the test. A quarantined test is not a permanent parking spot — an unfixable test is deleted, not left to rot.
3. **Promote back after two green nightlies.** Once fixed, the test is promoted back into the blocking suite (drop the `.quarantine` suffix) only after it has run green in the `flake-watch` job on **two consecutive nightlies** — the same bar `e2e.yml` uses before flipping the smoke tier to blocking.

---

## Follow-ups (recorded during implementation + review, 2026-07-03)

- **Tier-3 write-side lifecycle coverage.** The `headlessRun` harness mirrors the M5 day-gate harness: it drives the injected `query()` through its own spawn loop, writing `workflow_runs.status` transitions and `raw_events` rows itself. The REAL code exercised per scenario is: WorkflowRegistry/RunLauncher run creation, ApprovalRouter/ReviewItemRouter co-writes, chokepoint routers, `ModelAvailabilityService`, `rollupRunUsage`, `WorkflowController`/`recoverActiveStateOrphans` (programmatic scenarios), and the full `TypedEventNarrowing`+`MessageProjection` read pipeline. NOT exercised: `RunExecutor.execute()`'s terminal seam and `RawEventsSink` write-side persistence (only `substrateParity.itest.ts` invokes a `RunExecutor` subclass, with stand-in managers; `modelFallback.itest.ts` constructs the real `ClaudeCodeManager` under a module mock). A follow-up milestone should extend the harness to run the real `RunExecutor` + `ClaudeCodeManager` beneath the fake query so status/count assertions in `happyPath`/`terminalError` stop round-tripping harness-written state.
- **Re-record-and-diff canary** — TODO comment in `e2e.yml`; needs recorder/scrubber tooling (consistent-id map preserving `tool_use`↔`tool_result` pairing).
- **M8 MCP-over-socket subprocess canary** — deferred as planned.
- **headlessRun `makeCanUseTool` divergences** (recorded, accepted): no `isToolAllowed` allowlist fast-path; swallows non-`RunNotRunningError` errors where production rethrows. Fold in if the harness gains real-`ClaudeCodeManager` mode.
