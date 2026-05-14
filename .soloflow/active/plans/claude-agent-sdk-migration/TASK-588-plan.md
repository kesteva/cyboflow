---
id: TASK-588
idea: IDEA-014
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - shared/types/approval.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/permissionManager.ts
files_readonly:
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/services/mcpPermissionServer.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/tsconfig.json
  - shared/types/claudeStream.ts
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-579-plan.md
acceptance_criteria:
  - criterion: "shared/types/approval.ts exists and exports both ApprovalRequest and ApprovalDecision as named exports with the exact field shapes currently defined in approvalRouter.ts (ApprovalRequest: id/runId/toolName/input/timestamp; ApprovalDecision: behavior/updatedInput?/message?)"
    verification: "test -f shared/types/approval.ts && grep -c 'export interface ApprovalRequest' shared/types/approval.ts | grep -q '^1$' && grep -c 'export interface ApprovalDecision' shared/types/approval.ts | grep -q '^1$'"
  - criterion: "main/src/orchestrator/approvalRouter.ts no longer defines the ApprovalRequest or ApprovalDecision interfaces inline; instead it re-exports them from shared/types/approval.ts so existing consumers' import paths remain backward-compatible"
    verification: "grep -E '^export (interface|type) (ApprovalRequest|ApprovalDecision)\\b' main/src/orchestrator/approvalRouter.ts returns 0 matches AND grep -E \"export (type )?\\{[^}]*(ApprovalRequest|ApprovalDecision)[^}]*\\}.*from ['\\\"][^'\\\"]*shared/types/approval['\\\"]\" main/src/orchestrator/approvalRouter.ts returns at least 1 match"
  - criterion: "Existing consumers (cyboflowPermissionIpcServer.ts, cyboflowPermissionBridge.ts, mcpPermissionServer.ts, approvalRouter.test.ts) continue to import ApprovalRequest / ApprovalDecision from '../orchestrator/approvalRouter' (or relative equivalents) without modification — the re-export keeps the existing import surface intact"
    verification: "grep -rn \"from ['\\\"]\\.\\./orchestrator/approvalRouter['\\\"]\" main/src/services main/src/orchestrator/__tests__ returns at least 3 matches AND none of those files' import lines were modified by this task (git diff TASK-588 commit shows no changes to those file paths)"
  - criterion: "main/src/services/permissionManager.ts either imports from shared/types/approval.ts OR contains a documented divergence note in a file-header comment block referencing 'shared/types/approval.ts' as the canonical substrate-portable contract"
    verification: "grep -E \"from ['\\\"].*shared/types/approval['\\\"]\" main/src/services/permissionManager.ts returns at least 1 match OR head -20 main/src/services/permissionManager.ts | grep -q 'shared/types/approval'"
  - criterion: pnpm --filter main typecheck exits 0 — no consumer of ApprovalRequest/ApprovalDecision breaks
    verification: "cd main && pnpm typecheck exits 0"
  - criterion: pnpm --filter main lint exits 0 — no unused-import or no-explicit-any violations introduced
    verification: "cd main && pnpm lint exits 0"
  - criterion: Existing main/src/orchestrator/__tests__/approvalRouter.test.ts passes unmodified (case count unchanged from pre-task baseline)
    verification: "cd main && pnpm test -- approvalRouter exits 0; record case count in done report and confirm it matches the pre-task baseline (run once before starting the task to capture baseline)"
