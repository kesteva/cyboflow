---
id: TASK-651
idea: IDEA-018
status: in-flight
created: "2026-05-18T17:45:00Z"
files_owned:
  - main/src/orchestrator/preToolUseHookHelper.ts
  - main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
  - main/src/orchestrator/permissionModeMapper.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/types.ts
  - shared/types/approval.ts
  - node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
acceptance_criteria:
  - criterion: "New file main/src/orchestrator/preToolUseHookHelper.ts exports `routePreToolUseThroughApprovalRouter(pretool, callerId, callerLabel, logger?): Promise<HookJSONOutput>` with the full allow/deny/error semantics shared by both call sites."
    verification: "grep -nE 'export (async )?function routePreToolUseThroughApprovalRouter' main/src/orchestrator/preToolUseHookHelper.ts shows one match; the function signature uses imported types from @anthropic-ai/claude-agent-sdk."
  - criterion: "permissionModeMapper.deferToApprovalRouter delegates to routePreToolUseThroughApprovalRouter and no longer contains the try/catch, allow/deny, or `'Internal approval-router error'` literals locally."
    verification: "grep -n 'Internal approval-router error' main/src/orchestrator/permissionModeMapper.ts returns zero matches; grep -n 'routePreToolUseThroughApprovalRouter' main/src/orchestrator/permissionModeMapper.ts returns at least one match."
  - criterion: "claudeCodeManager.makePreToolUseHook delegates to routePreToolUseThroughApprovalRouter and no longer contains the literal `'Internal approval-router error'` in the function body."
    verification: "grep -nE \"'Internal approval-router error'\" main/src/services/panels/claude/claudeCodeManager.ts returns zero matches; grep -n 'routePreToolUseThroughApprovalRouter' main/src/services/panels/claude/claudeCodeManager.ts returns at least one match."
  - criterion: "The `callerLabel` argument is used to prefix the log line so each delegate keeps its own log identity (e.g. `[PermissionModeMapper]` vs `[ClaudeCodeManager]`)."
    verification: "Unit test 'logger.error prefix matches callerLabel' asserts that two different callerLabel values produce two different log prefixes when the safe-deny branch fires."
  - criterion: "All existing tests pass: permissionModeMapper.test.ts (7 cases) and the claudeCodeManager pre-tool-use tests stay green."
    verification: pnpm --filter cyboflow-main test -- permissionModeMapper claudeCodeManager exit 0; counts at least 7 + N existing claudeCodeManager.test.ts cases.
  - criterion: "New test file main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts exercises the helper directly with five cases: allow, deny-with-message, deny-without-message, updatedInput threading, and ApprovalRouter-throws safe-deny."
    verification: "test -f main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts; pnpm --filter cyboflow-main test -- preToolUseHookHelper reports >= 5 passing cases."
  - criterion: Typecheck and lint stay clean.
    verification: "pnpm typecheck && pnpm lint exit 0."
depends_on:
  - TASK-640
  - TASK-643
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: Pure-extraction refactor with two callers; each branch (allow / deny-with-message / deny-without-message / updatedInput / safe-deny) needs at least one unit test on the new helper. The two existing test suites (permissionModeMapper.test.ts and claudeCodeManager.test.ts) become regression coverage for the delegation wiring.
  targets:
    - behavior: "routePreToolUseThroughApprovalRouter returns permissionDecision:'allow' with updatedInput when ApprovalRouter returns { behavior: 'allow', updatedInput: {...} }."
      test_file: main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
      type: unit
    - behavior: "routePreToolUseThroughApprovalRouter returns permissionDecision:'deny' with permissionDecisionReason when ApprovalRouter returns { behavior: 'deny', message: 'because' }."
      test_file: main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
      type: unit
    - behavior: "routePreToolUseThroughApprovalRouter omits permissionDecisionReason (not undefined — the key is absent) when ApprovalRouter returns { behavior: 'deny' } with no message."
      test_file: main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
      type: unit
    - behavior: "ApprovalRouter.requestApproval throwing yields permissionDecision:'deny' with permissionDecisionReason:'Internal approval-router error'. The thrown error's message appears in logger.error with the callerLabel prefix."
      test_file: main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
      type: unit
    - behavior: "Two different callerLabel arguments produce two distinct log prefixes (e.g. [PermissionModeMapper] vs [ClaudeCodeManager]) when the safe-deny branch fires."
      test_file: main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
      type: unit
---
# Hoist shared `preToolUseHook` logic — eliminate `deferToApprovalRouter` / `makePreToolUseHook` duplication

## Objective

