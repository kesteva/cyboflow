---
id: TASK-352
sprint: SPRINT-009
epic: workflow-runs-and-day3-gate
status: done
summary: "Deterministic worktree naming (cyboflow/<workflow>/<runId8>) + RunLauncher with idempotent .gitignore mutation"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-352 Done

## Outcome

- `WorktreeManager.createDeterministicWorktree(projectPath, workflowName, runId, baseBranch?)` lands the path/branch scheme `<projectPath>/.cyboflow/worktrees/<workflow>/<runId8>` and `cyboflow/<workflow>/<runId8>`, guarded by `withLock('worktree-create-<projectPath>-<runId8>')`.
- The legacy `createWorktree` body was extracted into a private `_createAtPath` helper so both API paths share the git-worktree-add logic without duplication; legacy session callers see no API change.
- `RunLauncher.launch(workflowId, projectPath)` orchestrates `ensureGitignoreEntry` → `getById` → `createRun` → `createDeterministicWorktree` → `UPDATE workflow_runs SET worktree_path, branch_name, status='starting'` in a single statement.
- `RunLauncher.ensureGitignoreEntry` is idempotent across all three branches (file missing → create; entry absent → append; entry present (with or without trailing slash) → no-op). Newline-preserving suffix logic locked down by a dedicated test.

## Verification

- Vitest: 203/203 across 20 files; 12 new tests across the two new test files (1 real-git temp-repo integration test).
- Typecheck: clean across `frontend`, `main`, `shared`.
- Lint: 0 errors; pre-existing warnings unchanged.
- Visual: not_applicable (services/orchestrator only; no UI).

## Deferred

- FIND-SPRINT-009-2 (low) — orphan `workflow_runs` row if `createDeterministicWorktree` throws after `createRun` inserted. Per code-reviewer, the rollback strategy depends on lifecycle layering (status flip vs. error table); right home is the IPC-wiring task that has full lifecycle context. Surfaces in compound's findings queue.
