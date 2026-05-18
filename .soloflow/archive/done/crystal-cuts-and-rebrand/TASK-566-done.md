---
id: TASK-566
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Extracted getDevDebugLogPath + appendDevDebugLog helpers into main/src/utils/devDebugLog.ts; replaced 9 inline hardcoded path/format blocks in main/src/index.ts."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-566 — Done

## Outcome

New `main/src/utils/devDebugLog.ts` exports `DevLogStream` + `DevLogLevel` types, `getDevDebugLogPath(stream)`, and `appendDevDebugLog(stream, level, source, message, originalConsole?)`. Replaced 9 inline blocks in `main/src/index.ts` (reset block, frontend webContents listener, 5 console method overrides, dev-mode console:log IPC handler). Filename literals `cyboflow-frontend-debug.log` / `cyboflow-backend-debug.log` now live in exactly one source location (the `FILENAMES` record). Recursion guard preserved at every override site by passing `{ error: originalError }`.

Side benefit: removed a latent recursion hazard in the prior `console.debug` override (it called wrapped `console.error`; now uniformly routes through `originalError`).

## Verification

- Sweep grep: filename literals confined to devDebugLog.ts.
- Main typecheck + lint: exit 0.
- 6 unit tests passing (path routing, byte-equivalent line format, error-swallow contract).
- Verifier APPROVED round 1.
- Code reviewer CLEAN.

## Findings

- New: FIND-SPRINT-014-12 (planner self-contradiction on file count — test file is plan-prescribed but not in files_owned)

## Commits

- `3dd37a5` feat(TASK-566): extract dev-debug-log helpers to eliminate 9 hardcoded path blocks
