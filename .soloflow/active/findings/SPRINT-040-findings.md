---
sprint: SPRINT-040
pending_count: 4
last_updated: "2026-05-27T02:55:00Z"
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
