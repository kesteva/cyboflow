---
id: TASK-002
sprint: SPRINT-001
epic: crystal-cuts-and-rebrand
status: done
summary: "Removed bull import + WorktreeNameGenerator API hop from taskQueue.ts and index.ts; replaced API-driven naming with deterministic local slug helpers."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-002 — Delete Bull Import and WorktreeNameGenerator API Hop

## Commits

- `daa0165 refactor(TASK-002): remove bull import and WorktreeNameGenerator API hop`

## Changes

- Removed `import Bull from 'bull'` and `WorktreeNameGenerator` from `taskQueue.ts`
- Deleted `main/src/services/worktreeNameGenerator.ts`
- Replaced `useSimpleQueue` conditional with unconditional `SimpleQueue`
- Added local deterministic helpers `generateSessionNameFromPrompt` / `generateWorktreeNameFromPrompt`
- Stripped `WorktreeNameGenerator` from `main/src/index.ts`, `main/src/ipc/session.ts`, `main/src/ipc/types.ts`
- Removed `bull` and `@anthropic-ai/sdk` from root `package.json` dependencies

## Verification

All 8 acceptance criteria passed (verifier confirmed). `pnpm run build:main && pnpm typecheck` exit 0.

## Carryover findings

- FIND-SPRINT-001-5: `main/package.json` (workspace sub-package) still declares `bull@^4.16.3`, `@types/bull@^4.10.0`, `@anthropic-ai/sdk@^0.60.0`. Plan listed only root `package.json` in `files_owned`, so executor was scope-correct. Follow-up task needed to purge from install graph.

Code-review verdict: CLEAN (1 minor: duplicate slug logic between `taskQueue.ts` helper and inline `ipc/session.ts:1373-1380`).
