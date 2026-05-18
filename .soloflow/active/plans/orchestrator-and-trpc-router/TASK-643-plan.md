---
id: TASK-643
idea: IDEA-018
status: ready
created: "2026-05-18T20:45:00Z"
files_owned:
  - main/src/orchestrator/permissionModeMapper.ts
  - main/src/orchestrator/__tests__/permissionModeMapper.test.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - shared/types/workflows.ts
  - shared/types/approval.ts
  - main/src/orchestrator/types.ts
  - node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
acceptance_criteria:
  - criterion: "permissionModeMapper.ts exports buildPreToolUseHook(mode, runId, logger?) with the exact signature described in Implementation Steps and is callable from RunExecutor."
    verification: "grep -n 'export function buildPreToolUseHook' main/src/orchestrator/permissionModeMapper.ts returns one match; TypeScript build (pnpm --filter cyboflow-main typecheck) passes — the module is importable from the orchestrator surface."
  - criterion: "Mode 'dontAsk' yields undefined (no hook installed) so the SDK runs unrestricted."
    verification: "Unit test 'dontAsk returns undefined' asserts buildPreToolUseHook('dontAsk', 'r1') === undefined and passes under vitest run."
  - criterion: "Mode 'default' returns a HookCallback that routes every PreToolUse input through ApprovalRouter.requestApproval, translating the decision to the SDK's hookSpecificOutput with permissionDecision 'allow' or 'deny'."
    verification: "Unit test 'default mode defers Edit, Bash, Read through ApprovalRouter' invokes the returned hook with synthetic PreToolUseHookInput for Edit, Bash, and Read; spies that requestApproval was called for each (3 calls) and the returned hookSpecificOutput.permissionDecision matches the stubbed ApprovalDecision.behavior."
  - criterion: "Mode 'acceptEdits' returns a HookCallback that auto-approves Edit/Write/MultiEdit tool names without calling ApprovalRouter, and routes every other tool through ApprovalRouter (matching 'default' for non-edit tools)."
    verification: "Unit test 'acceptEdits auto-approves Edit/Write/MultiEdit and defers others' invokes the returned hook for tool_name=Edit, Write, MultiEdit (expects allow + 0 ApprovalRouter calls) and for tool_name=Bash, Read (expects ApprovalRouter.requestApproval called, decision threaded through)."
  - criterion: PermissionMode is imported from shared/types/workflows.ts (no inline re-declaration) and the function rejects unknown modes via TypeScript exhaustiveness.
    verification: "grep -n \"from '.*shared/types/workflows'\" main/src/orchestrator/permissionModeMapper.ts shows the import; an exhaustive-switch never-check exists (e.g. `const _exhaustive: never = mode`)."
  - criterion: "All new unit tests in permissionModeMapper.test.ts pass under `pnpm --filter cyboflow-main test:unit run`."
    verification: "pnpm --filter cyboflow-main test:unit run -- permissionModeMapper exits with code 0 and reports >= 4 passing tests."
depends_on:
  - TASK-640
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Pure logic mapper with three distinct branches and an exhaustiveness guard. Unit-testable in isolation with a stub ApprovalRouter; no I/O, no DB, no SDK runtime required."
  targets:
    - behavior: "'dontAsk' mode returns undefined (no hook)."
      test_file: main/src/orchestrator/__tests__/permissionModeMapper.test.ts
      type: unit
    - behavior: "'default' mode routes Edit, Bash, Read through ApprovalRouter.requestApproval (3 calls, decisions threaded back through hookSpecificOutput)."
      test_file: main/src/orchestrator/__tests__/permissionModeMapper.test.ts
      type: unit
    - behavior: "'acceptEdits' mode auto-approves Edit/Write/MultiEdit (0 ApprovalRouter calls) and defers Bash/Read to ApprovalRouter."
      test_file: main/src/orchestrator/__tests__/permissionModeMapper.test.ts
      type: unit
    - behavior: "ApprovalRouter deny decision is translated to permissionDecision: 'deny' with permissionDecisionReason populated when ApprovalDecision.message is set."
      test_file: main/src/orchestrator/__tests__/permissionModeMapper.test.ts
      type: unit
    - behavior: "ApprovalRouter throwing an error yields permissionDecision: 'deny' with reason 'Internal approval-router error' (matching the existing makePreToolUseHook safety net)."
      test_file: main/src/orchestrator/__tests__/permissionModeMapper.test.ts
      type: unit
---
# permission_mode → PreToolUse hook mapper

## Objective

Produce a pure, standalone-typecheck-safe mapper that converts a workflow's `PermissionMode` ('default' | 'acceptEdits' | 'dontAsk') into a SDK `HookCallback | undefined` value. RunExecutor (TASK-640) consumes the mapper when assembling SDK options for a workflow run. The mapper centralizes the policy: 'default' always defers to ApprovalRouter; 'acceptEdits' auto-approves filesystem-mutating tools (Edit/Write/MultiEdit) and defers everything else; 'dontAsk' installs no hook at all, letting the SDK run unrestricted (equivalent to CLI `--dangerously-skip-permissions`).

