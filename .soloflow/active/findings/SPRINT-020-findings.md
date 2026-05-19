---
sprint: SPRINT-020
pending_count: 2
last_updated: "2026-05-19T07:55:00.000Z"
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