Extract the shared ApprovalRouter routing body that currently exists byte-for-byte in two places — `permissionModeMapper.deferToApprovalRouter` (`main/src/orchestrator/permissionModeMapper.ts:40-82`) and `claudeCodeManager.makePreToolUseHook` (`main/src/services/panels/claude/claudeCodeManager.ts:481-519`) — into a single `routePreToolUseThroughApprovalRouter` helper. Both call sites then delegate to the helper, parameterizing only the log prefix.

This closes FIND-SPRINT-018-4: a future SDK `PreToolUseHookOutput` shape change (new `decisionReason` field, richer `ApprovalDecision` branches, additional metadata) will only need one edit instead of two parallel edits.

## Implementation Steps

1. **Create `main/src/orchestrator/preToolUseHookHelper.ts`** exporting:
   ```ts
   import type { HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
   import { ApprovalRouter } from './approvalRouter';
   import type { LoggerLike } from './types';

   export async function routePreToolUseThroughApprovalRouter(
     pretool: PreToolUseHookInput,
     callerId: string,
     callerLabel: string,
     logger?: LoggerLike,
   ): Promise<HookJSONOutput> { /* ... */ }
   ```
   Body lifts the existing try/catch from `permissionModeMapper.deferToApprovalRouter` verbatim. Log prefix changes from hardcoded `'[permissionModeMapper]'` to template `\`[\${callerLabel}]\``. The safe-deny reason `'Internal approval-router error'` stays as a literal — it's the canonical user-facing message.

2. **Update `permissionModeMapper.deferToApprovalRouter`**: delete the body, replace with `return routePreToolUseThroughApprovalRouter(pretool, runId, 'PermissionModeMapper', logger)`. Drop the now-unused `import { ApprovalRouter }` if no other call site uses it (likely keep — the 'acceptEdits' fast-path still references the auto-approve list, which is local).

3. **Update `claudeCodeManager.makePreToolUseHook`**: delete the body, replace with `return routePreToolUseThroughApprovalRouter(pretool, panelId, 'ClaudeCodeManager', this.logger)`. The `socketReply` argument (currently `() => {}`) is folded into the helper's internal default.

4. **Verify behavior parity** by running the two existing test suites unchanged:
   - `pnpm --filter cyboflow-main test -- permissionModeMapper.test.ts`
   - `pnpm --filter cyboflow-main test -- claudeCodeManager`

5. **Add the new test file** `main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts` with the 5 cases listed in `test_strategy.targets`. Mock `ApprovalRouter.getInstance` via `vi.spyOn` the same way `permissionModeMapper.test.ts` does (lines 27-49).

6. **Run full typecheck + lint + test**:
   ```bash
   pnpm typecheck && pnpm lint
   pnpm --filter cyboflow-main test
   ```

## Acceptance Criteria

See frontmatter. The two grep checks (`'Internal approval-router error'` literal absence in both callers, `routePreToolUseThroughApprovalRouter` reference present in both) are the structural tripwire — if a future maintainer re-inlines the body in one place, the grep AC catches the regression.

## Test Strategy

5 vitest cases in the new test file exercise every branch directly on the helper. The two existing test suites stay unchanged as regression coverage for the wiring (they should pass without modification).

## Hardest Decision

Where the helper lives. Chose `main/src/orchestrator/` rather than `main/src/services/panels/claude/`: the helper has no panel- or Claude-specific logic, and the integration task (TASK-650) plus future helpers will want to import from `orchestrator/` without crossing the panel boundary. `ApprovalRouter` is already in `orchestrator/`, so this stays in the standalone-typecheck-clean region.

## Rejected Alternatives

- **Keep both implementations and add a lint rule** that diffs them. Rejected — drift-prevention without consolidation requires constant vigilance; one source of truth is cheaper.
- **Inline the helper body into each caller via a code-gen template**. Rejected — the project doesn't use code-gen and adding one for a 30-line function is over-engineering.
- **Make the helper non-async and return a Promise constructor wrapper around `ApprovalRouter.requestApproval`**. Rejected — async/await on a Promise-returning method is more readable and matches the existing two call sites.

## Lowest Confidence Area

Whether `claudeCodeManager.makePreToolUseHook` uses a non-trivial `socketReply` argument that the helper needs to expose as a parameter. The current implementation at `claudeCodeManager.ts:495` passes `() => {}` as the fourth argument to `requestApproval`. If the legacy panel relies on a richer socketReply for any code path (e.g. streaming the decision back to the renderer over a WebSocket), the helper needs a `socketReply?: (...) => void` param. Discovery: search `claudeCodeManager.ts` for any other `requestApproval` call site; if none with a real socketReply, the no-op default is safe.