## Implementation Steps

1. **Create the module shell.** Add `main/src/orchestrator/permissionModeMapper.ts`. Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3', or any concrete service in `main/src/services/*`. Allowed: `@anthropic-ai/claude-agent-sdk` types (`HookCallback`, `PreToolUseHookInput`), `shared/types/workflows` (`PermissionMode`), and `main/src/orchestrator/approvalRouter`.

2. **Define the mapper signature:**

   ```ts
   import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
   import type { PermissionMode } from '../../../shared/types/workflows';
   import { ApprovalRouter } from './approvalRouter';
   import type { LoggerLike } from './types';

   export const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const;

   export function buildPreToolUseHook(
     mode: PermissionMode,
     runId: string,
     logger?: LoggerLike,
   ): HookCallback | undefined { ... }
   ```

3. **Implement the three-branch switch with exhaustiveness check.**
   - `'dontAsk'` → `return undefined;`
   - `'default'` → return a `HookCallback` whose body calls `await ApprovalRouter.getInstance().requestApproval(runId, pretool.tool_name, pretool.tool_input as Record<string, unknown>, () => {})` and translates the returned `ApprovalDecision` to `hookSpecificOutput`. Wrap in try/catch returning `permissionDecision: 'deny'` with `permissionDecisionReason: 'Internal approval-router error'` on thrown exceptions (mirrors `claudeCodeManager.makePreToolUseHook:507-518`).
   - `'acceptEdits'` → first check `ACCEPT_EDITS_AUTO_APPROVE_TOOLS.includes(pretool.tool_name as ...)`. If true, return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }` directly without ApprovalRouter. Otherwise fall through to the 'default' deferral helper.
   - `default:` (TypeScript fallthrough) → `const _exhaustive: never = mode; throw new Error(...)`.

4. **Extract the shared deferral helper.** Factor the ApprovalRouter-routing code into an internal `async function deferToApprovalRouter(pretool, runId, logger?)` returning `Promise<HookJSONOutput>`. Do NOT export.

5. **Cast hookSpecificOutput literals carefully.** Use `as const` on `'allow'` / `'deny'` literals (mirrors `claudeCodeManager.ts:495,503`). `hookEventName: 'PreToolUse' as const`.

6. **Create the test file** at `main/src/orchestrator/__tests__/permissionModeMapper.test.ts`. Stub `ApprovalRouter.getInstance` via `vi.spyOn(ApprovalRouter, 'getInstance').mockReturnValue({ requestApproval: vi.fn().mockResolvedValue({ behavior: 'allow' }) } as unknown as ApprovalRouter)`. Construct synthetic `PreToolUseHookInput` literals via `as unknown as PreToolUseHookInput` cast.

7. **Write the five test cases** from frontmatter. Use `afterEach(() => { ApprovalRouter._resetForTesting(); vi.restoreAllMocks(); })`.

8. **Re-export from a barrel if `main/src/orchestrator/index.ts` exists.** Otherwise import directly by path from RunExecutor.

9. **Verify typecheck + tests.**
   ```bash
   pnpm --filter cyboflow-main typecheck
   pnpm --filter cyboflow-main test:unit run -- permissionModeMapper
   ```

## Acceptance Criteria

Per frontmatter. Each criterion is binary pass/fail; the verification column gives the exact command or assertion.

## Test Strategy

Five vitest cases. No DB, no PQueue, no real ApprovalRouter — integration with the real ApprovalRouter is already covered by approvalRouter.test.ts (TASK-302) and the day-3 gate (TASK-355).

## Hardest Decision

Where the auto-approve filter lives for 'acceptEdits'. Chose **exported `ACCEPT_EDITS_AUTO_APPROVE_TOOLS` as const** — gives tests a canonical list to assert against (drift-free) and gives future tasks (review-queue UI, observability) a single import point. Matches Claude CLI's fixed-list semantics; no per-workflow override in v1.

## Rejected Alternatives

- **Folding the mapper into claudeCodeManager.ts.** Out of scope — claudeCodeManager.ts is read-only here; RunExecutor (TASK-640) has its own SDK option construction.
- **Returning the full `hooks: {...}` Options field.** TASK-640 owns broader SDK options assembly; the mapper returning the callback only keeps the contract minimal.
- **Putting 'ask' or 'defer' in `permissionDecision`.** The hook callback's Promise stays unresolved until ApprovalRouter.requestApproval resolves — the SDK never sees a 'defer' decision. Matches `claudeCodeManager.makePreToolUseHook:481-519`.

## Lowest Confidence Area

Exact `BaseHookInput` shape for synthetic test inputs. Strategy: cast via `as unknown as PreToolUseHookInput` from a minimal literal (drift-resistant, matches the codebase pattern). If the SDK adds a required runtime-accessed field, tests would pass type-check but break at runtime — same risk profile as the existing approvalRouter.test.ts. Project-wide concern, not unique to this task.
