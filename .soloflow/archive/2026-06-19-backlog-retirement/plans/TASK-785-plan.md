---
id: TASK-785
idea: braindump
status: done
created: 2026-05-27T00:00:00Z
source: braindump
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/permissionModeMapper.ts
acceptance_criteria:
  - criterion: "Claude sessions spawned by Cyboflow load user-level settings from ~/.claude/settings.json — settingSources includes 'user' alongside 'project'"
    verification: "grep -n 'settingSources' main/src/services/panels/claude/claudeCodeManager.ts shows an array containing both 'user' and 'project'"
  - criterion: "User-configured permission grants (e.g. Bash allow-lists in ~/.claude/settings.json) are honored during sessions instead of being stripped"
    verification: "manual — launch a session with user-level grants configured and confirm Claude does not re-prompt for allowed tools"
  - criterion: "pnpm typecheck exits 0"
    verification: "pnpm typecheck"
  - criterion: "pnpm test:unit exits 0"
    verification: "pnpm test:unit"
depends_on: []
estimated_complexity: low
---

# Stop stripping user-level Claude permission grants in Cyboflow sessions

## Objective

Cyboflow currently sets `settingSources: ['project']` in `claudeCodeManager.ts:426` when building SDK options for spawned Claude sessions. This intentionally blocks loading `~/.claude/settings.json`, which contains user-level permission grants (e.g. Bash allow-lists, tool auto-approvals). As a result, Claude prompts for every action even when the user has already approved it in their personal Claude configuration.

The original rationale was that user grants would auto-approve tools without firing the PreToolUse hook, bypassing ApprovalRouter. The fix should restore user-level settings loading while preserving ApprovalRouter integration for workflow runs.

## Implementation Steps

1. In `claudeCodeManager.ts` `buildSdkOptions()`, change `settingSources: ['project']` to include `'user'`
2. Verify that the PreToolUse hook (ApprovalRouter integration) still takes precedence for workflow runs where `permissionMode !== 'ignore'`
3. Test that user-level grants are respected in non-workflow sessions

## Acceptance Criteria

- [ ] Claude sessions load user-level settings from ~/.claude/settings.json
- [ ] User-configured permission grants are honored instead of being stripped
- [ ] pnpm typecheck exits 0
- [ ] pnpm test:unit exits 0
