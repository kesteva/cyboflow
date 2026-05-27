---
sprints: [SPRINT-041]
span_label: SPRINT-041
created: "2026-05-27T00:00:00.000Z"
counters_start:
  ideas: 24
summary:
  cleanups: 3
  backlog_tasks: 3
  claude_md: 0
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-041

## A. Clean-up items (execute now)

### A1. Fix stale JSDoc in `sessions:create-quick` IPC handler
- **Summary:** A comment in `main/src/ipc/session.ts:312` incorrectly says the INSERT omits `run_id`; TASK-754 added the column to the INSERT list, so the comment's stated mechanism is wrong.
- **Source-Sprint:** SPRINT-041
- **Rationale:** The comment directly contradicts the code a maintainer would read when auditing the quick-session no-runId invariant. TASK-754 left it unpatched because `session.ts` was in `files_readonly`; it is now the only stale artefact from that task.
- **Blast radius:** `main/src/ipc/session.ts` — one comment line. Trivial; zero runtime risk.
- **Source:** FIND-SPRINT-041-1 (TASK-754 verifier); TASK-754-done.md Findings section.
- **Proposed change:**

  At `main/src/ipc/session.ts:312`, replace note (c) in the JSDoc:

  ```diff
  - // (c) db.createSession omits `run_id` from its INSERT column list, so the row
  - //     naturally gets `run_id = NULL` via TASK-743's migration default.
  + // (c) SessionManager.createSessionWithId intentionally omits `run_id` from its
  + //     `sessionData` literal, so `db.createSession` binds null and the row gets
  + //     `run_id = NULL`. See the comment above the `sessionData` literal in
  + //     `sessionManager.ts:353-356`.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at main/src/database/database.ts:2069 — the `INSERT INTO sessions (...)` column list now includes `run_id` with `data.run_id ?? null` bound at line 2088, directly contradicting the stale JSDoc at main/src/ipc/session.ts:312; the corrected text matches the actual mechanism in sessionManager.ts:353-376.

---

### A2. Replace `require('better-sqlite3')` IIFEs with a top-of-file import and shared helper in the new run-id test
- **Summary:** Two nearly-identical `require('better-sqlite3')` IIFEs in `sessionManagerRunIdMapping.test.ts` diverge from the sibling test pattern and add two unnecessary `eslint-disable` suppressions.
- **Source-Sprint:** SPRINT-041
- **Rationale:** The TASK-754 plan explicitly cited `cyboflowSchema.test.ts:737-742` as the mirror pattern (top-of-file `import Database from 'better-sqlite3'`); the executor used an IIFE instead. The two raw-DB seeding sequences (open → INSERT projects row → close) are 4-line duplicates across Case A and Case B; a small local helper eliminates the redundancy and removes both eslint-disable comments in one move.
- **Blast radius:** `main/src/services/__tests__/sessionManagerRunIdMapping.test.ts` — test file only. Low; no production code touched.
- **Source:** FIND-SPRINT-041-2 (TASK-754 code-reviewer); TASK-754-done.md Findings section.
- **Proposed change:**

  At the top of `main/src/services/__tests__/sessionManagerRunIdMapping.test.ts`, replace the per-IIFE `require` blocks with a shared import and helper:

  ```diff
  + import Database from 'better-sqlite3';
  +
  + /** Open a raw DB at dbPath, seed a projects row, then close. */
  + function seedProject(dbPath: string): void {
  +   const raw = new Database(dbPath);
  +   raw.exec(`INSERT INTO projects (id, name, path) VALUES ('proj-001', 'test', '/tmp')`);
  +   raw.close();
  + }
  ```

  Then remove the two `eslint-disable @typescript-eslint/no-require-imports` comments and the two IIFE blocks in Cases A and B, replacing each with a call to `seedProject(dbPath)`.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at main/src/services/__tests__/sessionManagerRunIdMapping.test.ts:159-163 + 207-211 that the IIFE+eslint-disable pattern is present and the cited mirror file main/src/database/__tests__/cyboflowSchema.test.ts:24 uses the top-of-file `import Database from 'better-sqlite3'` form — note that the implementer must use the actual schema (`(name, path, active)` + read-back `project.id`), not the placeholder columns in the proposed diff.
- **Counterfactual:** The proposed `seedProject` helper signature must accommodate returning the inserted project id (or use a fixed id with a deterministic schema), otherwise Cases A/B cannot bind `project_id` for the subsequent `createSession` call.

---

### A3. Move the ResizeObserver shim into the shared frontend test setup
- **Summary:** An identical 12-line `ResizeObserver` shim is copy-pasted into three test files created or touched by TASK-780; moving it to the existing `frontend/src/test/setup.ts` eliminates the triplication.
- **Source-Sprint:** SPRINT-041
- **Rationale:** `frontend/src/test/setup.ts` already hosts the global tRPC stub and `afterEach` cleanup and is the canonical home for jsdom polyfills in this repo. Each of the three test files that touched it in TASK-780 (`CyboflowRoot.test.tsx:23-34`, `RunRightRail.test.tsx:17-28`, `WorkflowCanvas.test.tsx:16-27`) carries an identical copy. TASK-780-done.md explicitly noted the triplication but deferred to the compounder. Verify: `grep -rn "global.ResizeObserver = vi.fn" frontend/src` should return 0 hits outside `setup.ts` after the move.
- **Blast radius:** `frontend/src/test/setup.ts` + three test files. Low; purely test infrastructure.
- **Source:** FIND-SPRINT-041-10 (SPRINT-041 sprint-code-reviewer); TASK-780-done.md ("code-reviewer noted … ResizeObserver shim triplicated").
- **Proposed change:**

  In `frontend/src/test/setup.ts`, add at module top level (not inside `beforeAll` — `setup.ts` runs once per worker):

  ```diff
  + // ResizeObserver polyfill for jsdom (required by components that use it for layout measurement)
  + if (typeof global.ResizeObserver === 'undefined') {
  +   global.ResizeObserver = vi.fn().mockImplementation(() => ({
  +     observe: vi.fn(),
  +     unobserve: vi.fn(),
  +     disconnect: vi.fn(),
  +   }));
  + }
  ```

  Then delete the `beforeAll(() => { if (typeof global.ResizeObserver === undefined) { … } })` blocks from:
  - `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx:23-34`
  - `frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx:17-28`
  - `frontend/src/components/cyboflow/__tests__/WorkflowCanvas.test.tsx:16-27`

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn "global.ResizeObserver = vi.fn" frontend/src` confirms exactly three identical shims at CyboflowRoot.test.tsx:28, RunRightRail.test.tsx:22, WorkflowCanvas.test.tsx:21, and frontend/src/test/setup.ts is already wired as the centralised mount point (tRPC stub + `afterEach(cleanup)`) — the move is the canonical home for jsdom polyfills in this repo at near-zero change cost.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Make visual verification actually runnable — Playwright `_electron.launch()` config or scripted Peekaboo TCC remediation
- **Summary:** Visual verification has been silently skipped for every sprint since SPRINT-031 because both configured paths are non-functional; this sprint should produce a concrete fix so the visual-verify checkbox is no longer decorative.
- **Source-Sprint:** SPRINT-041
- **Source:** FIND-SPRINT-041-3 (TASK-776 verifier), FIND-SPRINT-041-6 (TASK-781 verifier); human-review-queue.md `dedup_key: visual_macos_unavailable` (now affects 11 tasks: TASK-655 through TASK-781) and `dedup_key: visual_web_unavailable` (6 tasks); TASK-780-done.md "visual_web/visual_macos: skipped_unable (recurring Electron-preload + Peekaboo TCC issues)"; TASK-781-done.md same note.
- **Problem:** Two concurrent failures block every sprint's visual gate:
  1. `visual_web` — the Vite renderer at `http://localhost:4521` cannot bootstrap standalone; it requires the Electron `preload`-injected `electronTRPC` global. Playwright's `webServer` config launches a standalone Vite server, so every spec that touches the renderer body gets a blank page. This is documented in `CLAUDE.md` and `docs/VISUAL-VERIFICATION-SETUP.md` but has never been fixed.
  2. `visual_macos` — Peekaboo MCP consistently reports Accessibility NOT granted for the MCP host process binary (current sprint: FIND-SPRINT-041-3, FIND-SPRINT-041-6; prior: SPRINT-031 through SPRINT-040 per `sprint_recurrence` field in the review queue entry). The TCC.db host-process diagnostic in `docs/VISUAL-VERIFICATION-SETUP.md` fixes it once but the grant does not persist across Claude Code host process restarts.
