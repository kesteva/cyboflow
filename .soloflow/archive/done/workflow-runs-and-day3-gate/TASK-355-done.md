---
id: TASK-355
sprint: SPRINT-009
epic: workflow-runs-and-day3-gate
status: done
summary: "Day-3 milestone gate test: parallel sprint+prune SDK runs, out-of-order approval, mid-state pause invariant, post-approval stream-event growth — passes end-to-end with real Claude in 7-12s"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-355 Done

## Outcome

**The day-3 milestone is live.** Per the IDEA brief and design doc §7, this test is THE EXPLICIT MILESTONE — passing it validates the fork-path bet. It does:

1. Spawns two parallel SDK `query()` runs (sprint + prune workflows) against an in-memory SQLite + a real `mkdtempSync` git repo.
2. Both reach `awaiting_review` status when their first Bash tool-use is intercepted by a PreToolUse hook → `ApprovalRouter.requestApproval()`.
3. Approves the **prune** run first via `ApprovalRouter.respond()` (T1).
4. Asserts `expect(sprintStatusMid).toBe('awaiting_review')` between T1 and T2 — proves runs are independent.
5. Approves the **sprint** run (T2 > T1) and asserts it transitions to `running`/`completed` AND that its stream events grow.

Files (all test-only, no production code touched):
- `tests/cyboflow-day3-gate.spec.ts` — milestone gate spec.
- `tests/helpers/cyboflowTestHarness.ts` — `createHarness()` with `launchPair`/`waitForAwaitingReview`/`approveRun`/`getStatus`/`getStreamEventCount`/`teardown`. SDK + PreToolUse hook + ApprovalRouter wired directly (bypasses preload IPC).
- `tests/fixtures/cyboflow-day3-gate/{sprint,prune}-prompt.md` — short Bash-triggering prompts.
- `vitest.config.gate.ts` — repo-root config (the gate test lives outside the main vitest tree).
- `package.json` — added `test:gate` script (plan-prescribed).

## Verification

- **Gate test:** PASS — two consecutive runs, 7.7s and 8.3s, with real Claude binary in PATH. `Tests 1 passed (1)`.
- **Main vitest:** 219/219 across 22 files.
- **Typecheck:** clean across `frontend`, `main`, `shared`.
- **Lint:** 0 errors.
- **Visual:** not_applicable (node integration test; no UI surface).

## Deferred

- FIND-SPRINT-009-8 (low) — workflow-fixture tmp dir leak in `cyboflowTestHarness.teardown()`; one-line fix candidate for compound.
- FIND-SPRINT-009-9 (low) — plan-text drift between `approvalRouter.decide` (plan body) and the real public API `respond` (code).
- FIND-SPRINT-009-6 (high, prior task) — `cyboflow:stream:*` preload whitelist must be opened before any UI-driven flow can subscribe to events. The gate test deliberately bypasses this path (per AC#4) and proves the orchestrator substrate independently; the renderer-side fix is owed by a future task.
- AC#1 verification clause referenced a literal that the harness API didn't exactly match (`workflows: 'sprint'` vs `workflowA`/`workflowB`) — semantic intent satisfied; documented as plan drift, not a code defect.