depends_on: []
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "This is a pure type-relocation refactor. The canonical types move from `main/src/orchestrator/approvalRouter.ts` to a new `shared/types/approval.ts`, and `approvalRouter.ts` re-exports them so consumers' import surface is unchanged. Behavior is byte-identical. Sibling-test scan: ran the directory-level scan for every file in files_owned per refiner rule 5b. (a) `shared/types/` has no `__tests__/` subdirectory and no `.test.ts` siblings (verified via `Glob shared/types/__tests__/*` → no files; `Glob shared/types/*.test.ts` → no files). (b) `main/src/orchestrator/__tests__/` contains `approvalRouter.test.ts` — this test IS the regression gate for ApprovalRouter and runs UNCHANGED as part of the AC `pnpm test -- approvalRouter exits 0`. It is named in `files_readonly` (not modified, only executed). (c) `main/src/services/__tests__/` contains `claudeCodeManagerPermissions.test.ts` and `claudeCodeManagerWiring.test.ts`; neither imports `PermissionManager` nor `permissionManager.ts` (verified at plan time — TASK-579-plan.md AC and SPRINT-006-findings record `permissionManager.ts` as having zero live importers in production code). The existing `approvalRouter.test.ts` (executed via the AC) is sufficient regression coverage: it imports `ApprovalDecision` via the `approvalRouter` re-export path, so a broken re-export surfaces as a test-import failure. `pnpm typecheck` is the primary structural gate; the existing test is the primary behavioral gate."
---
# Extract ApprovalRequest / ApprovalDecision into shared/types/approval.ts

## Objective

Establish `shared/types/approval.ts` as the canonical, substrate-portable home for the `ApprovalRequest` and `ApprovalDecision` interfaces, locking the orchestrator-side approval contract before any SDK substrate work begins (per the EPIC's portability invariant). The move must be **zero behavior change** and **zero churn to consumers' import paths**: `main/src/orchestrator/approvalRouter.ts` retains its public re-exports so every existing consumer (`cyboflowPermissionIpcServer.ts`, `cyboflowPermissionBridge.ts`, `mcpPermissionServer.ts`, `approvalRouter.test.ts`) keeps compiling without edits. `permissionManager.ts` is the EPIC's named "consumer" but in reality it has zero live importers (verified via TASK-579's plan-time grep) and is slated for deletion in `crystal-cuts-and-rebrand`; we therefore add a header-comment divergence note rather than churning its `sessionId`-based local types on the way to the bin.

## Implementation Steps

1. **Create `shared/types/approval.ts`** with the exact two interface bodies currently at `main/src/orchestrator/approvalRouter.ts:37-51`. File header should include a JSDoc block explaining: (a) this is the substrate-portable approval contract per the `claude-agent-sdk-migration` EPIC §"Portability invariant"; (b) it stays free of runtime imports — the only thing exported is two interfaces; (c) error classes (`RunNotRunningError`, `ApprovalNotFoundError`) intentionally remain in `approvalRouter.ts` because they are tied to the router's state machine, not the wire contract. File content (exact):
   ```ts
   /**
    * Substrate-portable approval contract.
    *
    * Canonical home for `ApprovalRequest` and `ApprovalDecision`. These types are
    * the public surface that the in-process approval router (today:
    * `main/src/orchestrator/approvalRouter.ts`) exposes to every transport
    * adapter — the SDK PreToolUse hook (claude-agent-sdk-migration EPIC), the
    * legacy MCP bridge (being deleted by the same EPIC), and any future
    * interactive-shell hook (IDEA-013).
    *
    * Invariants:
    *  - Pure type module: NO runtime imports.
    *  - NO substrate-specific fields (no MCP-specific, no SDK-specific, no shell
    *    hook fields). Anything substrate-specific belongs in the transport
    *    adapter, not this file.
    *  - Field shapes are wire-stable: changing them is a breaking change to
    *    every transport adapter and the review-queue UI.
    *
    * Runtime errors (`RunNotRunningError`, `ApprovalNotFoundError`) deliberately
    * stay in `main/src/orchestrator/approvalRouter.ts` because they describe
    * the router's internal state machine, not the wire contract.
    */

   export interface ApprovalRequest {
     /** UUID for the approvals row */
     id: string;
     /** workflow_runs.id */
     runId: string;
     toolName: string;
     input: Record<string, unknown>;
     timestamp: number;
   }

   export interface ApprovalDecision {
     behavior: 'allow' | 'deny';
     updatedInput?: Record<string, unknown>;
     message?: string;
   }
   ```