- **Proposed direction:** Two parallel remediation tracks; the task should pick one and implement it fully:
  - **Track A (preferred per `docs/VISUAL-VERIFICATION-SETUP.md`):** Rework `playwright.config.ts` to launch Electron via `_electron.launch()` instead of a `webServer` pointing at Vite. This makes `visual_web` functional (renderer gets the preload) and provides a stable base for automated screenshot assertions. Existing specs under `tests/` would need their `page` fixture replaced with an `electronApp`-derived window. `tests/cyboflow-day3-gate.spec.ts` already imports vitest and causes collection errors (pre-existing, noted in `human-review-queue.md dedup_key: playwright_full_run_blocked_by_day3_gate_spec`) — that conflict should be resolved as part of the same task (move the spec to vitest config or add a Playwright `testIgnore`).
  - **Track B (fallback):** Script the Peekaboo TCC.db host-process remediation and add it to the project bootstrap / dev setup docs so it runs once after each Claude Code upgrade. This does not fix `visual_web` but makes `visual_macos` reliable.
- **Scope:** medium (Track A) or small (Track B)

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Track B is materially the same proposal as SPRINT-040 B6 (DONT_IMPLEMENTed because the bottleneck is a System Settings GUI action only the user can complete, not diagnostic friction — TCC docs already at docs/VISUAL-VERIFICATION-SETUP.md:94-102), and Track A is a speculative medium-scope rework of playwright.config.ts plus retrofit of all 7 spec files in `tests/` whose only justification is unlocking a verification surface that CLAUDE.md already explicitly downgrades ("Verifiers MUST use `pnpm test:unit` … as the code-change AC gate; treat `pnpm test:e2e` failures as environmental") — the "decorative checkbox" framing argues for adjusting SoloFlow plugin verification levels (out of scope here), not rebuilding the e2e harness.
- **Counterfactual:** Would flip to IMPLEMENT if a specific cyboflow code regression had been missed because visual_macos / visual_web was unavailable (rather than the current pattern of `skipped_unable` followed by unit-test-gated merges that have not produced visible regressions across SPRINT-031..SPRINT-041).

