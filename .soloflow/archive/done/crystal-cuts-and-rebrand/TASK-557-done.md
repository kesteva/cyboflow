---
id: TASK-557
sprint: SPRINT-002
epic: crystal-cuts-and-rebrand
status: done
summary: "Removed @anthropic-ai/sdk, bull, @types/bull from main/package.json and regenerated pnpm-lock.yaml. Lockfile also dropped the stranded openai root-importer entry, restoring manifest-vs-lockfile invariant."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-557 — Done

Workspace dependency cleanup. Three packages were already removed from the root `package.json` by TASK-002, but the `main/` sub-package's manifest still declared them, and `pnpm-lock.yaml` was never regenerated — meaning `pnpm install --frozen-lockfile` (used in CI) still installed the entire `bull` chain (including `@ioredis/commands`, `msgpackr-extract` natives, `lodash.*`, `denque`, `cron-parser`) plus `@anthropic-ai/sdk`. This task closes that gap.

Changes:
- `main/package.json` — removed `@anthropic-ai/sdk`, `bull`, `@types/bull` (3 lines)
- `pnpm-lock.yaml` — regenerated via `pnpm install`, net -240 lines, dropped corresponding chains plus the stale `openai` root-importer entry per the plan's "Hardest Decision" rationale

All 5 acceptance_criteria pass. The dependency surface area only shrinks; no packages added, no version drift.

Verifier reported a TS2688 typecheck failure on first run — root-caused to a stale `node_modules/@types/bull` symlink that survived `pnpm install --frozen-lockfile` (pnpm doesn't auto-prune undeclared `@types/*` symlinks). Removing the symlink restored a clean typecheck. CI uses fresh checkouts and would never see this.

Pre-existing baseline failures noted (not regressions from this task): one lint error in `frontend/src/components/panels/ai/MessagesView.tsx:50` from TASK-001's commit 2d184f2; vitest failures in `gitStatusManager.test.ts` from the fork-baseline commit 7a5ee42.

Verifier flagged a process finding (FIND-SPRINT-002-2): the executor logged its own finding into `SPRINT-001-findings.md` rather than `SPRINT-002-findings.md`. Audit the executor agent prompt's sprint-id resolution.

Commit: 9949a4b chore: remove bull/@types/bull/@anthropic-ai/sdk from main package + regenerate lockfile
