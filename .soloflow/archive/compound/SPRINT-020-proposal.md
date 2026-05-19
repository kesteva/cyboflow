---
sprints: [SPRINT-020]
span_label: SPRINT-020
created: 2026-05-19T16:00:00.000Z
counters_start:
  ideas: 18
summary:
  cleanups: 1
  backlog_tasks: 3
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-020

## A. Clean-up items (execute now)

### A1. Update `approvals.decided_by` schema comment to include `'system'`
- **Summary:** The `decided_by` column comment in `006_cyboflow_schema.sql` omits `'system'`, which `clearPendingForRun` (TASK-597) now writes for system-initiated termination cleanups.
- **Source-Sprint:** SPRINT-020
- **Rationale:** The column has no CHECK constraint, so this is documentation-only drift — but the comment is the sole enumeration future maintainers will rely on when querying or extending the approvals table. `'system'` is now a production-written value and the comment under-enumerates it.
- **Blast radius:** `main/src/database/migrations/006_cyboflow_schema.sql` — one-line comment edit only. Risk: trivial.
- **Source:** FIND-SPRINT-020-6 (TASK-597 code-reviewer)
- **Proposed change:**
  ```diff
  --- a/main/src/database/migrations/006_cyboflow_schema.sql
  +++ b/main/src/database/migrations/006_cyboflow_schema.sql
  -    decided_by TEXT, -- 'user' | 'auto-policy' | 'timeout'
  +    decided_by TEXT, -- 'user' | 'auto-policy' | 'system' | 'timeout'
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `decided_by = 'system'` is written by `approvalRouter.ts:361` and asserted in tests (`approvalRouter.test.ts:558`, `:711`), while the schema comment at `006_cyboflow_schema.sql:66` omits it — one-line comment edit, zero blast radius.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Complete the `permissionMode='ignore'` sweep — UI surfaces, DB layer, and contract documentation
- **Summary:** TASK-569 flipped 15 camelCase callsites to `'approve'` but missed two user-facing UI surfaces that still let users select `'ignore'` and three snake_case / DB-layer fallbacks that re-seed `'ignore'` for legacy projects and new projects created via the DB API.
- **Source-Sprint:** SPRINT-020
- **Source:** FIND-SPRINT-020-4 (TASK-569 code-reviewer), FIND-SPRINT-020-5 (TASK-569 code-reviewer), FIND-SPRINT-020-8 (sprint-code-reviewer)
- **Problem:** Three distinct residual surfaces undermine TASK-569's approve-by-default intent:
  1. **UI surfaces** (`FIND-4`): `frontend/src/components/panels/cli/BaseCliPanel.tsx:432` still renders `<option value="ignore">Skip permissions</option>` in the Claude panel's runtime settings dropdown; `frontend/src/components/Settings.tsx:286-305` still has a `value="ignore"` radio in the global "Default Security Mode" group. A user who touches either surface reintroduces `permissionMode='ignore'` across all subsequent sessions.
  2. **DB-layer fallbacks** (`FIND-8`): `main/src/services/sessionManager.ts:453` falls back to `'ignore'` for main-repo auto-created sessions when `project.default_permission_mode` is NULL (the TASK-569 grep pattern was camelCase-only and missed this snake_case site). `main/src/database/database.ts:1523` inserts `'ignore'` when `createProject()` callers omit the `defaultPermissionMode` arg. `main/src/database/database.ts:1960` session-create insert: `data.permission_mode || 'ignore'`. Legacy column DEFAULT clauses in `add_permission_mode.sql` also still declare `DEFAULT 'ignore'`.
  3. **Contract ambiguity** (`FIND-5`): The current state (`'ignore'` is a valid type-union member, the manager silently bypasses hooks when it is set, but UI defaults to `'approve'`, yet two UI surfaces still expose `'ignore'`) is undocumented and self-contradictory. Future sweeps will re-flag these sites without knowing whether `'ignore'` is intentionally preserved as a power-user escape hatch.
- **Proposed direction:** The task should make a single decision and implement it consistently: (a) **Remove `'ignore'` from user-facing UI** — delete `<option value="ignore">` from `BaseCliPanel.tsx:432` and the `value="ignore"` radio from `Settings.tsx:286-305`, mirroring the `ClaudeCodeConfig.tsx` Skip-card deletion from TASK-569. (b) **Fix DB-layer fallbacks** — replace `|| 'ignore'` with `|| 'approve'` at `sessionManager.ts:453`, `database.ts:1523`, and `database.ts:1960`; add a SQL migration that sets `DEFAULT 'approve'` on the relevant columns and optionally backfills `NULL` rows. Consider extracting a `DEFAULT_PERMISSION_MODE = 'approve'` constant in `shared/types/permissionMode.ts` to make future grep-misses structurally impossible. (c) **Document the contract** — if `'ignore'` is intentionally kept in the type union as a debug escape hatch (e.g., for `CYBOFLOW_DEBUG=1` builds), document that contract explicitly in `docs/CODE-PATTERNS.md` or the epic plan so future reviewers know not to re-flag it. Add a regression test asserting that `createMainRepoSession()` for a project with `NULL default_permission_mode` resolves to `'approve'`.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** All five cited sites verified live in current code — `BaseCliPanel.tsx:432` and `Settings.tsx:291` still expose `value="ignore"`, and `sessionManager.ts:453`, `database.ts:1523`, `database.ts:1960` all default to `'ignore'`, directly contradicting TASK-569's approve-by-default intent and creating concrete user-facing regression risk.

### B2. Fix frontend `ToolResultContent` unsafe callsites and delete shadow `interface ToolResult` declarations
- **Summary:** After TASK-570 widened `ToolResultContent.content` to `string | Array<{type,text}>`, two frontend files have 9+ unsafe string-only callsites that are invisible to TypeScript because both `toolFormatter.ts` files declare local shadow interfaces that pin `content: string` — causing silent runtime failures (array-to-string coercion, `JSON.parse` throws, dead error-tinting) when array-form content arrives.
- **Source-Sprint:** SPRINT-020
- **Source:** FIND-SPRINT-020-7 (sprint-code-reviewer), FIND-SPRINT-020-9 (sprint-code-reviewer)
- **Problem:** The root cause (`FIND-9`) is that `frontend/src/utils/toolFormatter.ts:31-35` and `main/src/utils/toolFormatter.ts:12-16` each declare a local `interface ToolResult { type: 'tool_result'; tool_use_id: string; content: string; }` shadow type. The `as ToolResult[]` cast at `frontend/src/utils/toolFormatter.ts:485` erases the new array-content branch from the type system, so TypeScript reports no errors at the downstream callsites. The downstream symptoms (`FIND-7`):
  - `frontend/src/utils/formatters.ts:38`: `` `Tool result: ${item.content}` `` — array coerces to `[object Object],[object Object]`.
  - `frontend/src/utils/toolFormatter.ts:287`: `JSON.parse(toolResult.content)` — throws on array input.
  - `:306`: `makePathsRelative(toolResult.content)` — breaks on array.
  - `:310-315, :417-423, :485-518`: `toolResult.content.includes('error:')` calls — `Array.prototype.includes` checks element-equality, not substring match; Bash error-tinting becomes dead code when content is array-form.
- **Proposed direction:** (1) Delete the local `interface ToolResult { content: string }` declarations in both `toolFormatter.ts` files and import `ToolResultBlock` from `shared/types/claudeStream.ts` directly. TypeScript will then surface all unsafe callsites as type errors, producing a mechanical fix list. (2) Introduce a shared `extractToolResultText(content: ToolResultBlock['content']): string` helper — either in `shared/utils/` or at minimum as a module-level function in each `toolFormatter.ts` — that returns `typeof content === 'string' ? content : content.map(b => b.text).join('')` (or `JSON.stringify(content)` as a fallback). (3) Replace all 9+ unsafe callsites in `frontend/src/utils/formatters.ts:38` and `frontend/src/utils/toolFormatter.ts` with the helper. (4) Create `frontend/src/utils/toolFormatter.test.ts` (currently does not exist) and add unit-test coverage for the array-content branch, mirroring the pattern in `main/src/utils/formatters.test.ts`. (5) As a follow-up gate, delete the `@deprecated` re-exports in `{frontend,main}/src/types/session.ts` once all consumers have migrated to direct `shared/types/claudeStream.ts` imports.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Shadow `interface ToolResult` confirmed at `frontend/src/utils/toolFormatter.ts:31` and `main/src/utils/toolFormatter.ts:12`; unsafe `JSON.parse(toolResult.content)`, `.includes('error:')`, and `${item.content}` template uses verified at `formatters.ts:38` and `toolFormatter.ts:287/310-315/417-423` — concrete runtime breakage when array-form content arrives, type system blind due to shadow types.

### B3. Resolve the `_reverseCheck` bidirectional drift-detection gap in the Zod schema bridge (TASK-571 HUMAN_NEEDED)
- **Summary:** The `DeepKnownFields<z.infer<typeof claudeStreamEventSchema>>` workaround used in TASK-571 does not catch optional-field drift between TypeScript interfaces and the Zod schema — the primary scenario the plan was written to solve — requiring a design decision before the task can be closed.
- **Source-Sprint:** SPRINT-020
- **Source:** FIND-SPRINT-020-2 (TASK-571 executor), FIND-SPRINT-020-3 (TASK-571 verifier), TASK-571 HUMAN_NEEDED in human-review-queue
- **Problem:** The plan's AC criterion 1 specified a `const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent` compile-time bridge. This form is unimplementable with `.passthrough()` schemas because `.passthrough()` adds `[k: string]: unknown` to all inferred object types, and the concrete TS interfaces in `shared/types/claudeStream.ts` (files_readonly) lack index signatures — producing TS2322. The executor's workaround using `DeepKnownFields<z.infer<typeof claudeStreamEventSchema>>` compiles, but empirically does NOT catch optional-field drift: adding `bogus_optional_drift?: string` to a TS interface produces zero typecheck errors. The result is that `_reverseCheck` as implemented adds no meaningful net drift-detection capability versus `_typeCheck` alone for the optional-field case (`FIND-3`). Three paths forward exist (each has real trade-offs):
  - **Option 1 (accept gap):** Accept the current implementation, update the plan AC to allow the `DeepKnownFields<z.infer<...>>` form, and add a code comment to the bridge explicitly acknowledging the optional-field gap.
  - **Option 2 (eliminate drift surface):** Adopt plan option B — `export type ClaudeStreamEvent = z.infer<typeof claudeStreamEventSchema>` — which eliminates the drift surface entirely by making the TS types derived from the schema. Requires touching 50+ consumer sites that currently import the hand-authored interfaces.
  - **Option 3 (drop `.passthrough()`):** Remove `.passthrough()` from non-leaf schemas (requires updating the read-only `schemas.test.ts` assertion of passthrough preservation), which allows the verbatim AC1 form to compile and catch optional drift in both directions.
- **Proposed direction:** The task-refiner should present all three options to the user with concrete file counts before planning any implementation. Option 1 is the lowest-risk short-term choice but leaves a documented type-system gap. Option 2 is the architecturally cleanest but is a wide refactor. Option 3 is a targeted middle ground. The task is currently stuck (HUMAN_NEEDED) and cannot merge until one path is chosen.
- **Scope:** small (Option 1) | large (Option 2) | medium (Option 3)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** TASK-571 is genuinely stuck in `human-review-queue.md:14` (HUMAN_NEEDED, bucket: decisions) and cannot merge without a design pick; the three options describe real trade-offs and the refinement task is the smallest unblock since the design decision must precede any code work.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document `shared/types/claudeStream.ts` as the canonical source for Claude stream block types in CODE-PATTERNS.md
- **Summary:** `docs/CODE-PATTERNS.md` has no reference to `shared/types/claudeStream.ts`, meaning future authors will re-create local shadow interfaces for stream block types instead of importing the canonical ones — the exact anti-pattern FIND-SPRINT-020-9 identified.
- **Source-Sprint:** SPRINT-020
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-020-10 (sprint-code-reviewer): TASK-570 established `shared/types/claudeStream.ts` as the single source of truth for `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`, and the `ClaudeStreamEvent` union, adding `@deprecated` steering comments to the per-process `session.ts` files. Neither `docs/CODE-PATTERNS.md` nor `docs/ARCHITECTURE.md` document this contract. Without a canonical reference, future agents and authors will likely re-create local shadow interfaces (the pattern FIND-SPRINT-020-9 found in both `toolFormatter.ts` files) and the deprecated aliases will accumulate indefinitely.
- **Proposed change:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ (add a new section after the existing shared/types discussion, or at the end of the file) @@
  +
  +## Claude Stream Block Types
  +
  +**Canonical source:** `shared/types/claudeStream.ts`
  +
  +All Claude stream block shapes (`TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`) and the
  +`ClaudeStreamEvent` discriminated union are defined here. This is the single source of truth for both
  +the main process and the frontend renderer.
  +
  +**Rules:**
  +- Import block types directly from `shared/types/claudeStream.ts`. Do NOT re-declare local `interface`
  +  shadow types for `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, or `ToolResult` — these are the exact
  +  anti-patterns that make widened field types (e.g., `ToolResultBlock.content: string | Array<{type,text}>`)
  +  invisible to TypeScript at downstream callsites.
  +- The `@deprecated` re-exports in `{frontend,main}/src/types/session.ts` (`TextContent`, `ToolUseContent`,
  +  `ToolResultContent`) are a temporary migration bridge. New code must use the canonical names directly.
  +  These re-exports are slated for removal once all consumers migrate.
  +- Any code that reads `ToolResultBlock.content` MUST handle both branches of the union:
  +  `string` (simple text result) and `Array<{type: 'text'; text: string}>` (structured text blocks).
  +  Use a shared helper: `typeof content === 'string' ? content : content.map(b => b.text).join('')`.
  +  Do NOT use `JSON.parse(content)`, `content.includes(...)`, or string template literals on `content`
  +  without this guard — these operations are runtime-unsafe on the array branch and TypeScript will not
  +  catch them if a shadow `interface` narrows `content` back to `string`.
  +- The Zod schema bridge lives at `main/src/services/streamParser/schemas.ts`. The `_typeCheck` compile-time
  +  assertion catches required-field drift between the hand-authored TS interfaces and the Zod schema.
  +  Optional-field drift is not currently caught (acknowledged gap — see SPRINT-020 TASK-571 findings).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** The exact anti-pattern this rule prevents has already manifested twice (`frontend/src/utils/toolFormatter.ts:31`, `main/src/utils/toolFormatter.ts:12`) producing 9+ unsafe callsites and is the root cause of B2; the `@deprecated` migration bridge in both `session.ts` files needs a documented end-state, and `docs/CODE-PATTERNS.md` currently mentions neither.

---

## Suppressed — SoloFlow Defects

- **SPRINT-020 `visual_web_electron_unreachable` config gap** — The recurrence of `verification.visual_web=true` with `playwright_target.kind='electron'` causing failed end-of-sprint visual verification (SPRINT-015, SPRINT-017, SPRINT-020 entries in human-review-queue) describes a SoloFlow sprint-verifier configuration / capability limitation, not a cyboflow codebase rule. The appropriate fix is in the SoloFlow sprint config defaults or verifier tooling, not in this project's `CLAUDE.md`. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