---

### B2. Eliminate duplicate `useWorkflowPhaseState` subscription — prop-drilling or Zustand selector
- **Summary:** `CyboflowRoot` and `WorkflowProgressTimeline` each call `useWorkflowPhaseState(runId)` independently, opening two concurrent tRPC subscriptions and two independent query calls for the same data; the two React state snapshots can diverge under non-deterministic event interleaving.
- **Source-Sprint:** SPRINT-041
- **Source:** FIND-SPRINT-041-7 (SPRINT-041 sprint-code-reviewer); TASK-780-done.md (wired `useWorkflowPhaseState` into `CyboflowRoot`); TASK-781-done.md (wired same hook into `WorkflowProgressTimeline`).
- **Problem:** `CyboflowRoot.tsx:37` calls `useWorkflowPhaseState(activeRunId)`. `WorkflowProgressTimeline.tsx:176` calls `useWorkflowPhaseState(runId)`. When the Workflow Progress right-rail tab is active, both fire with the same `runId`, producing: 2 × `trpc.cyboflow.runs.onStepTransition.subscribe({ runId })`, 2 × `getPhaseState.query({ runId })`, and 2 independent React state objects that can disagree if a step-transition event arrives between the two subscription initializations. `useWorkflowPhaseState.ts:115` has no module-level cache or shared subscription.
- **Proposed direction:** Change `WorkflowProgressTimeline` to accept `phaseState` as a prop (type: the return type of `useWorkflowPhaseState`) and have `CyboflowRoot` / `RunRightRail` pass it down. `useWorkflowPhaseState` becomes a single-subscriber primitive again and the duplicate subscription disappears. If more than one sibling component needs this state, escalate to a Zustand atom (analogous to how `reviewQueueStore` owns approval state) so the hook populates a store once and any number of selectors can read it without extra subscriptions. The prop-drilling path is simpler and sufficient for the current component tree.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified both call sites — frontend/src/components/cyboflow/CyboflowRoot.tsx:37 and frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:176 each invoke `useWorkflowPhaseState(runId)`, and the hook at frontend/src/hooks/useWorkflowPhaseState.ts:115-138 opens a fresh `onStepTransition.subscribe` + `getPhaseState.query` per call with no module-level cache, so two concurrent subscriptions with non-deterministic interleaving is a real (not speculative) state-divergence risk that the prop-drilling fix removes with one prop passthrough.

