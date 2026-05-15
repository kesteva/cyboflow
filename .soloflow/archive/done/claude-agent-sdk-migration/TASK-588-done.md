---
id: TASK-588
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Relocate ApprovalRequest/Decision to shared/types/approval.ts; approvalRouter re-exports; permissionManager (dead) gets divergence header."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-588 — Extract approval types to shared/types

## Outcome

Pure type-relocation refactor with zero behavior change. The canonical home for `ApprovalRequest` and `ApprovalDecision` is now `shared/types/approval.ts` (a pure-type module with no runtime imports). `main/src/orchestrator/approvalRouter.ts` uses `import type ... + export type ...` to keep the consumer-facing surface intact — every existing consumer file (`cyboflowPermissionIpcServer.ts`, `cyboflowPermissionBridge.ts`, `mcpPermissionServer.ts`, `approvalRouter.test.ts`) compiles unchanged. `permissionManager.ts` (dead code, slated for deletion in TASK-579) gets a JSDoc divergence header pointing readers at the canonical contract rather than churning its Crystal-era `sessionId`-based local types.

## Files changed

- `shared/types/approval.ts` — new canonical pure-type module
- `main/src/orchestrator/approvalRouter.ts` — interface bodies replaced with `import type` + `export type` re-export; rest byte-identical
- `main/src/services/permissionManager.ts` — JSDoc deprecation/divergence header prepended; body untouched

## Verification

- `pnpm typecheck`: PASS (primary structural gate; broken re-export would surface here)
- `pnpm lint`: PASS (0 errors)
- Verifier verdict: APPROVED_WITH_DEFERRED — single deferred check (`approvalRouter.test.ts` runtime gate) blocked by pre-existing `better-sqlite3` NODE_MODULE_VERSION ABI mismatch (137 vs 127). Resolution: run `pnpm electron:rebuild`. This issue reproduces on `main` pre-task; it is environmental, not a TASK-588 regression. Logged as `FIND-SPRINT-008-1` with dedup_key `better_sqlite3_node_module_version_mismatch`.
- Code-review verdict: CLEAN
- Pre/post test-case count: 8 (unchanged, per AC #7)

## Forward references

- TASK-579 (epic: crystal-cuts-and-rebrand) will delete `permissionManager.ts` — the divergence header dissolves harmlessly with the file.
- Future SDK substrate adapter (TASK-590's `PreToolUse` callback) will import directly from `shared/types/approval.ts`.
- A potential IDEA-013 interactive-shell hook would be a third transport adapter against the same canonical interface — the portability invariant is now physically located in `shared/`.
