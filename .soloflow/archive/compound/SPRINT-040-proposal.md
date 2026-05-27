---
sprints: [SPRINT-040]
span_label: SPRINT-040
created: "2026-05-26T00:00:00.000Z"
counters_start:
  ideas: 0
summary:
  cleanups: 3
  backlog_tasks: 6
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-040

## A. Clean-up items (execute now)

### A1. Replace dead `FlatStep[]` construction in WorkflowCanvas with a flat id array
- **Summary:** WorkflowCanvas.tsx builds a typed `FlatStep[]` array with four fields per step but only ever uses `step.id` for a single `findIndex` call; all other fields and the `FlatStep` type are unused dead weight.
- **Source-Sprint:** SPRINT-040
- **Rationale:** The `phaseIndex: 0 // unused` comment makes the dead code explicit. The JSX render path independently computes `phaseFlatStart` and `globalStepIndex` and never reads `allSteps`. Removing ~20 lines of object construction and a local type eliminates a maintenance surface with zero behavior change.
- **Blast radius:** `frontend/src/components/cyboflow/WorkflowCanvas.tsx` (lines 48–67 and the `FlatStep` type declaration). Risk: trivial — pure substitution with identical semantics.
- **Source:** FIND-SPRINT-040-6 (code-reviewer on TASK-769)
- **Proposed change:**
  ```diff
  -interface FlatStep {
  -  phaseIndex: number; // unused
  -  stepIndex: number;
  -  phase: WorkflowPhase;
  -  step: WorkflowStep;
  -}
  -
  -const allSteps: FlatStep[] = definition.phases.flatMap((phase, phaseIndex) =>
  -  phase.steps.map((step, stepIndex) => ({ phaseIndex, stepIndex, phase, step }))
  -);
  -const currentStepIndex = allSteps.findIndex((fs) => fs.step.id === currentStepId);
  +const stepIds = definition.phases.flatMap((p) => p.steps.map((s) => s.id));
  +const currentStepIndex = stepIds.indexOf(currentStepId ?? '');
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at frontend/src/components/cyboflow/WorkflowCanvas.tsx:48-67 — `phaseIndex: 0 // unused` comment is literal, `FlatStep` is declared and consumed only for `allSteps.findIndex((fs) => fs.step.id === currentStepId)`, and the JSX render path (lines 195-256) computes `phaseFlatStart` and `globalStepIndex` independently without ever reading `allSteps[].phase`/`step`.

### A2. Remove dead `marginBottom` ternary in WorkflowCanvas step wrapper
- **Summary:** WorkflowCanvas.tsx has an inline style `marginBottom: stepInPhase < phase.steps.length - 1 ? 0 : 0` where both branches evaluate to `0`, making the entire expression dead code.
- **Source-Sprint:** SPRINT-040
- **Rationale:** The ternary was likely a refactor leftover from when row spacing was driven by index; spacing is now handled by the parent flex layout and the `ROW_H` constant. Leaving it creates confusion about whether the conditional is intentional.
- **Blast radius:** `frontend/src/components/cyboflow/WorkflowCanvas.tsx` (line 241). Risk: trivial — `marginBottom: 0` is the CSS default; removing the property is a no-op.
- **Source:** FIND-SPRINT-040-7 (code-reviewer on TASK-769)
- **Proposed change:**
  ```diff
  -style={{ marginBottom: stepInPhase < phase.steps.length - 1 ? 0 : 0 }}
  +{/* marginBottom: if future row-spacing logic is needed, add it here */}
  ```
  Or simply remove the `style` prop entirely if `marginBottom` is the only property it contained.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at frontend/src/components/cyboflow/WorkflowCanvas.tsx:241 — the ternary `marginBottom: stepInPhase < phase.steps.length - 1 ? 0 : 0` evaluates to `0` on both branches, so the entire property is a no-op against the CSS default and `style` contains no other layout-meaningful keys for the parent flex container.