2. **Refactor `main/src/orchestrator/approvalRouter.ts`** to delete the inline interface bodies at lines 37-51 and replace them with a re-export from `shared/types/approval.ts`. Everything else in the file stays byte-identical. The re-export must preserve the existing **named-import** surface — every consumer today writes `import { ApprovalRouter, type ApprovalDecision } from '../orchestrator/approvalRouter';` and that line must keep resolving without modification. Concretely, at the top of `approvalRouter.ts` (after the existing `import type { DatabaseLike } from './types';` line):
   ```ts
   // Public approval contract — canonical home is shared/types/approval.ts.
   // Re-exported here so every existing consumer keeps `from '../orchestrator/approvalRouter'`
   // as its import path; that path remains backward-compatible by design.
   export type { ApprovalRequest, ApprovalDecision } from '../../../shared/types/approval';
   ```
   The relative path is `../../../shared/types/approval` from `main/src/orchestrator/` because `shared/` is at the repo root and `main/tsconfig.json` already includes `../shared/**/*` (verified). Internal uses inside `approvalRouter.ts` of `ApprovalRequest` / `ApprovalDecision` (parameter types, internal `PendingEntry`, the `'approvalCreated'` emit, etc.) continue to type-check against the re-exported names — no other changes inside this file. Errors (`RunNotRunningError`, `ApprovalNotFoundError`) and the `ApprovalRouter` class stay exactly where they are.

3. **Add a divergence-note header to `main/src/services/permissionManager.ts`.** Do NOT rename `sessionId` → `runId` and do NOT swap `PermissionRequest` / `PermissionResponse` for `ApprovalRequest` / `ApprovalDecision` inside this file — `permissionManager.ts` is dead code (zero live importers; sole non-test importer `mcpPermissionServer.ts` is itself dead per SPRINT-006 findings) and is scheduled for deletion under TASK-579 in the `crystal-cuts-and-rebrand` epic. Churning its types now would create merge friction with TASK-579 and burn engineering on a file slated for deletion. Instead, prepend the existing file with this block (above the current `import { EventEmitter } from 'events';` on line 1):
   ```ts
   /**
    * @deprecated DEAD CODE — scheduled for deletion in TASK-579
    * (epic: crystal-cuts-and-rebrand). Zero production importers as of the
    * claude-agent-sdk-migration EPIC; the production approval path runs through
    * `main/src/orchestrator/approvalRouter.ts` and the canonical wire types live
    * in `shared/types/approval.ts`.
    *
    * The `PermissionRequest` / `PermissionResponse` interfaces below are Crystal-
    * era types and diverge from the canonical substrate-portable contract in
    * `shared/types/approval.ts` — notably `PermissionRequest.sessionId` is the
    * Crystal-era equivalent of `ApprovalRequest.runId`. They are intentionally
    * NOT aligned here; this file's death (TASK-579) is the alignment.
    */
   ```
   The leading `shared/types/approval.ts` reference inside this header is what AC #4's grep matches. No other line in `permissionManager.ts` changes.

4. **Sweep grep for any remaining inline definitions and verify import surface.** Run these checks before reporting COMPLETED:
   ```bash
   grep -nE '^export (interface|type) (ApprovalRequest|ApprovalDecision)\b' main/src/orchestrator/approvalRouter.ts
   # Expected: 0 lines.

   grep -rn "from ['\"]\.\./orchestrator/approvalRouter['\"]" main/src/services main/src/orchestrator/__tests__
   # Expected: at least 3 matches.

   grep -rn "from ['\"].*shared/types/approval['\"]" main/src
   # Expected: 0 matches outside main/src/orchestrator/approvalRouter.ts.
   ```

5. **Run gates:**
   ```bash
   cd main && pnpm typecheck
   cd main && pnpm lint
   cd main && pnpm test -- approvalRouter
   ```
   All three must exit 0. Record the `approvalRouter.test.ts` case count in the done report and verify it equals the pre-task baseline.

## Acceptance Criteria

