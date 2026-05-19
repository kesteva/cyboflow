---
id: TASK-660
idea: IDEA-018
status: in-flight
created: "2026-05-19T00:00:00Z"
files_owned:
  - main/src/orchestrator/runLauncher.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/mcpConfigWriter.ts
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-650-plan.md
  - .soloflow/archive/ideas/IDEA-018.md
acceptance_criteria:
  - criterion: RunLauncher.launch skips `mcpConfigWriter.writeForRun(...)` and the `orchSocketProvider.getSocketPath()` / `bridgeScriptResolver.getScriptPath()` calls when `this.runExecutor` is non-null. The SDK substrate (PreToolUse hook) replaces the .mcp.json permission bridge for SDK-driven runs.
    verification: "grep -nE 'if \\(this\\.runExecutor\\)' main/src/orchestrator/runLauncher.ts shows at least one match guarding the writeForRun call; reading the file confirms the writeForRun + orchSocketProvider.getSocketPath + bridgeScriptResolver.getScriptPath block is INSIDE an `if (!this.runExecutor)` (or equivalent inverted guard); when the guard branch is skipped the existing 'starting' status UPDATE still runs unchanged."
  - criterion: "Constructor invariant checks for `orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver`, and `mcpConfigWriter` are weakened to be optional WHEN `runExecutor` is also passed. If `runExecutor` is null AND any of the four legacy collaborators are missing, the constructor still throws as today. (This preserves the legacy-bridge path's invariants while letting the SDK path skip them.)"
    verification: "grep -nE 'RunLauncher: missing required collaborator' main/src/orchestrator/runLauncher.ts shows the existing throws ONLY guarded by the !runExecutor branch (reading the constructor body confirms the four `if (!collaborator) throw` lines are conditional on `!runExecutor`); a new unit test 'constructor accepts SDK substrate with no legacy collaborators when runExecutor is provided' passes."
  - criterion: "main/src/index.ts no longer wires a throwing sentinel for `orchSocketProvider` or `bridgeScriptResolver`. Either (a) the two sentinel blocks are removed entirely and `undefined` is passed to RunLauncher; OR (b) they are kept as sentinels but RunLauncher is constructed with `runExecutor` so the sentinels are never reached. Choose whichever lands TASK-650 step 10's RunExecutor wiring cleanly."
    verification: "grep -n 'orchSocketProvider not yet wired' main/src/index.ts returns zero matches OR the line still exists but every code path that constructs RunLauncher in main/src/index.ts also passes a non-null runExecutor (verified by reading the constructor call); a new runLauncher unit test case 'no orchSocketProvider call when runExecutor present' passes."
  - criterion: "main/src/orchestrator/__tests__/runLauncher.test.ts adds three new cases: (i) 'launch with runExecutor skips mcpConfigWriter.writeForRun', (ii) 'launch with runExecutor skips orchSocketProvider.getSocketPath' (verified by passing a throwing sentinel and asserting it is NOT called), (iii) 'launch without runExecutor still calls writeForRun and orchSocketProvider' (regression guard for the legacy path)."
    verification: "grep -nE 'launch with runExecutor skips|launch without runExecutor still calls' main/src/orchestrator/__tests__/runLauncher.test.ts returns at least 3 matches; pnpm --filter cyboflow-main test -- runLauncher exits 0."
  - criterion: "When the renderer clicks Start Run with a SDK-substrate RunLauncher wiring, no error containing the string 'orchSocketProvider not yet wired' appears in `cyboflow-backend-debug.log` for the launch."
    verification: "Manual smoke (documented in the plan, not gated by grep): start `pnpm dev`, click Start Run on the auto-seeded 'prune' workflow, then `grep 'orchSocketProvider not yet wired' cyboflow-backend-debug.log` returns zero matches. Recorded as a checkpoint comment in the executor's done report."
  - criterion: Project-wide typecheck and lint pass.
    verification: "pnpm typecheck && pnpm lint exit 0."
depends_on: []
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "The change inverts a constructor invariant that other call sites (orchestrator integration, future IDEA-013 wiring) will rely on. A wrong inversion silently re-enables the legacy bridge path under the SDK substrate — no compiler signal. Three table-driven unit tests pin the guard semantics."
  targets:
    - behavior: launch with runExecutor present does not call mcpConfigWriter.writeForRun
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
    - behavior: launch with runExecutor present does not call orchSocketProvider.getSocketPath (proven by passing a throwing sentinel)
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
    - behavior: launch without runExecutor still calls writeForRun and orchSocketProvider — legacy path regression guard
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
    - behavior: "constructor accepts SDK substrate (runExecutor provided, legacy collaborators undefined) without throwing"
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
---
# Unblock Start Run under SDK substrate — skip the legacy permission-bridge wiring when runExecutor is present

## Objective

`RunLauncher.launch` currently calls `mcpConfigWriter.writeForRun(...)` on every launch (`main/src/orchestrator/runLauncher.ts:117-123`), which dereferences `this.orchSocketProvider.getSocketPath()` and `this.bridgeScriptResolver.getScriptPath()`. In `main/src/index.ts:571-584` both providers are wired as **sentinels that throw** — by design, to fail loud while the IPC server wiring waits on the approval-router epic. The result: every Start Run click currently throws `"cyboflow: orchSocketProvider not yet wired (epic 7 owns permissionIpcServer)"` before the run can spawn Claude.