---

### B3. Extract a `GateRouter<TRequest, TResponse>` base to eliminate ApprovalRouter / QuestionRouter structural duplication
- **Summary:** `ApprovalRouter` and `QuestionRouter` share ~70% structural duplication; extracting a generic base or factory will ensure future invariant changes (e.g., timeout policy) land in one place.
- **Source-Sprint:** SPRINT-041
- **Source:** FIND-SPRINT-041-8 (SPRINT-041 sprint-code-reviewer); TASK-774-done.md (touched `cancelAndRestartHandler` + both routers' deps); TASK-777-done.md (`code_review_rounds: 1` — the review surfaced the test-barrier asymmetry between the two twin files, which is itself a symptom of the duplication).
- **Problem:** `main/src/orchestrator/approvalRouter.ts` (1–460 lines) and `main/src/orchestrator/questionRouter.ts` (1–426 lines) implement the same shape: singleton + static initialize/getInstance/\_resetForTesting; per-run PQueue map; `pending Map<id, PendingEntry>`; `request*` method with guarded txn; `respond()` with fast-path peek + queue-serialized re-fetch; `clearPendingForRun` with identical iterate-then-delete semantics; `recoverStaleAwaiting*` boot-recovery txn. The cross-cutting design invariants in each file's docblock are duplicated verbatim. TASK-775 had to apply the second-subscription onError fix to both stores in parallel — exactly the mirrored-edit hazard the sprint-code-reviewer flagged. A third gate type (e.g., human-review-gated file edits) would require a third full copy.
- **Proposed direction:** Create `main/src/orchestrator/gateRouter.ts` with a generic `GateRouter<TRequest, TResponse>` abstract base class or a `createGateRouter(config)` factory function. Parameters: DB table name, status column values (`awaiting_review` vs `awaiting_input`), response type, fallback response builder, per-entry data shape. Both `ApprovalRouter` and `QuestionRouter` become thin wrappers (~40 lines each) that supply their type-specific identifiers and delegate structural logic to the base. The `§no-recursive-enqueue` invariant and the `singleton + _resetForTesting` pattern should be documented once in the base. All existing tests remain valid — they test the concrete routers, not the base.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Classic premature abstraction for N=2 — the structural duplication is real (460 + 426 lines verified) but the proposal's central justification ("a third gate type would require a third full copy") is speculative since no third gate type exists or is planned, and a generic `GateRouter<TRequest, TResponse>` with table-name + status-column + per-entry shape parameters would itself be a substantial new abstraction surface (~200+ lines + invariant documentation + its own test scaffold) that future agents must learn before touching either concrete router; the cited TASK-774/777 mirrored-edit risk was one instance and the per-task code-reviewer's "test-barrier asymmetry" finding (FIND-SPRINT-041-5) was already resolved in TASK-777 without consolidation.
- **Counterfactual:** Would flip to IMPLEMENT if a concrete third gate type lands in plan/epic state (e.g., a human-review-gated file-edit router) or if a second mirrored-edit incident occurs in the next 2–3 sprints making the hazard recurrent rather than singular.

---

### B4. Extract a `createSubscriptionQueueStore<T>` factory to eliminate reviewQueueStore / questionStore structural duplication
- **Summary:** `reviewQueueStore` and `questionStore` share ~80% structural duplication; a typed factory eliminates the mirrored-edit hazard and is especially urgent now that TASK-775 had to write the same `onError` fix into both files.
- **Source-Sprint:** SPRINT-041
- **Source:** FIND-SPRINT-041-9 (SPRINT-041 sprint-code-reviewer); TASK-775-done.md ("TASK-775 had to write the second-subscription onError fix into BOTH stores to keep them in lockstep — exactly the kind of forced parallel edit that argues for consolidation"); TASK-773-done.md (fix applied to `reviewQueueStore.test.ts` mirroring `questionStore.test.ts` pattern — same mirror-edit pattern at test level).
- **Problem:** `frontend/src/stores/reviewQueueStore.ts` (1–307 lines) and `frontend/src/stores/questionStore.ts` (1–294 lines) implement identical slices: `ConnectionStatus` union, queue + connectionStatus state, add/remove/replaceAll/setConnectionStatus reducers with idempotent semantics, closure-private `initialized` + `cachedUnsubscribe`, `init()` that opens two tRPC subscriptions with mirrored error teardown, `pure*` exports for tests. The only meaningful difference is the `syncBadge` call in `reviewQueueStore`. Every structural change to one currently requires manual propagation to the other. The mirrored test structure (`reviewQueueStore.test.ts` ↔ `questionStore.test.ts`) compounds the maintenance cost.
- **Proposed direction:** Create `frontend/src/stores/createSubscriptionQueueStore.ts` with a `createSubscriptionQueueStore<T>(config)` factory. Config shape: `{ listPendingProc, onCreatedSub, onSettledSub, deltaIdField, settledIdField, onMutate?: (queue: T[]) => void }`. The factory handles the `ConnectionStatus`, `initialized`, `cachedUnsubscribe`, and full `init()` pattern. `reviewQueueStore` becomes a ~20-line wrapper that plugs in its tRPC procedures + the `syncBadge` hook; `questionStore` similarly. `pure*` exports can be derived from the factory's internal reducers. Existing tests continue to test the concrete stores; the factory itself warrants a small unit test to exercise the shared `onError` teardown path.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Same premature-abstraction-for-N=2 concern as B3 — verified 306 + 293 lines with ~80% duplication, but the TASK-775 mirrored `onError` edit is a single concrete instance (not a recurring trend), and a generic `createSubscriptionQueueStore<T>({listPendingProc, onCreatedSub, onSettledSub, deltaIdField, settledIdField, onMutate?})` factory introduces 5+ config knobs to encode the cross-store invariants plus a new test surface, only to leave each concrete store as a thin wrapper around tRPC procedure refs that TypeScript cannot easily relate at the type level (`trpc.cyboflow.approvals.listPending.query` vs `trpc.cyboflow.questions.listPending.query` have distinct generated types, forcing `as unknown`-flavored casts inside the factory or per-store glue).
- **Counterfactual:** Would flip to IMPLEMENT if a third subscription-queue store is planned (e.g., a notifications or stuck-detection queue) or if a second mirrored-edit incident hits both files within 2 sprints, converting the hazard from one-off to recurrent.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

_No items._

---

## Reconciled Findings (informational)

The following findings appeared as `status: open` in the findings file but were claimed resolved by a done report. Treated as resolved — not triaged into buckets above.

- FIND-SPRINT-041-4 — `status: resolved` in findings file (resolved by verifier: typecheck gate, `tests/helpers/cyboflowTestHarness.ts` narrowed as part of TASK-777)
- FIND-SPRINT-041-5 — `status: resolved` in findings file (resolved by TASK-777 code-review round 1: dead `qf.getOrCreate()` barriers replaced with `router['getApprovalQueue'](runId).onIdle()`)

---

## Suppressed — SoloFlow Defects

The following candidate was identified during triage but does not belong in project CLAUDE.md or CODE-PATTERNS.md — it describes a defect in the SoloFlow compounder agent, not in the cyboflow codebase.

- **Compounder scheduling blindspot (FIND-SPRINT-041-11)** — TASK-778 was proposed from SPRINT-040 bucket B1 without checking whether the same ACs were already covered by concurrently-queued tasks (TASK-773, TASK-775). The compounder agent does not grep the active sprint plan before emitting a proposal item; this is a SoloFlow plugin-level defect. The rule ("grep active plan files before proposing tasks that overlap existing ACs") would evaporate if the user switched away from SoloFlow. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
