---
sprint: SPRINT-020
pending_count: 5
last_updated: "2026-05-19T15:30:00.000Z"
---
# Findings Queue

SPRINT-020 started with missing infra: docker; tests deferred.

## FIND-SPRINT-020-1
- **type:** scope_deviation
- **source:** TASK-570 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/utils/formatters.ts:46
- **description:** required to meet AC: formatters.ts used ToolResultContent.content as plain string, which now errors after alias to ToolResultBlock widens content to string | Array<{type;text}>. Added type guard to handle both shapes.
- **resolved_by:** verifier — plan-prescribed: files_owned line 12 lists main/src/utils/formatters.ts; plan step 4 explicitly prescribes the typeof guard pattern (with a precedent reference) for callsites that read .content as a string. Not a deviation — owned and prescribed.

## FIND-SPRINT-020-2
- **type:** question
- **source:** TASK-571 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:359
- **description:** AC criterion 1 specifies the exact form `const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent;` with a passing typecheck. This exact form cannot compile when the schemas use `.passthrough()` (which adds `[k: string]: unknown` to all inferred object types) because the concrete TS interfaces in shared/types/claudeStream.ts (files_readonly) do not declare index signatures. The readonly test files schemas.test.ts and typedEventNarrowing.test.ts explicitly assert .passthrough() runtime behavior. Implementation uses `DeepKnownFields<z.infer<typeof claudeStreamEventSchema>>` instead — this achieves the same semantic bidirectional drift check but does not match the AC grep pattern. The AC should be updated to reflect `DeepKnownFields<z.infer<...>>` form, OR the schemas should be allowed to drop .passthrough() and the readonly tests updated accordingly.
- **suggested_action:** Update AC criterion 1 to allow DeepKnownFields<z.infer<typeof claudeStreamEventSchema>> form, OR update tests to not require .passthrough() behavior, OR add [k: string]: unknown to all claudeStream.ts interfaces.

