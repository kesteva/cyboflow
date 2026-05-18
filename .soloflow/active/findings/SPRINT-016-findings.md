---
sprint: SPRINT-016
pending_count: 2
last_updated: 2026-05-18
---

# Findings Queue

## FIND-SPRINT-016-2
- **source:** TASK-602 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/plans/orchestrator-and-trpc-router/TASK-602-plan.md (and skill: plan-author guidance)
- **description:** TASK-602's plan contains a self-contradictory AC pair. AC6 mandates "The new spec uses real preload.ts whitelist (post-TASK-599 fix) — i.e. the spec depends on TASK-599's wrapper-storage fix and would fail if TASK-599 regressed" (verification: grep for `electron.on.*cyboflow:stream\|subscribeToStreamEvents` in `tests/cyboflow-stream-publisher.spec.ts`). The plan body's Step 6, however, explicitly authorizes a Vitest fallback that mocks `getMainWindow` and bypasses preload.ts entirely ("If the existing Playwright config can't easily start the Electron app, fall back to a Vitest integration test that mocks getMainWindow"), and the "Lowest Confidence Area" section reinforces the same downgrade path. The executor took the authorized fallback, which produces a passing spec that cannot detect a TASK-599 regression — violating AC6's stated regression-canary intent while complying with the plan body. Verifier had to make a judgment call between literal-AC and plan-body intent.
- **suggested_action:** Plan-author guidance: when an AC describes a load-bearing regression canary (e.g. "would fail if TASK-X regressed"), the plan body MUST NOT authorize a fallback that breaks that canary property. Either (a) downgrade the AC to "the spec exercises the publisher path" without the cross-task dependency claim, or (b) require the executor to escalate to HUMAN_NEEDED rather than silently take the documented fallback. Consider adding to the planner skill a rule: "fallback authorizations must be checked against every AC's verification predicate; if any predicate would no longer hold under the fallback, the AC must be revised or the fallback removed."
- **resolved_by:**

## FIND-SPRINT-016-1
- **source:** TASK-599 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md (or AGENTS.md/CLAUDE.md executor guidance)
- **description:** TASK-599 executor reported the implementation complete with `test_strategy.needed: false` because `preload.ts` has no sibling test file, then skipped running `pnpm --filter main typecheck`. The committed change introduced a real TS error (`src/preload.ts(627,60): error TS2345 — wrapper type incompatible with Map value type`). The executor's "no sibling tests → no verification" inference is wrong for files that are still typechecked at the workspace level. CLAUDE.md lists `pnpm typecheck` in Common Commands but does not explicitly tell executors to run it after editing `main/src/preload.ts` or similar untested-but-type-checked files.
- **suggested_action:** Add an executor guidance line: "When modifying TS files that lack sibling tests, you must still run the workspace `typecheck` (and `lint`) for that workspace before claiming completion." Consider codifying it under TypeScript Rules in CLAUDE.md.
- **resolved_by:**
