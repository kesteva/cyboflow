---
sprint: SPRINT-040
pending_count: 11
last_updated: "2026-05-27T05:25:30.000Z"
---
# Findings Queue

SPRINT-040 started with missing infra: docker; tests deferred (likely false positive — impacted tests are Vitest unit tests, not Docker-dependent).

## FIND-SPRINT-040-1
- **source:** TASK-763 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/__tests__/reviewQueueStore.test.ts
- **description:** `pnpm test:unit` shows 4 pre-existing failures in the `init() idempotency` suite of `reviewQueueStore.test.ts` (TypeError: `unsub1 is not a function`, plus three sibling tests in the same `describe`). The failing files (`reviewQueueStore.ts`, `reviewQueueStore.test.ts`) have not been modified since the sprint's base SHA `5712251` — the most recent commit touching either is `6ecd139` (pre-sprint). The failures are orthogonal to TASK-763 (no import path between `shared/types/workflows.ts` and `reviewQueueStore`). Likely root cause: `reviewQueueStore.init()` no longer returns an unsubscribe function in some code path, or the test mock for `listPending.subscribe` returns a non-function. Surfaces during the StrictMode double-invoke fixture.
- **suggested_action:** Investigate `init()` return-value contract in `frontend/src/stores/reviewQueueStore.ts` against the test expectations (line 254–289 of the test). Likely a recent tRPC client / mock-target refactor (TASK-741 / TASK-750) broke the subscribe-mock shape. Should be tackled in its own task; do not bundle with workflow-phase-model work.
- **resolved_by:** 

## FIND-SPRINT-040-2
- **source:** TASK-765 (verifier)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/stepTransitionBridge.ts:35-44
- **description:** TASK-765's plan AC2 prescribed importing `WorkflowStepTransitionEvent` from `shared/types/workflows.ts` (defined by TASK-763). TASK-763 added `WorkflowStepState` to that file but did NOT add `WorkflowStepTransitionEvent`. Because `shared/types/workflows.ts` is `files_readonly` for TASK-765, the executor declared the interface inline in `stepTransitionBridge.ts` with a comment explaining the situation. This is the correct local choice (cannot satisfy AC2 literally without modifying a readonly file), but creates a type-location inconsistency: `WorkflowStepState` lives in `shared/types/workflows.ts` while the event payload that wraps it lives in the orchestrator's bridge file. Downstream consumers (TASK-766 tRPC subscription, TASK-769/770/771 frontend) will likely need to import `WorkflowStepTransitionEvent` and will reach into `main/src/orchestrator/stepTransitionBridge.ts` rather than the shared types file. The shape `{ runId, stepId, status, timestamp }` chosen by the executor matches the plan's Lowest Confidence Area assumption verbatim, so the design intent is preserved — only the location is suboptimal.
- **suggested_action:** A follow-up task should promote `WorkflowStepTransitionEvent` from `main/src/orchestrator/stepTransitionBridge.ts` to `shared/types/workflows.ts` and update the bridge to re-export it. Co-locating with `WorkflowStepState` is the natural home. Alternatively, the planner workflow should incorporate this resolution into the next workflow-phase-model task that owns frontend wiring (TASK-769 or later) so the type is moved in the same change that first needs it cross-process.
- **resolved_by:** 

