---
id: TASK-660
sprint: SPRINT-021
epic: orchestrator-and-trpc-router
status: done
summary: "Guard legacy permission-bridge wiring in RunLauncher behind !runExecutor; wire placeholder RunExecutor in index.ts so SDK launch path bypasses sentinels."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-660 — Done report

## Outcome
- Inverted four constructor invariant throws in `main/src/orchestrator/runLauncher.ts` to fire only when `runExecutor` is absent.
- Wrapped `writeForRun` + `nodeResolver/orchSocketProvider/bridgeScriptResolver` calls in the same `!this.runExecutor` guard. Worktree creation + status='starting' UPDATE remain unconditional.
- Wired `placeholderRunExecutor` + `nopSpawner` in `main/src/index.ts` (10th arg to RunLauncher) so the SDK substrate is now exercised; legacy sentinels remain as defense-in-depth (Option A path).
- Added 4 vitest cases in `runLauncher.test.ts` (SDK-skip x2 + legacy regression + constructor). All 21 tests in file pass; 449/449 in main suite.

## Commits
- `a3d2c50` feat(TASK-660): guard legacy permission-bridge in RunLauncher behind !runExecutor
- `02fc7df` test(TASK-660): add SDK-guard unit tests for RunLauncher (3 new + 1 constructor case)
- `596948b` feat(TASK-660): wire placeholder RunExecutor in index.ts to bypass sentinel on launch

## Verifier verdict
APPROVED_WITH_DEFERRED — AC5 manual smoke deferred. The backend-debug.log was stale (from before the fix); needs a fresh `pnpm dev` + Start Run + grep to confirm `orchSocketProvider not yet wired` no longer appears under SDK launch path. Queued as deferred item (testing bucket).

## Code-reviewer verdict
CLEAN — no findings. `@cyboflow-hidden [TASK-661]` marker on nopSpawner/placeholderRunExecutor is the forward-placeholder category per docs/CODE-PATTERNS.md.

## Open follow-ups
- TASK-661 replaces nopSpawner with the real ClaudeCodeManager spawner.
- TASK-662 composes runEventBridge wiring.
