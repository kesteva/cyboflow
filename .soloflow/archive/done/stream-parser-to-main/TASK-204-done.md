---
id: TASK-204
sprint: SPRINT-005
epic: stream-parser-to-main
status: done
summary: "Force approve permission mode for Cyboflow runs — ban --dangerously-skip-permissions emission"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-204 — Done Report

## Summary

Security-relevant default flip. The Cyboflow review queue is the single entry point for tool-call approvals — bypassing it via `--dangerously-skip-permissions` makes the queue unusable. This task seals every bypass path in the Claude spawn pipeline:

1. `configManager.ts` — `defaultPermissionMode` flipped from `'ignore'` to `'approve'`.
2. `claudeCodeManager.ts` — all four `|| 'ignore'` fallback patterns flipped to `|| 'approve'`. The `if (effectiveMode === 'ignore')` branch in `buildCommandArgs()` now throws `[ClaudeCodeManager] Cyboflow runs require approve mode; --dangerously-skip-permissions is not allowed.` instead of pushing the bypass flag. The approve+nosocket fallback now throws `[ClaudeCodeManager] approve mode requested but permissionIpcPath is not configured; cannot spawn Claude.` instead of silently bypassing.

After the change, `grep -rn "--dangerously-skip-permissions"` against `claudeCodeManager.ts` returns exactly one match — and that match is inside the throw error-message string (no `args.push` survives).

Loud-throw over silent coercion is the deliberate design choice: any stale Crystal-era callsite still passing `permissionMode: 'ignore'` will surface immediately rather than invisibly disabling the queue.

## Changes

- `main/src/services/configManager.ts` — `defaultPermissionMode: 'approve'`
- `main/src/services/panels/claude/claudeCodeManager.ts` — four branches updated; throws replace bypass-emissions
- `main/src/services/__tests__/claudeCodeManagerPermissions.test.ts` (new — 4 unit tests)

## Commits

- `bd474ad` — `fix(TASK-204): flip defaultPermissionMode from ignore to approve`
- `f806b5a` — `fix(TASK-204): ban --dangerously-skip-permissions; throw on ignore mode and missing socket`
- `d432dbc` — `test(TASK-204): add permission-mode unit tests for ClaudeCodeManager`

## Verification

- Tests: 4/4 claudeCodeManagerPermissions cases pass (approve+socket happy path; approve+nosocket throws naming permissionIpcPath; ignore mode throws "Cyboflow runs require approve mode"; default-applies flows through to approve).
- Typecheck: PASS.
- Lint: 0 errors (228 pre-existing warnings, none in changed files).
- Per-task visual: skipped (parallel mode).

## Notes

- FIND-SPRINT-005-6 (severity: high) queued by the verifier: downstream UI callsites still pass `permissionMode: 'ignore'` explicitly and will hit the new throw. This is the *intended* surface for the loud-throw design — it forces stale Crystal-era callsites to be located and fixed in a follow-up sweep. Not a TASK-204 defect, but high-priority follow-up work for the next sprint.
- `mcp__crystal-permissions__approve_permission` literal name NOT changed — owned by the crystal-cuts-and-rebrand epic.
