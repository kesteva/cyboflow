---
sprint: SPRINT-020
pending_count: 9
last_updated: "2026-05-19T15:41:14.705Z"
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

## FIND-SPRINT-020-7
- **source:** SPRINT-020 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/formatters.ts:38; frontend/src/utils/toolFormatter.ts:281,287,306,310-315,417-423,485-518
- **description:** Cross-task ripple: TASK-570 widened `ToolResultContent.content` from `string` to `string | Array<{type,text}>` via the canonical `ToolResultBlock` alias, and TASK-570 patched only `main/src/utils/formatters.ts:46` with a `typeof === string` guard. The two frontend consumers were not swept: `frontend/src/utils/formatters.ts:38` does ``Tool result: ${item.content}`` (array coerces to `[object Object],[object Object]`); `frontend/src/utils/toolFormatter.ts` does `JSON.parse(toolResult.content)` (throws on array at :287), `makePathsRelative(toolResult.content)` (breaks at :306), and many `toolResult.content.includes(error:)` calls (lines :310-315, :417-423). On the array branch `Array.prototype.includes` checks element-equality not substring — Bash error-tinting becomes dead code under the new wire shape. TypeScript does not catch this because the toolFormatter.ts files declare local shadow interfaces with `content: string` (see related FIND for shadow types).
- **suggested_action:** Either (a) introduce a shared `extractToolResultText(content: string | Array<{type:text; text:string}>): string` helper in `shared/utils/` (mirroring the guard pattern in `main/src/utils/formatters.ts:46-47`) and replace all 9+ unsafe callsites in the two frontend files; or (b) backport the same `typeof rawContent === string ? rawContent : JSON.stringify(rawContent)` guard inline at each site. Option (a) is the canonical fix because it scales to future stream-shape changes. Add unit-test coverage for the array-content branch in `frontend/src/utils/toolFormatter.test.ts` (file does not exist — create it).
- **resolved_by:** 




Suspected tasks: TASK-570

## FIND-SPRINT-020-8
- **source:** SPRINT-020 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/services/sessionManager.ts:453; main/src/database/database.ts:1523; main/src/database/database.ts:1960
- **description:** Cross-task residual: TASK-569 swept the 6 frontend/main-process callsites covered by its camelCase grep pattern but missed three snake_case / DB-layer fallbacks. (a) main/src/services/sessionManager.ts:453 — main-repo session auto-creation falls back to project.default_permission_mode || 'ignore'. Legacy projects with NULL default_permission_mode spawn main-repo sessions with permissionMode='ignore', defeating the approve-by-default intent. (b) main/src/database/database.ts:1523 — createProject(...) parameter default: defaultPermissionMode || 'ignore' is inserted as the column value when callers omit the arg, so any project created without an explicit override starts with 'ignore' and FIND-SPRINT-020-4's residual UI surfaces will silently re-pick the unsafe default. (c) main/src/database/database.ts:1960 — session-create insert: data.permission_mode || 'ignore'. Same pattern. CHECK constraints at database.ts:280/366/493/641 and migrations/legacy/add_permission_mode.sql:2,5 also still declare DEFAULT 'ignore' at the column level — the safety-by-default sweep is incomplete at the database layer.
- **suggested_action:** Either (1) extend TASK-569's sweep to snake_case + DB-layer callsites: replace 'ignore' with 'approve' at all three TS callsites; add a SQL migration that does UPDATE projects SET default_permission_mode = 'approve' WHERE default_permission_mode = 'ignore' (optionally guarded behind a CYBOFLOW_DEBUG escape hatch); and update the column DEFAULT clauses to DEFAULT 'approve' going forward. Or (2) extract a DEFAULT_PERMISSION_MODE = 'approve' shared constant in shared/types/permissionMode.ts (or similar) and reference it from all TS callsites — eliminates this class of grep-miss permanently. Add a regression test (similar to TASK-569's configManager.permissionMode.test.ts) that asserts createMainRepoSession() for a project with NULL default_permission_mode resolves to 'approve'.
- **resolved_by:** 



Suspected tasks: TASK-569

## FIND-SPRINT-020-9
- **source:** SPRINT-020 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/toolFormatter.ts:31-35; main/src/utils/toolFormatter.ts:12-16
- **description:** Cross-task type-shadow gap: TASK-570 introduced the canonical TextBlock / ToolUseBlock / ToolResultBlock types in shared/types/claudeStream.ts and replaced the per-process duplicates in main/src/types/session.ts:87-99 + frontend/src/types/session.ts:1-13 with deprecated re-exports (good). But the parallel toolFormatter.ts files were NOT swept: both files still declare local shadow interfaces `interface ToolResult { type: 'tool_result'; tool_use_id: string; content: string; }` that pre-date TASK-570. These shadow types are why FIND-SPRINT-020-7 is invisible to TypeScript — the `as ToolResult[]` cast at frontend/src/utils/toolFormatter.ts:485 erases the new array-content branch from the type system, so all downstream .includes / .split / JSON.parse calls compile cleanly despite being runtime-unsafe. Same pattern in main/src/utils/toolFormatter.ts:12-16 (no current callsite hits the array branch, but the shadow is a latent landmine). Net: there are now 4 versions of ToolResultContent-like types in the tree (canonical ToolResultBlock + 2 deprecated re-exports + 2 local shadows in toolFormatter.ts files).
- **suggested_action:** Delete the local `interface ToolResult { content: string }` declarations in both toolFormatter.ts files. Import `ToolResultBlock` from shared/types/claudeStream.ts directly and let TypeScript surface the unsafe .includes/.split/JSON.parse calls — which is the natural way FIND-SPRINT-020-7 should have been caught. As a follow-up, delete the @deprecated re-exports in {frontend,main}/src/types/session.ts:1-13 entirely once consumers are migrated; the deprecated aliases are a temporary bridge, not a long-term API.
- **resolved_by:** 


Suspected tasks: TASK-570

## FIND-SPRINT-020-10
- **source:** SPRINT-020 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/CODE-PATTERNS.md; docs/ARCHITECTURE.md
- **description:** CLAUDE.md gap from TASK-570: the canonical shared/types/claudeStream.ts module is now the single source of truth for Claude stream block shapes (TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, plus the ClaudeStreamEvent union and Zod schema bridge). Both frontend/src/types/session.ts and main/src/types/session.ts now contain `@deprecated import { TextBlock } from 'shared/types/claudeStream' directly` comments steering future authors toward the canonical types. But docs/CODE-PATTERNS.md has zero references to shared/types/claudeStream and docs/ARCHITECTURE.md mentions only the IPC/approvals surfaces, not stream-event types. Future authors (and other agents) will not learn the canonical import path from the docs, will likely re-create local shadow interfaces (the same anti-pattern FIND-SPRINT-020-9 identifies), and the deprecation aliases will accrue indefinitely.

Suspected tasks: TASK-570
- **suggested_action:** Add a short section to docs/CODE-PATTERNS.md (or docs/ARCHITECTURE.md under the streaming/IPC discussion) documenting: (a) shared/types/claudeStream.ts is the single source of truth for Claude stream block shapes; (b) consumers MUST import canonical types directly, not re-create local interfaces; (c) the @deprecated TextContent/ToolUseContent/ToolResultContent aliases in {frontend,main}/src/types/session.ts are a temporary bridge slated for removal; (d) any new tool_result consumer must handle the array branch of ToolResultBlock.content (string | Array<{type:'text';text:string}>) — link to the canonical extractor helper recommended in FIND-SPRINT-020-7's suggested action.
- **resolved_by:** 