### A3. Add `aria-hidden="true"` to decorative SVG glyphs in WorkflowStepCard
- **Summary:** Two decorative `<svg>` elements in WorkflowStepCard.tsx (the human-badge person icon and the done-state check circle) are missing `aria-hidden="true"`, causing screen readers to traverse into unlabeled SVG internals.
- **Source-Sprint:** SPRINT-040
- **Rationale:** The parent `<span>` already carries `aria-label="human step"` / `aria-label="completed"`. Without `aria-hidden="true"` on the SVG, AT implementations may redundantly traverse the SVG children (`<circle>`, `<path>`) which have no accessible names, producing inconsistent announcements. The fix is two-character targeted; no sighted-user behavior changes.
- **Blast radius:** `frontend/src/components/cyboflow/WorkflowStepCard.tsx` (lines 222 and 276 per FIND-SPRINT-040-8). Risk: trivial — accessibility attribute addition only.
- **Source:** FIND-SPRINT-040-8 (code-reviewer on TASK-769)
- **Proposed change:**
  ```diff
  -<svg …>   {/* human badge person icon, line 222 */}
  +<svg aria-hidden="true" …>

  -<svg …>   {/* done-state check circle, line 276 */}
  +<svg aria-hidden="true" …>
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at frontend/src/components/cyboflow/WorkflowStepCard.tsx:222 and 276 — both SVGs sit inside spans that already carry `aria-label="human step"` (line 203) and `aria-label="completed"` (line 257), so screen-reader announcement is owned by the parent span and the SVG internals are pure decoration with no accessible name.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix pre-existing `reviewQueueStore.test.ts` init-idempotency failures
- **Summary:** Four `init() idempotency` tests in `reviewQueueStore.test.ts` fail with `TypeError: unsub1 is not a function`; the root cause is a subscribe-mock shape mismatch introduced by a prior tRPC client refactor.
- **Source-Sprint:** SPRINT-040
- **Source:** FIND-SPRINT-040-1 (verifier on TASK-763); confirmed pre-existing across all SPRINT-040 tasks (every done report notes 451/455 or 455/459 passing with these 4 as known failures).
- **Problem:** `frontend/src/stores/__tests__/reviewQueueStore.test.ts` lines 254–289 (`init() idempotency` describe block) expect `init()` to return an unsubscribe function. The `listPending.subscribe` mock no longer returns a function-shaped value in some code path, or `init()` no longer returns the unsubscribe in the expected shape. Likely root cause is the tRPC client / mock-target refactor in TASK-741 or TASK-750, which changed the subscribe mock shape without updating the test. The source file `reviewQueueStore.ts` was last touched at commit `6ecd139` (pre-sprint), so the test suite has been accumulating these failures since that refactor landed. No workflow-phase-model or workflow-progress-visualization code has any import path into `reviewQueueStore`.
- **Proposed direction:** Investigate `reviewQueueStore.ts`'s `init()` return-value contract against the test expectations. Check whether the tRPC subscribe mock setup (around line 254 of the test) aligns with what the current `trpc/client` mock returns for a subscription call — specifically whether the mock returns `{ unsubscribe: fn }` or a bare function. Update either the mock shape or the `init()` return to match. Do NOT touch the store's production logic without verifying the change doesn't break any of the 23+ passing tests in the same file.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Reproduced 4 failures locally (TypeError: unsub1 is not a function + 3 sibling assertions) — root cause is that frontend/src/stores/reviewQueueStore.ts:225 subscribes to a second channel `onApprovalDecided` that the test module-mock at frontend/src/stores/__tests__/reviewQueueStore.test.ts:27-49 never declares, so `subscription.unsubscribe` in production is `undefined` and `init()` crashes before returning; the proposed direction targets the correct seam.

### B2. Fix stepId namespace mismatch across the workflow phase chain (CRITICAL)
- **Summary:** The orchestrator emits `current_step_id` in dot-notation (`'execute.implement'`) while `WORKFLOW_DEFINITIONS` declares bare step ids (`'implement'`); this causes all four consumers to silently resolve every step lookup to `-1` / `pending` in production.
- **Source-Sprint:** SPRINT-040
- **Source:** FIND-SPRINT-040-10 (code-reviewer on TASK-771, high severity); FIND-SPRINT-040-13 (sprint-code-reviewer, high severity). Originates in TASK-765 (`TERMINAL_STEP_IDS` and `buildStepTransitionEvent`) and TASK-766 (`getPhaseState` handler lookup), surfaces in TASK-771 (`mergeTransition`) and TASK-768 (`stepStatusMap` key derivation).
- **Problem:** The mismatch affects four files simultaneously:
  1. `main/src/orchestrator/stepTransitionBridge.ts` — `TERMINAL_STEP_IDS` values use dot-notation (e.g. `'execute.implement'`, `'compound.extract'`); `buildStepTransitionEvent` emits these as `stepId`.
  2. `main/src/orchestrator/trpc/routers/runs.ts:286` — `getPhaseState` does `flatSteps.findIndex((s) => s.id === currentStepId)` against bare-id steps from `WORKFLOW_DEFINITIONS`; always returns `-1` in production; all stepStates render as `pending`.
  3. `frontend/src/hooks/useWorkflowPhaseState.ts:75-81` — `mergeTransition` does `orderedIds.indexOf(event.stepId)` against bare ids; returns `-1` and silently drops every real transition event via the defensive guard.
  4. `frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:297-339` — builds `stepStatusMap` keyed by `s.stepId` (dot-form from subscription events) then looks up `stepStatusMap.get(step.id)` using bare `step.id` from `WORKFLOW_DEFINITIONS`; always misses.
  
  Unit tests pass because fixtures use synthetic ids (`'s1'`, `'s2'`) that match on both sides. The bug is invisible until a real `WORKFLOW_DEFINITIONS` workflow runs end-to-end.

- **Proposed direction:** Pick one canonical form and migrate all four sites atomically. The simplest approach is option (b): change `TERMINAL_STEP_IDS` (and the `resolveTerminalStepId` function in `stepTransitionBridge.ts`) to emit bare step ids (matching `WORKFLOW_DEFINITIONS` `WorkflowStep.id` values) rather than dot-prefixed ones. This requires: (1) audit `WORKFLOW_DEFINITIONS` step ids to confirm they are globally unique (if two phases share a step id, dot-form is required — check `data.js` baseline); (2) update `TERMINAL_STEP_IDS` from `'execute.implement'` etc. to bare `'implement'` etc.; (3) update the `migration011` column comment that documents the fixture value `'execute.implement'`; (4) verify the `getPhaseState` lookup now resolves correctly; (5) verify `mergeTransition` no longer drops events; (6) verify `WorkflowProgressTimeline` `stepStatusMap` keys now match. Add one integration test that wires a real `WORKFLOW_DEFINITIONS` entry through `buildStepTransitionEvent` → `getPhaseState` → `useWorkflowPhaseState` to lock in the contract against future drift. If step ids are NOT globally unique, use option (a) instead (add phase-prefix to `WORKFLOW_DEFINITIONS` step ids and update all consumers accordingly).
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified the mismatch end-to-end: main/src/orchestrator/stepTransitionBridge.ts:62-66 emits dot-form (`'execute.implement'`, `'compound.extract'`) while shared/types/workflows.ts:168+ declares bare step ids — confirmed step ids ARE unique within each workflow definition (no within-workflow collisions across all 5 definitions), so option (b) is safe; the four consumer sites at runs.ts:286, useWorkflowPhaseState.ts:75-81, WorkflowProgressTimeline.tsx:339, and the bridge itself all silently resolve `-1` against real workflow runs.

### B3. Wire workflow canvas components into CyboflowRoot and RunRightRail
- **Summary:** Four components built in SPRINT-040 — `WorkflowProgressTimeline`, `WorkflowCanvas`, `WorkflowCanvasEdges`, and `useWorkflowTokenAnimation` — are complete and tested but have no mount point in production; the RunRightRail Workflow Progress tab still shows a placeholder and WorkflowCanvas is unreachable.
- **Source-Sprint:** SPRINT-040
- **Source:** FIND-SPRINT-040-3 (verifier on TASK-768) — `WorkflowProgressTimeline` not wired into `RunRightRail`; FIND-SPRINT-040-5 (executor on TASK-769) — `WorkflowCanvas` has no mount in `CyboflowRoot`; FIND-SPRINT-040-9 (TASK-770 done report) — `WorkflowCanvasEdges` + `useWorkflowTokenAnimation` not yet imported by `WorkflowCanvas`.
- **Problem:** `RunRightRail.tsx` (built in TASK-767) still renders a `Workflow Progress — coming soon` placeholder in its default tab body. `CyboflowRoot.tsx` has no `<WorkflowCanvas />` mount point. `WorkflowCanvas.tsx` does not yet import `WorkflowCanvasEdges` or call `useWorkflowTokenAnimation`, and does not yet measure `stepRects`/`containerRect` via `ResizeObserver`. The three findings represent one integration pass that was deliberately deferred from each individual task because the sibling files were `files_readonly` at the time.
- **Proposed direction:** A single integration task should own all three wiring gaps in one pass (all the relevant files will be `files_owned` together): (1) Replace the `Workflow Progress — coming soon` placeholder in `RunRightRail.tsx` with `<WorkflowProgressTimeline runId={…} />` — the `runId` should be resolved from `useCyboflowStore` or passed as a prop from `CyboflowRoot`. (2) Mount `<WorkflowCanvas />` in `CyboflowRoot.tsx` in the appropriate layout region when a workflow run is active, passing `definition`, `currentStepId`, `runLabel`, `workflowTitle`, `elapsed`, `tokenCount`, and `isRunning` from run state. (3) Add the TASK-770 Insertion Contract slots to `WorkflowCanvas.tsx`: `stepRects Map` state, `containerRect` state, `useLayoutEffect` with `ResizeObserver`, `useWorkflowTokenAnimation` call, token coordinate interpolation, and `<WorkflowCanvasEdges>` mount. Dependency: B2 (stepId namespace fix) should land first or be bundled into the same sprint so the wired canvas actually receives correct step state.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** All three integration gaps verified: RunRightRail.tsx:27 still reads `placeholder: 'Workflow Progress — coming soon'`, CyboflowRoot.tsx contains no `WorkflowCanvas`/`WorkflowProgressTimeline` import, and WorkflowCanvas.tsx contains no `WorkflowCanvasEdges`/`useWorkflowTokenAnimation`/`ResizeObserver`/`stepRects` references — without this pass the entire SPRINT-040 visualization work remains unreachable in production.

### B4. Retrofit WorkflowProgressTimeline onto useWorkflowPhaseState; fix subscribe-before-query race
- **Summary:** WorkflowProgressTimeline implements its own seed-query + subscription state management that duplicates what useWorkflowPhaseState already provides, and its race semantics (query overwrites subscription deltas) are incorrect relative to the hook's documented policy.
- **Source-Sprint:** SPRINT-040
- **Source:** FIND-SPRINT-040-11 (sprint-code-reviewer) — duplicated tRPC phase-state wiring; FIND-SPRINT-040-12 (sprint-code-reviewer) — inconsistent subscribe-vs-query race semantics.
- **Problem:** `WorkflowProgressTimeline.tsx` (TASK-768) and `useWorkflowPhaseState.ts` (TASK-771) both independently implement `getPhaseState.query` seed + `onStepTransition.subscribe` delta-merge state. The timeline maintains its own `PhaseState` interface (line 28-32), `isLoading`/`loadError` state, and two `useEffect` blocks (lines 198-230 and 233-257) with the same pattern. Beyond duplication, the timeline's race semantics are wrong: the seed query's `.then()` overwrites `setStepStates` regardless of subscription deltas that arrived during the query gap, so transitions during query resolution are silently dropped. The hook deliberately subscribes before awaiting the query to prevent this exact race. Both consumers will diverge further as the `onStepTransition` contract evolves. Note: B4 depends on B2 (stepId fix) landing first — the retrofit is premature if the hook still silently drops all events due to the namespace mismatch.
- **Proposed direction:** Retrofit `WorkflowProgressTimeline` to consume `useWorkflowPhaseState` instead of its own seed + subscription effects. Replace the local `phaseState`/`stepStates`/`isLoading`/`loadError` state and both `useEffect` blocks with `const { definition, currentStepId, stepStates, isLoading, error } = useWorkflowPhaseState(runId)`. Keep the local `streamEvents` log projection — that is the timeline-specific concern. Document the subscribe-before-await race policy in a comment on the `onStepTransition` procedure definition in `main/src/orchestrator/trpc/routers/runs.ts` so future consumers inherit it by reading the source.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified the duplication and race: WorkflowProgressTimeline.tsx:198-230 (seed) and 232-257 (subscription) are two sibling effects where the seed's `.then(setStepStates)` at line 217 overwrites any subscription deltas that landed between subscription open and query resolve — meanwhile useWorkflowPhaseState.ts:125-165 already runs the subscribe-before-await pattern with a `cancelled` flag, so the retrofit collapses ~50 lines into a single hook call and inherits the correct race semantics for free.

### B5. Promote `WorkflowStepTransitionEvent` from stepTransitionBridge.ts to shared/types/workflows.ts
- **Summary:** `WorkflowStepTransitionEvent` is declared inline in the orchestrator's `stepTransitionBridge.ts` rather than in `shared/types/workflows.ts` alongside `WorkflowStepState`, forcing cross-process consumers to import from an orchestrator file.
- **Source-Sprint:** SPRINT-040
- **Source:** FIND-SPRINT-040-2 (verifier on TASK-765); TASK-765 done report explains the local declaration was the correct choice given `shared/types/workflows.ts` was `files_readonly` at the time, but flags it for relocation.
- **Problem:** `WorkflowStepState` (the status field of `WorkflowStepTransitionEvent`) lives in `shared/types/workflows.ts`. The event wrapper that carries it lives in `main/src/orchestrator/stepTransitionBridge.ts`. Frontend consumers (`useWorkflowPhaseState`, `WorkflowProgressTimeline`) that need to type-annotate subscription callback arguments must currently import from an orchestrator file rather than the shared types package — violating the cross-package contract pattern documented in `docs/CODE-PATTERNS.md` ("When adding a new domain concept that spans both, define its type in `shared/types/` first.").
- **Proposed direction:** In a sprint where `shared/types/workflows.ts` is `files_owned`: (1) Add `WorkflowStepTransitionEvent` to `shared/types/workflows.ts` with the shape `{ runId: string; stepId: string; status: WorkflowStepState; timestamp: string }`. (2) In `stepTransitionBridge.ts`, remove the inline declaration and import from `shared/types/workflows.ts`. (3) Update any consumers that currently import `WorkflowStepTransitionEvent` from the bridge file to import from the shared location. This is a pure type relocation — no runtime behavior change.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `WorkflowStepTransitionEvent` is declared at main/src/orchestrator/stepTransitionBridge.ts:35 alongside the imported `WorkflowStepState` from shared/types — confirming the asymmetry called out in docs/CODE-PATTERNS.md ("define cross-process types in shared/types/ first") and mirroring the FIND-SPRINT-024-4 / FIND-SPRINT-037-5 dual-declaration class the IPC parity rules already exist to prevent.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if a planned shared/types/ipc.ts consolidation (referenced in CLAUDE.md) is already scheduled to subsume the workflow event types — relocating now would create churn that the consolidation will undo.

### B6. Add a `pnpm doctor:visual` diagnostic script for TCC grant verification
- **Summary:** Six consecutive sprints (SPRINT-031 through SPRINT-040) have lost visual verification because the Peekaboo MCP host process binary lacks the Accessibility TCC grant; a project-level diagnostic script would surface the exact remediation command without manual log-reading.
- **Source-Sprint:** SPRINT-040
- **Source:** FIND-SPRINT-040-4 (verifier on TASK-768); human-review-queue.md `dedup_key: visual_macos_unavailable` entry spanning TASK-655 through TASK-768.
- **Problem:** The recurring failure pattern is: `mcp__peekaboo__list server_status` reports `Accessibility: Not granted` while Screen Recording is present. CLAUDE.md documents the TCC.db host-process diagnostic, but the manual lookup in `docs/VISUAL-VERIFICATION-SETUP.md` must be re-performed each sprint. The human action loop has not closed across six sprints, suggesting the remediation steps need a lower-friction path.
- **Proposed direction:** Add a `pnpm doctor:visual` npm script (e.g. `scripts/doctor-visual.sh`) that: (1) identifies the MCP host process binary (e.g. by reading `~/Library/Application Support/Claude/claude_desktop_config.json` for the server command path, or accepting it as an arg); (2) runs `tccutil check ScreenCapture <binary>` and `tccutil check Accessibility <binary>`; (3) prints the exact `tccutil grant` commands needed for any missing grant. Wire it into `package.json` as `"doctor:visual": "bash scripts/doctor-visual.sh"`. This is a developer-ergonomics convenience and does not gate any CI path.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The bottleneck across SPRINT-031..SPRINT-040 is a human GUI action (granting Screen Recording + Accessibility in System Settings → Privacy & Security to the MCP host binary), not diagnostic friction — docs/VISUAL-VERIFICATION-SETUP.md:94-102 already provides a one-shot SQL query that surfaces the exact missing grant, and `tccutil` on modern macOS cannot grant Screen Recording without the user opening System Settings, so the proposed script adds a new maintenance surface (npm script + bash file + Claude config path assumption) for a loop only the user can close.
- **Counterfactual:** Would flip to IMPLEMENT if the script also pinned the exact MCP host binary path under version control (so the user-facing System Settings click becomes one specific entry to drag), AND if at least one sprint's findings explicitly attribute failure to "couldn't find which binary to grant" rather than "didn't grant yet."

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the subscribe-before-query race policy for tRPC phase-state consumers in CODE-PATTERNS.md
- **Summary:** Document the subscribe-before-await ordering rule for tRPC seed-query + subscription pairs so future consumers do not roll an incorrect race policy.
- **Source-Sprint:** SPRINT-040
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after "### Per-session mutation serialization" (within "## Recurring Patterns")
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- docs/CODE-PATTERNS.md
  +++ docs/CODE-PATTERNS.md
  @@ after the "### Per-session mutation serialization" block
  +
  +### tRPC seed-query + subscription race policy
  +
  +For a tRPC pair where a query returns initial state and a subscription delivers
  +delta events (e.g. `getPhaseState` + `onStepTransition`), the consumer MUST open
  +the subscription BEFORE awaiting the query — not in a separate concurrent
  +`useEffect` — so events that arrive during the query window are not overwritten
  +when the seed resolves. Use a `cancelled` flag so the seed `.then()` skips
  +applying stale state after teardown.
  +
  +**Canonical example:** `frontend/src/hooks/useWorkflowPhaseState.ts` (subscribe at
  +line 131 before the `getPhaseState.query` at line 147; `cancelled` flag guards both).
  +**Anti-pattern:** pre-B4 `WorkflowProgressTimeline.tsx` ran two sibling effects;
  +the query's `setStepStates` overwrote subscription deltas (FIND-SPRINT-040-12).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified the canonical example at frontend/src/hooks/useWorkflowPhaseState.ts:130-148 (subscribe BEFORE the `getPhaseState.query` `.then`, both guarded by a `cancelled` flag) AND the anti-pattern at frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:198-257 (two sibling effects where the seed `.then(setStepStates)` overwrites subscription deltas) — so the rule both matches the codebase today and would have prevented the WorkflowProgressTimeline mistake; a single canonical pointer plus anti-pattern is the smallest fix.

### C2. Add tRPC `onData` inference rule to CLAUDE.md TypeScript Rules
- **Summary:** Add a TypeScript Rules entry forbidding a local mirror type or `onData: (evt: unknown)` runtime-guard pattern on tRPC subscriptions — rely on AppRouter contextual inference.
- **Source-Sprint:** SPRINT-040
- **Target file:** `CLAUDE.md`
- **Action:** insert-after the "Optional `logger?` on observability classes" paragraph in "## TypeScript Rules"
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  --- CLAUDE.md
  +++ CLAUDE.md
  @@ after the "Optional logger? on observability classes" paragraph in "## TypeScript Rules"
  +
  +**tRPC subscription `onData` payload type must come from `AppRouter` inference — never a local mirror or `(evt: unknown)` + runtime shape guard.** Write `onData: (event) => …` and let the tRPC client infer the payload from the router. A locally-declared interface (e.g. a `WorkflowStepTransitionEvent` copy in the renderer) or an `unknown`-typed arg with a hand-rolled `'runId' in evt` guard defeats inference and silently accepts stale shapes after the router output changes — same silent-drift class as the `IPCResponse<T>` parity rule above. Caught in TASK-768 / commit `f6240a6`. Audit: `grep -rnE "onData: \(evt: unknown\)|onData: \(event:" frontend/src` — each production hit is a candidate for inference (test files intentionally fake the shape and are exempt).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified the catch at commit f6240a6 (TASK-768 explicitly dropped a local `WorkflowStepTransitionEvent` mirror plus `(evt: unknown)` + runtime guard) AND that the AppRouter procedures at main/src/orchestrator/trpc/routers/events.ts:208-238 declare concrete `AsyncGenerator<ApprovalCreatedEvent>` / `AsyncGenerator<ApprovalDecidedEvent>` payloads — so the existing 4 hits in reviewQueueStore.ts/questionStore.ts that claim "backend implementation evolves" are actually defeating real-today inference and the rule names a recurring trap, not a one-off.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the reviewQueueStore/questionStore `(evt: unknown)` shims turn out to be deliberate compat scaffolding for a near-term router schema change (in which case the audit grep would produce noisy false positives and the rule needs an "except deliberate placeholder-router shims documented inline" carve-out).

---

## Reconciled Findings (informational)

No drift found. No done report in SPRINT-040 contains a `**Findings resolved:**` line claiming resolution of any open finding. All 13 findings in the queue remain correctly marked `status: open`.

FIND-SPRINT-040-4 is listed in the findings queue as `type: claude-md` but the underlying problem (recurring TCC grant misconfiguration) is already documented in CLAUDE.md and `docs/VISUAL-VERIFICATION-SETUP.md`. No additional C-item was generated; the human-action gap is addressed instead as B6 (a `pnpm doctor:visual` diagnostic script). The CLAUDE.md documentation for the two-permission requirement and TCC.db diagnostic is already current as of SPRINT-040.
