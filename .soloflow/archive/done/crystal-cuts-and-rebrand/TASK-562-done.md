---
id: TASK-562
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Renamed crystalDirectory module to cyboflowDirectory with @deprecated shim; updated 8 in-tree consumers + AboutDialog IPC consumer + scriptPath.ts."
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-562 — Done

## Outcome

Moved canonical implementation to `main/src/utils/cyboflowDirectory.ts` (3 exports renamed: `getCyboflowDirectory`, `getCyboflowSubdirectory`, `setCyboflowDirectory`). Kept `main/src/utils/crystalDirectory.ts` as a 16-line `@deprecated` re-export shim for backward compatibility. New canonical test file `cyboflowDirectory.test.ts` with 5 cases (one new: asserts no fallback to `CRYSTAL_DIR` env var). Old `crystalDirectory.test.ts` deleted.

Consumers updated: `main/src/services/{database,configManager}.ts`, `main/src/utils/logger.ts`, `main/src/index.ts`, `main/src/ipc/{updater,session}.ts`, plus `main/src/orchestrator/mcpServer/scriptPath.ts` (scope deviation — planner missed it in files_owned). IPC field rename in `updater.ts` (`crystalDirectory:` → `cyboflowDirectory:`) propagated to `frontend/src/components/AboutDialog.tsx` (5 sites) after verifier round.

## Verification

- Sweep grep: only `crystalDirectory.ts` (shim) contains legacy identifiers.
- Frontend + main typecheck: exit 0.
- `cyboflowDirectory.test.ts`: 5/5 passing.
- Verifier round 1: NEEDS_CHANGES (frontend consumer missing). Round 2: APPROVED after `061ec63` updated AboutDialog.
- Code reviewer CLEAN (1 minor finding queued: FIND-SPRINT-014-4 stale comment in logger.ts).

## Findings filed

- FIND-SPRINT-014-1: scope_deviation scriptPath.ts (resolved AC-prescribed)
- FIND-SPRINT-014-2: IPCResponse<T = any> anti-pattern enables silent IPC contract breaks (open)
- FIND-SPRINT-014-3: scope_deviation AboutDialog.tsx (resolved by verifier direction)
- FIND-SPRINT-014-4: stale "Crystal directory" comment in logger.ts:30 (open, minor)

## Commits

- `e6f347d` feat(TASK-562): rename crystalDirectory module to cyboflowDirectory with backward-compat shim
- `061ec63` fix(TASK-562): update AboutDialog to read cyboflowDirectory from IPC payload