1. **Canonical file exists with correct exports.** `shared/types/approval.ts` exists; `grep -c 'export interface ApprovalRequest'` and `grep -c 'export interface ApprovalDecision'` each return `1`.
2. **`approvalRouter.ts` re-exports rather than defines.** The two inline `export interface` blocks at lines 37-51 are gone; a re-export statement from `../../../shared/types/approval` exists.
3. **Consumers unchanged and still resolve.** `cyboflowPermissionIpcServer.ts`, `cyboflowPermissionBridge.ts`, and `approvalRouter.test.ts` continue to import `ApprovalDecision` (and `ApprovalRequest` where applicable) from `../orchestrator/approvalRouter`. No diff to those files.
4. **`permissionManager.ts` divergence is documented.** The file gains a JSDoc header referencing `shared/types/approval.ts` as the canonical contract; the Crystal-era local types stay untouched.
5. **Typecheck green.** `pnpm --filter main typecheck` exits 0.
6. **Lint green.** `pnpm --filter main lint` exits 0.
7. **Test green, case count unchanged.** `pnpm --filter main test -- approvalRouter` exits 0; case count matches the captured pre-task baseline.

## Test Strategy

No new test file is required. This is a type-relocation refactor with zero behavior change. The existing `main/src/orchestrator/__tests__/approvalRouter.test.ts` is the regression gate: it already imports `ApprovalDecision` via the `approvalRouter` re-export path, so a broken re-export surfaces immediately as either a TypeScript compile error in vitest or a module-resolution failure at test-load time. `pnpm typecheck` provides the structural gate. The combination — typecheck + the existing test file passing unchanged with the same case count — is sufficient and proportionate.

## Hardest Decision

**Should `permissionManager.ts` be aligned (option a) or documented-as-divergent (option b)?** The EPIC's stated intent is "consume only this interface" (alignment). Option (a) means renaming `PermissionRequest.sessionId` → `runId`, swapping the local `PermissionResponse` (structurally identical to `ApprovalDecision`) for an import alias, and updating internal field references. Option (b) means a header comment and no code churn.

**Chosen: option (b).** Two facts dominate:

- `permissionManager.ts` has zero live importers in production. The EPIC's "consume only this interface" goal is already satisfied at the system level — the production approval path runs through `ApprovalRouter`, not `PermissionManager`. There is no consumer whose contract narrows by aligning this file's local types.
- TASK-579 (`crystal-cuts-and-rebrand` epic) is queued to delete `permissionManager.ts` entirely. Option (a) would rename fields in a file slated for deletion, creating merge friction with TASK-579 for no behavioral upside.

Option (b) honors the EPIC's portability invariant at the system level (the canonical contract lives in `shared/types/`, the production router consumes it, the future SDK adapter will consume it) without sinking effort into a tombstoned file. The header comment makes the divergence explicit and points future readers at the canonical home — that is the load-bearing "documentation" piece.

## Rejected Alternatives

- **Option (a): full alignment of `permissionManager.ts` types.** Rejected as above — burns effort on a file that's slated for deletion (TASK-579) and creates merge friction with that task.
- **Make `approvalRouter.ts` a thin shim that re-exports everything from `shared/types/approval.ts`, including the error classes.** Rejected. The error classes describe the router's internal state machine and are thrown by the runtime logic in `approvalRouter.ts` itself; they are not part of the substrate-portable wire contract.
- **Migrate every consumer to import from `shared/types/approval` directly and drop the re-export from `approvalRouter.ts`.** Rejected for scope discipline. That migration is a strict superset of this task and risks breaking the IPC bridge / test file in a refactor whose stated invariant is "zero consumer churn."

## Lowest Confidence Area

**Sibling-coordination with TASK-579.** TASK-579 (`crystal-cuts-and-rebrand` epic) lists `main/src/services/permissionManager.ts` in its `files_owned`, and this task also edits that file (adds a header comment). Both tasks have `depends_on: []`. TASK-579's status is `ready`, not done. If TASK-579 runs first and deletes the file, our header-comment edit becomes moot but does no harm (delete wins). If our task runs first and adds the header comment, TASK-579's deletion still proceeds cleanly (the file just has one extra block before deletion). The two cannot meaningfully conflict because they touch disjoint parts of the file (header comment vs. whole-file deletion). The orchestrator's sibling-files-owned check may flag the overlap — if so, this confidence-area note is the rationale for accepting it. If the orchestrator hard-blocks the overlap, the fallback is to make this task `depends_on: [TASK-579]` and skip step 3 entirely.