Under the SDK substrate (`claude-agent-sdk-migration` EPIC — the decided path), permissions are gated in-process via the SDK's `PreToolUse` hook. The `.mcp.json` file that `writeForRun` produces was the entry point for the legacy Unix-socket permission bridge; under SDK it is dead code on every launch. The EPIC's portability invariant says `cyboflowPermissionIpcServer.start()` must stay wired (for the future IDEA-013 interactive-shell pivot) — but the socket is **not on the SDK hot path**.

This task narrows the launch sequence: when `runExecutor` is wired (the SDK path), skip the legacy permission-bridge file write entirely. When `runExecutor` is null (any non-SDK path), the legacy invariants stay in force.

## Implementation Steps

1. **Invert the constructor invariants.** In `main/src/orchestrator/runLauncher.ts:80-85`, wrap the four `throw new Error('RunLauncher: missing required collaborator ...')` lines in `if (!runExecutor) { ... }`. When `runExecutor` is provided, the four legacy collaborators (`mcpConfigWriter`, `orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver`) become optional.

2. **Guard the writeForRun block.** In `runLauncher.ts:114-123` wrap the `await this.mcpConfigWriter.writeForRun({...})` block plus its inputs in `if (!this.runExecutor)`. The block must NOT execute when runExecutor is wired. Keep the worktree creation (`createDeterministicWorktree` at lines 108-112) and the `UPDATE workflow_runs SET worktree_path = ?, branch_name = ?, status = 'starting'` (line 125-129) outside the guard — those run unconditionally.

3. **Update main/src/index.ts wiring.** Two options:
   - **Option A** (preferred when TASK-650's step 10 has not yet landed RunExecutor construction): Leave the throwing sentinels in place (`index.ts:571-584`). They serve as defense-in-depth — if some future code path constructs RunLauncher without runExecutor by accident, the legacy invariants catch it loudly. No change to index.ts other than confirming the sentinel block stays intact.
   - **Option B** (preferred when TASK-650 has landed and `runExecutor` is now passed at construction): Remove the four sentinel blocks (`orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver` — keep `mcpConfigWriter` since it's still injected for the legacy path). Pass `undefined` for the removed collaborators in the RunLauncher constructor call.
   
   Pick A if TASK-650 is still ready/in-flight at executor time; pick B if TASK-650 is done. Document the choice in the done report.

4. **Add three table-driven test cases** to `main/src/orchestrator/__tests__/runLauncher.test.ts`. The existing tests build RunLauncher with concrete stubs for the four legacy collaborators; the new cases pass `runExecutor` and assert the legacy stubs are NOT called.

5. **Manual smoke.** With `pnpm dev`, click Start Run on the seeded "prune" workflow. Confirm `cyboflow-backend-debug.log` no longer contains the `orchSocketProvider not yet wired` string. (Spawning still won't happen end-to-end without TASK-650/661/662 — but the throw is gone, which is the success signal for THIS task.)

6. **Verify locally**: `pnpm typecheck && pnpm lint && pnpm --filter cyboflow-main test`.

## Acceptance Criteria

See `acceptance_criteria` in frontmatter. Each is grep-checkable or test-runnable.

## Test Strategy

See `test_strategy.targets`. Four new vitest cases in `runLauncher.test.ts` pin the guard semantics (two for the new SDK path, one regression guard for the legacy path, one constructor sanity check).

## Hardest Decision

Whether to fully delete the throwing sentinels in `index.ts:571-584` (Option B above) or leave them as defensive guards (Option A). Recommendation: A. The sentinels exist because the legacy collaborators are wired structurally but not functionally; deleting them costs little but takes away the loud-fail signal if someone reintroduces the legacy bridge path inadvertently. After TASK-650 ships `runExecutor` at construction, the sentinels become unreachable in normal operation — they're cheap insurance.

## Rejected Alternatives

- **Replace the sentinels with non-throwing placeholders** (e.g. always return `~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock` from `orchSocketProvider`). Rejected — produces a `.mcp.json` with a dead socket path on every SDK launch; clutters the per-run worktree with unused config and confuses future debugging.
- **Remove `mcpConfigWriter` from RunLauncher entirely.** Rejected — it's still needed for the IDEA-013 pivot per the EPIC's portability invariant. Keep it injected but unused on the SDK path.
- **Fold this change into TASK-650.** Rejected — TASK-650 already owns runLauncher.ts and is high-complexity. Splitting GAP 1 out keeps both tasks reviewable. If the executor finds TASK-650 has not started by the time it picks this up, the executor can choose to fold; the file ownership overlap is acceptable since they sequence naturally.

## Lowest Confidence Area

Option A vs Option B in step 3 — depends on TASK-650's state at executor time. If both tasks land in the same sprint, file-ownership overlap on `runLauncher.ts` is the risk. Mitigation: this task narrows its `runLauncher.ts` diff to the writeForRun guard + constructor inversion — about 15 lines. TASK-650's `runLauncher.ts` touches are elsewhere (step 10 wires RunExecutor construction). A clean rebase is feasible.