## FIND-SPRINT-020-3
- **source:** TASK-571 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:370
- **description:** Empirically tested in the worktree: the DeepKnownFields-wrapped `_reverseCheck` does NOT catch the exact drift scenario the plan's Problem statement describes — "a new optional field on ResultEvent that is missing from the Zod schema still passes the bridge". Reproduction: add `bogus_optional_drift?: string` to a TS interface in shared/types/claudeStream.ts and run `pnpm --filter main exec tsc --noEmit` — zero typecheck errors. Only REQUIRED-field drift is caught (and that direction is already caught by _typeCheck alone, so _reverseCheck adds no net detection power for required fields either). The plan's stated goal — bidirectional drift on optional fields — is unmet by the current implementation. The bridge comment should at minimum acknowledge this asymmetry, or the team should adopt the plan's Hardest-Decision option (B) (`export type ClaudeStreamEvent = z.infer<typeof claudeStreamEventSchema>`) to actually close the drift surface.
- **suggested_action:** Either (1) annotate the bridge comment to admit the optional-field gap, (2) refactor to `export type ClaudeStreamEvent = z.infer<typeof claudeStreamEventSchema>` (plan's option B), or (3) drop .passthrough() from non-leaf schemas (and update readonly schemas.test.ts in a follow-up task), allowing the verbatim AC1 form to compile and detect optional drift in both directions.
- **resolved_by:**

## FIND-SPRINT-020-4
- **source:** TASK-569 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/panels/cli/BaseCliPanel.tsx:432; frontend/src/components/Settings.tsx:286-305
- **description:** TASK-569 narrowly removed the user-facing `'ignore'` selector from CreateSession's `ClaudeCodeConfig.tsx` (per plan step 4), but two other user-facing surfaces still expose `'ignore'` as a selectable option to the user. (a) `BaseCliPanel.tsx:432` — the Claude panel's runtime settings dropdown still has `<option value="ignore">Skip permissions</option>` and writes it via `onSettingsChange` into panel settings (with `showPermissionControls: true` for the Claude config in `shared/types/cliPanels.ts:459`). (b) `Settings.tsx:286-305` — the global "Default Security Mode" radio group still offers a `value="ignore"` ("Fast & Flexible") option that writes to `defaultPermissionMode` in `~/.cyboflow/config.json`, which then re-seeds every callsite (`BaseCliPanel.tsx:425` `settings.defaultPermissionMode || 'approve'` short-circuits to `'ignore'` whenever the user has saved this). The result: TASK-569's stated goal ("user-facing defaults are 'approve'") is achieved on fresh installs, but a user that touches either of these two UIs reintroduces the same crash surface TASK-204 sealed. The plan's "Hide the 'Skip' card" intent appears applied only to the CreateSession dialog, not to these two equally-exposed surfaces.
- **suggested_action:** Either (1) delete the `<option value="ignore">` from `BaseCliPanel.tsx:432` and the `value="ignore"` radio from `Settings.tsx:286-305` (mirroring the ClaudeCodeConfig.tsx Skip-card deletion), or (2) gate both behind a `CYBOFLOW_DEBUG=1` env flag as the plan's rejected alternative suggested, with a follow-up task to add the env-conditional render. If `'ignore'` is intentionally preserved as a power-user setting, the plan and `docs/CODE-PATTERNS.md` should document this contract so future sweeps don't re-flag it.

## FIND-SPRINT-020-5
- **source:** TASK-569 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/approval-router-and-permission-fix/TASK-569-plan.md; main/src/services/panels/claude/claudeCodeManager.ts:387-395
- **description:** TASK-569's plan opens with "TASK-204 (SPRINT-005) replaced the `--dangerously-skip-permissions` bypass in `claudeCodeManager.buildCommandArgs()` with a hard throw whenever `effectiveMode === 'ignore'`. That seals the bypass — but every UI callsite that creates a session still defaults `permissionMode: 'ignore'`, so the standard session-creation flow now hits the throw and fails at spawn." Reviewing the actual `claudeCodeManager.ts` in the worktree, there is no longer a throw on `'ignore'` (no `Cyboflow runs require approve mode` Error anywhere in `main/src`). Instead, lines 387-395 silently omit the PreToolUse hook when `permissionMode === 'ignore'` — the SDK auto-allows every tool call ("matching the pre-SDK 'skip the bridge' behavior"). The plan's referenced `claudeCodeManagerPermissions.test.ts` file (criterion 5) also does not exist in the worktree. The default-flip is still a reasonable safety-by-default change, but the urgency framing ("standard session creation flow fails at spawn") is stale — the actual current behavior is silent bypass, not crash. Worth flagging because future readers (and the compounder) will trust the plan's narrative.
- **suggested_action:** Update the TASK-569 plan's Problem section (or close the parent epic) to reflect the current `claudeCodeManager.ts` behavior. Decide whether `permissionMode === 'ignore'` should: (a) genuinely be sealed (re-introduce the throw), (b) stay as the silent-bypass debug escape hatch (then document the contract), or (c) be removed entirely from the type unions. The current half-state (manager silently bypasses, UI defaults to `'approve'`, but two other UI surfaces still let users pick `'ignore'`) is the worst of all worlds.
- **resolved_by:**

## FIND-SPRINT-020-6
- **source:** TASK-597 (code-reviewer)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** main/src/database/migrations/006_cyboflow_schema.sql (approvals.decided_by column comment)
- **description:** The approvals table schema comment enumerates `decided_by TEXT, -- 'user' | 'auto-policy' | 'timeout'`, but ApprovalRouter.clearPendingForRun() introduced in TASK-597 now writes a new value `'system'` (decided_by='system') to mark system-initiated termination cleanups. The column has no CHECK constraint, so this is a documentation-drift issue rather than a runtime bug — but the comment now under-enumerates the production-written values, which will mislead future maintainers and reviewers. The same comment list is also missing `'auto-policy'` for the canceled-allow path at approvalRouter.ts:291 (the comment did list 'auto-policy', so that one is fine — only 'system' is the new addition).
- **suggested_action:** Update the schema comment in `006_cyboflow_schema.sql` to `decided_by TEXT, -- 'user' | 'auto-policy' | 'system' | 'timeout'`. Optionally, add a CHECK constraint enumerating the valid values in a follow-up migration to make this enforceable rather than documented.
- **resolved_by:**