## FIND-SPRINT-040-3
- **source:** TASK-768 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/plans/workflow-progress-visualization/EPIC-workflow-progress-visualization.md
- **description:** The workflow-progress-visualization epic plans five tasks (TASK-767..TASK-771) but no task explicitly owns wiring `WorkflowProgressTimeline` (built in TASK-768) into the `RunRightRail` Workflow Progress tab (built in TASK-767 as a placeholder). TASK-768 lists `RunRightRail.tsx` as `files_readonly`; TASK-769 builds `WorkflowCanvas` (independent file); TASK-770 adds SVG edge overlay to the canvas; TASK-771 wires the canvas to tRPC. Result: at sprint end, `WorkflowProgressTimeline` will exist with 17 passing tests but be unreachable in production — the `RunRightRail` Workflow Progress tab still renders its placeholder. The component is correct in isolation; only the consumer integration is missing from the plan.
- **suggested_action:** Add a small follow-up task (or amend TASK-771 since it also touches the rail's consumer side) to replace the `Workflow Progress — coming soon` placeholder in `RunRightRail.tsx` with `<WorkflowProgressTimeline runId={…} />`. The rail will need to resolve the active runId — either via `useCyboflowStore` or via a prop from `CyboflowRoot`. Update the planner workflow to flag "component built but never wired into its parent" gaps in epic-level cross-file dependency checks.
- **resolved_by:** 

## FIND-SPRINT-040-4
- **source:** TASK-768 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md, CLAUDE.md
- **description:** Sixth consecutive sprint (SPRINT-031..SPRINT-040) where Peekaboo MCP visual verification fails on macOS because Accessibility is not granted to the MCP host process binary (Screen Recording IS granted; only Accessibility is missing). `mcp__peekaboo__list server_status` reports `Accessibility: ❌ Not granted` while the same probe shows Screen Recording present. CLAUDE.md already calls out the TCC.db host-process diagnostic in `docs/VISUAL-VERIFICATION-SETUP.md`, but the recurring symptom has now blocked visual verification on every sprint since the project enabled `visual_macos=true`. The two-permission requirement (Screen Recording for capture + Accessibility for `click`/`type`/`menu`/`hotkey` drive) is documented but the operational diagnostic remains manual every time it surfaces.
- **suggested_action:** Consider adding a one-line `pnpm` script (e.g. `pnpm doctor:visual`) that probes both TCC grants against the running MCP host process and prints the exact `tccutil reset` + grant-app command needed. Alternatively, gate the verifier's visual_macos availability check in CLAUDE.md so verifiers don't auto-emit a new queue entry every sprint until the underlying TCC config is resolved at the OS level. The queue dedup_key `visual_macos_unavailable` already collapses sprint-internal noise, but multi-sprint repetition still indicates the human action loop is not closing.
- **resolved_by:** 

## FIND-SPRINT-040-5
- **type:** claude-md
- **source:** TASK-769 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/CyboflowRoot.tsx
- **description:** WorkflowCanvas (built in TASK-769) has no mount point in CyboflowRoot.tsx. The plan step 5 noted this was expected — TASK-767 did not add a WorkflowCanvas import/mount point (RunRightRail and rail tabs only). The component is shippable and downstream TASK-770/771 depend on it, but it is currently unreachable in production. Same class as FIND-SPRINT-040-3 (WorkflowProgressTimeline wiring gap).
- **suggested_action:** A follow-up task (or an amendment to TASK-771 which handles tRPC wiring) should mount <WorkflowCanvas /> in CyboflowRoot.tsx, replacing or augmenting the existing RunBottomPane left column when a workflow run is active. The canvas will need definition and currentStepId props resolved from the active run.
- **resolved_by:** 

## FIND-SPRINT-040-6
- **source:** TASK-769 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowCanvas.tsx:48-67
- **description:** The `allSteps: FlatStep[]` array constructs objects with four fields (`phaseIndex`, `stepIndex`, `phase`, `step`) but only `step.id` is ever consumed downstream (via `allSteps.findIndex(fs => fs.step.id === currentStepId)`). The `phaseIndex: 0 // unused` field is explicitly marked dead. The JSX render path computes its own `phaseFlatStart` and `globalStepIndex` independently and never reads `allSteps`. The type and construction loop add ~20 lines of structure for a single id lookup.
- **suggested_action:** Replace the `FlatStep[]` construction with `const stepIds = definition.phases.flatMap(p => p.steps.map(s => s.id))` and call `stepIds.indexOf(currentStepId)`. Drop the `FlatStep` type. Behavior is identical; the file gets shorter and the dead `phaseIndex: 0` disappears.
- **resolved_by:** 

## FIND-SPRINT-040-7
- **source:** TASK-769 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowCanvas.tsx:241
- **description:** The step-wrapper inline style has `marginBottom: stepInPhase < phase.steps.length - 1 ? 0 : 0` — both branches of the ternary evaluate to `0`, so the entire expression is dead code masquerading as conditional layout. Likely a refactor leftover where the row spacing was once driven by index but later moved to a fixed row height via the parent flex / `ROW_H` constant.
- **suggested_action:** Drop the `marginBottom` property entirely (default is 0). If the intent was to leave row spacing as a future hook, replace with a comment explaining what the value should be once it's needed.
- **resolved_by:** 

## FIND-SPRINT-040-8
- **source:** TASK-769 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowStepCard.tsx:222-234, 276-287
- **description:** The decorative `<svg>` glyphs inside the human badge (person icon) and the done-state check circle do not have `aria-hidden="true"`. Their parent `<span>` carries the `aria-label` ("human step" / "completed"). Without `aria-hidden` on the SVG, screen readers may attempt to traverse into the SVG content (its `<circle>` / `<path>` children have no accessible names), causing inconsistent announcement across AT implementations. The canonical pattern is `aria-label` on the labeled wrapper plus `aria-hidden="true"` on the decorative SVG so AT treats the SVG as presentation.
- **suggested_action:** Add `aria-hidden="true"` to both `<svg>` elements (lines 222 and 276 of WorkflowStepCard.tsx). The parent `<span>` aria-label remains the sole accessible name. No behavior change for sighted users.
- **resolved_by:** 

## FIND-SPRINT-040-9
- **type:** claude-md
- **source:** TASK-770 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowCanvas.tsx
- **description:** AC8 (WorkflowCanvas imports WorkflowCanvasEdges + useWorkflowTokenAnimation) cannot be self-verified by TASK-770 — WorkflowCanvas.tsx is files_readonly here. WorkflowCanvas does not yet contain the insertion contract slots (stepRects state, containerRect, WorkflowCanvasEdges import, useWorkflowTokenAnimation import). Same class as FIND-SPRINT-040-3 and FIND-SPRINT-040-5. WorkflowCanvasEdges and useWorkflowTokenAnimation are complete and tested in isolation; the wiring gap is expected to be closed by TASK-771 which owns the tRPC wiring pass.
- **suggested_action:** TASK-771 (or a dedicated follow-up) should add the TASK-770 plan Insertion Contract slots to WorkflowCanvas.tsx: stepRects Map state, containerRect state, useLayoutEffect with ResizeObserver, useWorkflowTokenAnimation call, token coordinate interpolation, and <WorkflowCanvasEdges> mount. Verify AC8 greps pass after that wiring lands.
- **resolved_by:** 

## FIND-SPRINT-040-10
- **source:** TASK-771 (code-reviewer)
- **type:** bug
- **severity:** high
- **status:** resolved
- **location:** main/src/orchestrator/stepTransitionBridge.ts:62-68 + main/src/orchestrator/trpc/routers/runs.ts:286 + frontend/src/hooks/useWorkflowPhaseState.ts:75-81
- **description:** StepId namespace mismatch across the workflow phase chain. The orchestrator emits and persists `current_step_id` in dot-notation `phase.step` form (e.g. `'execute.implement'`, `'compound.extract'` — see `TERMINAL_STEP_IDS` in stepTransitionBridge.ts and migration011 fixture `'execute.implement'`). However, `WORKFLOW_DEFINITIONS` in shared/types/workflows.ts declares `WorkflowStep.id` values as bare strings (e.g. `'implement'`, `'context'`, `'tasks'`, `'extract'`). The consumer chain compares dot-form against bare form: (a) the `getPhaseState` query handler does `flatSteps.findIndex((s) => s.id === currentStepId)` at runs.ts:286 — will always return -1 in production, producing all-`'pending'` stepStates; (b) the new `useWorkflowPhaseState` hook's `mergeTransition` does `orderedIds.indexOf(event.stepId)` at line 75-81, which will also return -1 in production and silently drop every real transition event via its defensive guard. TASK-771's unit tests pass because the fixture uses bare ids `'s1','s2','s3'`. The mismatch was inherited from TASK-766 (handler) and TASK-765 (bridge), so the hook is not the source — but TASK-771 makes the impact visible end-to-end (canvas will render but never update). This is the type of silent-drop pattern called out in CLAUDE.md (FIND-SPRINT-024-4 family).
- **suggested_action:** Pick one canonical form and migrate the other side: either (a) prefix `WorkflowStep.id` with the phase id when serializing (and update `WORKFLOW_DEFINITIONS` lookup paths to match), or (b) change `TERMINAL_STEP_IDS` (and any caller of `buildStepTransitionEvent`) to emit bare step ids. Then update both `getPhaseState`'s lookup and the hook's `mergeTransition` to use the same key. Add an integration test that wires a real `WORKFLOW_DEFINITIONS` entry through `buildStepTransitionEvent` → `getPhaseState` → `useWorkflowPhaseState` to lock in the contract.
- **resolved_by:** TASK-779

## FIND-SPRINT-040-11
- **source:** SPRINT-040 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:185-257 + frontend/src/hooks/useWorkflowPhaseState.ts:115-172
- **description:** Cross-task duplication of the tRPC phase-state wiring pattern. WorkflowProgressTimeline (TASK-768) and useWorkflowPhaseState (TASK-771) each independently implement the same getPhaseState seed-query + onStepTransition subscription with delta-merge state semantics. The timeline declares its own PhaseState interface (line 28-32) mirroring the hooks UseWorkflowPhaseStateResult, manages its own isLoading/loadError, and re-implements the subscribe + setState merge. The hook was specifically designed in TASK-771 as the integration point for live phase state, but TASK-768 was completed before the hook existed and rolled its own. Both code paths will need to be kept in sync as the contract evolves (current/future step timestamps, error-shape, race rules).
- **suggested_action:** Retrofit WorkflowProgressTimeline to consume useWorkflowPhaseState instead of its own seed-query+subscription effects. Replace the local phaseState/stepStates/isLoading/loadError state with `const { definition, currentStepId, stepStates, isLoading, error } = useWorkflowPhaseState(runId);` and drop the two useEffect blocks (lines 198-230 and 233-257). Keep the local streamEvents log projection — thats the timeline-specific concern.
- **resolved_by:** 



Suspected tasks: TASK-768, TASK-771

## FIND-SPRINT-040-12
- **source:** SPRINT-040 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:198-257 vs frontend/src/hooks/useWorkflowPhaseState.ts:118-169
- **description:** Inconsistent subscribe-vs-query race semantics across two consumers of the same tRPC contract. useWorkflowPhaseState (TASK-771) deliberately subscribes BEFORE awaiting trpc.cyboflow.runs.getPhaseState.query so no transition events are missed during the seed-query gap (hook line 130 comment: Subscribe BEFORE awaiting the query so no transition events are missed). WorkflowProgressTimeline (TASK-768) uses two independent useEffect blocks keyed on [runId]: the seed-query effect (line 199-230) and the subscription effect (line 233-257). Both fire on the same render tick, but the querys `.then()` overwrites setStepStates with the seed result regardless of whether the subscription has already applied any deltas — so transition events arriving during the query gap are silently overwritten when the query resolves. Net effect: the timeline can show a stale pending for a step the orchestrator already moved to running if the transition emit beat the query response. Same contract, two different race policies.
- **suggested_action:** Settle on one race policy and apply it everywhere. The hooks subscribe-before-await policy is the safer one (no event loss). Either retrofit the timeline onto the hook (preferred — see FIND-SPRINT-040-11) which inherits the policy for free, or replicate the subscribe-before-query ordering and the merge-rather-than-overwrite semantics in the timelines own effects. Document the chosen policy in a comment on the tRPC contract definition (e.g. on onStepTransition in main/src/orchestrator/trpc/routers/runs.ts) so future consumers dont roll a third variant.
- **resolved_by:** 


Suspected tasks: TASK-768, TASK-771

## FIND-SPRINT-040-13
- **source:** SPRINT-040 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** resolved
- **location:** frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx:297-339
- **description:** WorkflowProgressTimeline is a third casualty of the FIND-SPRINT-040-10 stepId namespace mismatch. Beyond the bridge (dot-form), the getPhaseState handler (bare-form lookup), and the useWorkflowPhaseState hook (bare-form lookup), the timeline also builds `stepStatusMap` from server-supplied `s.stepId` (dot-form in production because runs.ts:286 lookup returns matchIndex=-1 → all pending; subscription events carry dot-form) and then does `stepStatusMap.get(step.id)` with bare `step.id` from WORKFLOW_DEFINITIONS at line 339. Even if the seed-query bug is fixed at the handler level, subscription deltas would still arrive with dot-form stepIds and miss the bare-form map keys on the consumer side. This widens the impact surface of FIND-SPRINT-040-10 to a fourth file — any fix MUST land at all four sites simultaneously or one consumer will silently mis-render.

Suspected tasks: TASK-768, TASK-771, TASK-766, TASK-765
- **suggested_action:** Treat FIND-SPRINT-040-10s remediation as a chain-wide migration: pick one form, then update (1) TERMINAL_STEP_IDS / buildStepTransitionEvent in stepTransitionBridge.ts, (2) the migration 011 column comment, (3) getPhaseStates flatSteps.findIndex in runs.ts:286, (4) the hooks mergeTransition orderedIds.indexOf in useWorkflowPhaseState.ts:75-81, AND (5) the timelines stepStatusMap key derivation + lookup in WorkflowProgressTimeline.tsx:297-339. Add a single integration test that wires the production WORKFLOW_DEFINITIONS through buildStepTransitionEvent → getPhaseState → both consumers to lock in the contract.
- **resolved_by:** TASK-779
