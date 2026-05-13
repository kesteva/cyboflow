---
id: TASK-204
idea: IDEA-005
idea_id: IDEA-005
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/configManager.ts
  - main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
files_readonly:
  - main/src/services/permissionIpcServer.ts
  - main/src/services/permissionManager.ts
  - main/src/types/config.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "When buildCommandArgs() is called for a Cyboflow run (effectiveMode === 'approve' AND permissionIpcPath is set), the resulting argv does NOT contain '--dangerously-skip-permissions'."
    verification: "pnpm --filter main test -- claudeCodeManagerPermissions.test.ts passes; test instantiates ClaudeCodeManager with permissionIpcPath set, calls buildCommandArgs with permissionMode='approve', asserts result.includes('--dangerously-skip-permissions') === false and result.includes('--permission-prompt-tool') === true."
  - criterion: "When permissionIpcPath is null/undefined (Cyboflow misconfiguration), buildCommandArgs() throws a clear error rather than silently falling back to --dangerously-skip-permissions. The error message names the missing permissionIpcPath."
    verification: "pnpm --filter main test -- claudeCodeManagerPermissions.test.ts passes; test instantiates ClaudeCodeManager with permissionIpcPath=null, calls buildCommandArgs with permissionMode='approve', asserts the call throws with an error message matching /permissionIpcPath/."
  - criterion: "The defaultPermissionMode in configManager.ts is changed from 'ignore' to 'approve' so any code path that falls through to the config default goes through the permission socket."
    verification: "grep -n \"defaultPermissionMode: 'approve'\" main/src/services/configManager.ts returns 1 match; grep -n \"defaultPermissionMode: 'ignore'\" main/src/services/configManager.ts returns 0 matches."
  - criterion: "All four code paths in claudeCodeManager.ts that emitted '--dangerously-skip-permissions' for non-approve modes are updated. The flag is now only emitted when the operator has explicitly opted out of approve mode via an explicit permissionMode='ignore' AND a feature flag (or fully removed in the Cyboflow fork)."
    verification: "grep -rn \"--dangerously-skip-permissions\" main/src/services/panels/claude/claudeCodeManager.ts returns at most 1 match, and that match is inside an if-branch guarded by an explicit Cyboflow opt-out check (commented as such)."
  - criterion: "Existing 'ignore' mode code paths in claudeCodeManager.ts that previously appended --dangerously-skip-permissions now emit a warning log and throw a clear error: Cyboflow runs MUST use approve mode."
    verification: "pnpm --filter main test -- claudeCodeManagerPermissions.test.ts passes; test calls buildCommandArgs with permissionMode='ignore', asserts the call throws with an error message matching /approve mode is mandatory|Cyboflow runs/i."
depends_on: []
estimated_complexity: low
epic: stream-parser-to-main
test_strategy:
  needed: true
  justification: "This task changes a security-relevant default (whether the queue can be bypassed). The four buildCommandArgs() paths that emit --dangerously-skip-permissions must be covered by tests to guarantee no regression silently re-enables bypass. Without tests, a future refactor could re-introduce the fallback unnoticed."
  targets:
    - behavior: "approve mode + permissionIpcPath set → argv has --permission-prompt-tool, no --dangerously-skip-permissions."
      test_file: main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
      type: unit
    - behavior: approve mode + permissionIpcPath null → throws a named error.
      test_file: main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
      type: unit
    - behavior: "ignore mode (any caller) → throws with 'Cyboflow runs require approve mode'."
      test_file: main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
      type: unit
    - behavior: config default applied (no explicit permissionMode arg) → behaves as approve mode.
      test_file: main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
      type: unit
---
# Force approve permission mode for Cyboflow runs

## Objective

Flip Crystal's `--dangerously-skip-permissions` default so every Cyboflow run goes through the permission socket. The current code (`claudeCodeManager.ts` lines 88–105) defaults to `--dangerously-skip-permissions` whenever `effectiveMode !== 'approve'` OR when `permissionIpcPath` is null. For Cyboflow's queue-centric architecture, the permission socket is the only entry point to the review queue — bypassing it makes the queue unusable. Mandate `approve` mode and treat any attempt to use `ignore` mode as a programmer error.

## Implementation Steps

1. Open `main/src/services/configManager.ts`. Change line 24 from `defaultPermissionMode: 'ignore'` to `defaultPermissionMode: 'approve'`. This makes the config-level default safe by construction.

2. Open `main/src/services/panels/claude/claudeCodeManager.ts`. Locate the four occurrences of the permission-mode branch (lines 88–105, 144–149, 258–264, 402–407 per the current code; verify exact line numbers at execution time). In `buildCommandArgs()` (the primary one, lines 88–105):
   - Compute `effectiveMode = permissionMode || this.configManager?.getConfig()?.defaultPermissionMode || 'approve'` (note: default is now 'approve', not 'ignore').
   - Replace the `if (effectiveMode === 'ignore') { args.push('--dangerously-skip-permissions'); }` branch with: `if (effectiveMode === 'ignore') { throw new Error('[ClaudeCodeManager] Cyboflow runs require approve mode; --dangerously-skip-permissions is not allowed.'); }`.
   - Replace the fallback `args.push('--dangerously-skip-permissions')` (when `effectiveMode === 'approve'` but `permissionIpcPath` is null) with `throw new Error('[ClaudeCodeManager] approve mode requested but permissionIpcPath is not configured; cannot spawn Claude.');`. Remove the warn-then-fallback path entirely.

3. Apply the same throw-on-ignore-mode replacement to the other three permission-mode branches in `claudeCodeManager.ts` (the ones at ~144, ~258, ~402). The grep at the end (`grep -rn "--dangerously-skip-permissions" main/src/services/panels/claude/claudeCodeManager.ts`) should return at most one match — and that single remaining match must be inside a clearly-marked Cyboflow opt-out block (comment: `// @cyboflow-bypass — only reachable via explicit operator opt-out; default is approve`). If no opt-out is desired in v1, remove all four occurrences entirely.

4. The `--permission-prompt-tool` flag at line 147 currently uses `mcp__crystal-permissions__approve_permission`. The crystal-cuts-and-rebrand epic will rename this to `cyboflow-permissions`; do NOT change the literal name in this task — it is owned by the rebrand epic. Leave it as-is; the rebrand will sweep it.

5. Write `main/src/services/__tests__/claudeCodeManagerPermissions.test.ts`. Use vitest. Mock the `ConfigManager` and `SessionManager` minimally. Tests:
   - `buildCommandArgs` with `permissionMode='approve'`, `permissionIpcPath='/tmp/socket'`, and a valid `mcpConfigPath` returns an argv containing `--permission-prompt-tool` and NOT containing `--dangerously-skip-permissions`.
   - `buildCommandArgs` with `permissionMode='approve'` and `permissionIpcPath=null` throws an error whose message contains `permissionIpcPath`.
   - `buildCommandArgs` with `permissionMode='ignore'` throws an error whose message matches `/Cyboflow runs require approve mode/i`.
   - `buildCommandArgs` with no explicit `permissionMode` and `permissionIpcPath='/tmp/socket'` (relying on the config default) behaves as approve mode (argv contains `--permission-prompt-tool`).

6. Run `grep -rn "--dangerously-skip-permissions" main/src/services/panels/claude/claudeCodeManager.ts` as the final completeness gate. The grep is encoded as step 1 of this list to satisfy the sweep-grep rule (5d).

## Acceptance Criteria

- `defaultPermissionMode` in `configManager.ts` is `'approve'` (not `'ignore'`).
- `buildCommandArgs()` never returns an argv containing `--dangerously-skip-permissions` for the Cyboflow happy path (`approve` + `permissionIpcPath`).
- `ignore` mode is now a hard error, not a silent fallback.
- `approve` mode without `permissionIpcPath` is now a hard error, not a silent fallback (no more `args.push('--dangerously-skip-permissions')` as a "fallback").
- Tests in `claudeCodeManagerPermissions.test.ts` cover all four buildCommandArgs paths and pass under `pnpm --filter main test`.

## Test Strategy

See frontmatter. The four behavioral cases (approve+socket, approve+nosocket, ignore, default-applies) directly map to the four code paths the previous Crystal logic took. Coverage here is mandatory because this is a security-relevant default flip — a regression that silently re-enables `--dangerously-skip-permissions` would invisibly break the entire review queue.

## Hardest Decision

Whether to throw on `ignore` mode or silently coerce it to `approve`. Chose: throw. Silent coercion hides a programmer error from the caller — if some downstream code path passes `ignore` (e.g., a Crystal-legacy callsite that wasn't updated), the operator should know immediately rather than discovering it via "why is the queue empty?" minutes later. The blast radius is one error log + one fix; the alternative blast radius is a silently bypassed queue.

## Rejected Alternatives

- **Keep a feature flag for `ignore` mode (escape hatch).** Rejected for v1 — the entire product thesis is "the queue is the only path." Adding an escape hatch on day one normalizes its use. If a future operator needs it (e.g., debugging), they can re-introduce the branch under an explicit `CYBOFLOW_ALLOW_BYPASS=1` env check in a follow-up task.
- **Coerce `ignore` to `approve` silently with a warn log.** Rejected — see "Hardest Decision". Hidden coercion is worse than a loud error for a security-relevant setting.
- **Only change the `configManager.ts` default and leave the four `--dangerously-skip-permissions` branches as fallbacks.** Rejected — the four branches were the real bypass surface, not the config default. The default flip alone would still allow any caller passing `permissionMode='ignore'` explicitly to bypass.

## Lowest Confidence Area

Whether all four occurrences of `--dangerously-skip-permissions` in `claudeCodeManager.ts` are still at the line numbers cited above. The codebase may shift before this task executes (concurrent edits from the crystal-cuts epic). The implementation step instructs the executor to grep at task start to locate them; the final grep as a completeness gate guarantees zero remain post-edit. Risk is low because the grep is the source of truth, not the line numbers.
