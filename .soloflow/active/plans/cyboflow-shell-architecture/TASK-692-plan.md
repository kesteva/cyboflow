---
id: TASK-692
idea: IDEA-017
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/database/migrations/008_drop_legacy_crystal_tables.sql
  - main/src/database/database.ts
  - main/src/database/models.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/database/__tests__/fileMigrationRunner.test.ts
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/migrations/003_add_tool_panels.sql
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/005_unified_panel_settings.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/services/sessionManager.ts
  - main/src/services/panelManager.ts
  - shared/types/panels.ts
  - main/src/types/session.ts
acceptance_criteria:
  - criterion: "Migration 008_drop_legacy_crystal_tables.sql exists and uses idempotent DROP ... IF EXISTS only."
    verification: "test -f main/src/database/migrations/008_drop_legacy_crystal_tables.sql && grep -c 'DROP TABLE IF EXISTS' main/src/database/migrations/008_drop_legacy_crystal_tables.sql returns >= 5; grep -nE '^(DROP TABLE [^I]|DROP INDEX [^I])' returns 0 matches"
  - criterion: "Migration drops the agreed table set per escalation resolution (default option C: sessions, session_outputs, conversation_messages, prompt_markers, execution_diffs)."
    verification: "grep -oE 'DROP TABLE IF EXISTS [a-z_]+' main/src/database/migrations/008_drop_legacy_crystal_tables.sql | sort -u matches the user-resolved drop set"
  - criterion: "Migration does NOT touch any cyboflow-schema table or preserved table."
    verification: "grep -nE '\\b(workflows|workflow_runs|raw_events|messages|approvals|projects|user_preferences|app_opens|ui_state|folders|project_run_commands|git_credentials)\\b' main/src/database/migrations/008_drop_legacy_crystal_tables.sql returns 0 matches"
  - criterion: "pnpm typecheck exits 0."
    verification: "pnpm typecheck"
  - criterion: "pnpm test (vitest) exits 0; cyboflowSchema.test.ts and fileMigrationRunner.test.ts green."
    verification: "pnpm test exits 0"
  - criterion: "After fresh-init via DatabaseService, dropped tables are absent; all 5 cyboflow tables still exist."
    verification: "New vitest case in cyboflowSchema.test.ts asserts dropped tables absent + 5 cyboflow tables present"
  - criterion: "Migration runs idempotently — second initialize() does not re-apply 008."
    verification: "New vitest case asserts ledger marker prevents re-execution, no console.error calls"
  - criterion: "Migration runs cleanly against an upgraded DB simulating existing user install."
    verification: "New vitest case: svc1 simulates pre-008 state, svc2 applies 008, dropped tables absent after svc2"
  - criterion: "database.ts no longer contains methods issuing SQL against dropped tables."
    verification: "grep -nE 'FROM\\s+(sessions|session_outputs|conversation_messages|prompt_markers|execution_diffs)\\b' main/src/database/database.ts returns 0 matches"
  - criterion: "models.ts no longer exports Crystal-session types (Session, SessionOutput, ConversationMessage, etc.) — provided TASK-691 resolved consumers."
    verification: "grep -nE '^export interface (Session|SessionOutput|ConversationMessage|CreateSessionData|UpdateSessionData|PromptMarker|ExecutionDiff)\\b' main/src/database/models.ts returns 0 matches"
  - criterion: "App boot smoke: dev launch produces no SQLite errors against dropped tables."
    verification: "pnpm dev for 30s; grep 'no such table' cyboflow-backend-debug.log returns 0 matches"
depends_on: [TASK-691]
estimated_complexity: high
epic: cyboflow-shell-architecture
escalations:
  - id: panelmanager-vs-tool-panels
    severity: blocking
    decision_owner: user
    summary: "Dropping `tool_panels` is incompatible with the `crystal-cuts-and-rebrand` epic's standing rule that `panelManager` be preserved. As of 2026-05-20 the main process has 22 files consuming `panelManager`/panel APIs and 21 files consuming session APIs (claudeCodeManager, terminalPanelManager, logsManager, executionTracker, gitStatusManager, taskQueue, AbstractCliManager, IPC handlers). None of these are touched by TASK-691 (which is a frontend-only retirement per IDEA-017 slice 3). If 008 drops the tables while these consumers remain, the next dev launch will throw `SqliteError: no such table: tool_panels` at `PanelManager.loadPanelsFromDatabase()`. This was flagged by the decomposer."
    options:
      - id: A
        label: "Expand TASK-692 to retire panelManager + sessionManager + all 22+ IPC/service consumers."
        cost: "~2-3 day execution; touches IPC contract surface. Risk: cascades into orchestrator surface. Sprint-scale rip-out."
      - id: B
        label: "Insert new sibling task TASK-692a before this one that retires backend consumers; keep TASK-692 as table-drop only."
        cost: "Re-runs the decomposer; pushes 008 out by one task slot. Cleaner ownership boundary."
      - id: C
        label: "Drop only the Crystal-session subgraph (sessions, session_outputs, conversation_messages, prompt_markers, execution_diffs). Keep tool_panels + claude_panel_settings because panelManager still consumes them."
        cost: "Lowest. Aligns with crystal-cuts-and-rebrand 'preserve panelManager' rule. Leaves disposition open for future epic."
      - id: D
        label: "Defer TASK-692 entirely; @cyboflow-hidden-mark schema.sql section and revisit after SDK-migration stabilizes."
        cost: "Keeps schema drift; matches IDEA-017 candidate 2 ('kept as orphan tables for v2')."
    refiner_default_if_unresolved: "C — drop only the Crystal-session subgraph"
    blocking: true
test_strategy:
  needed: true
  justification: "Destructive migration with irreversible production consequences. Existing cyboflowSchema.test.ts and fileMigrationRunner.test.ts are sibling tests; post-006 reconciler test pattern is the canonical template."
  targets:
    - behavior: "After fresh DatabaseService.initialize(), dropped tables are absent and cyboflow tables remain."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "After simulated upgrade (svc1 creates legacy tables, svc2 applies 008), dropped tables are gone, no console.error."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "Re-initializing twice with 008 applied is idempotent."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "File-based migration runner picks up 008 by numeric prefix and applies it after 007."
      test_file: "main/src/database/__tests__/fileMigrationRunner.test.ts"
      type: integration
---

# Drop legacy Crystal DB tables via a reconcile-style migration

## Objective

Author migration `008_drop_legacy_crystal_tables.sql` to remove the Crystal-era schema, then strip corresponding query methods from `database.ts` and unused types from `models.ts`. **BEFORE any code change, the executor MUST resolve the `panelmanager-vs-tool-panels` escalation in the frontmatter.** Option C is the default if user does not respond: drop `sessions`, `session_outputs`, `conversation_messages`, `prompt_markers`, `execution_diffs`. Keep `tool_panels` and `claude_panel_settings` until `panelManager` is retired in a separate task.

## Implementation Steps

1. **Resolve escalation `panelmanager-vs-tool-panels` first.** Do not write SQL until resolved. Remaining steps assume **option C unless overridden**.

2. **Completeness gate grep:**
   ```bash
   grep -rnE "FROM\s+(sessions|session_outputs|conversation_messages|prompt_markers|execution_diffs)\b|INTO\s+(sessions|session_outputs|conversation_messages|prompt_markers|execution_diffs)\b|UPDATE\s+(sessions|conversation_messages|session_outputs|prompt_markers|execution_diffs)\s|DELETE\s+FROM\s+(sessions|conversation_messages|session_outputs|prompt_markers|execution_diffs)\s" main/src --include='*.ts' --include='*.sql' | grep -v 'migrations/003\|migrations/004\|migrations/005\|migrations/legacy/'
   ```
   Expected: references confined to `main/src/database/database.ts`. If hits elsewhere, STOP — TASK-691 didn't fully retire backend consumers.

3. **Author `008_drop_legacy_crystal_tables.sql`** modeling on `007_add_stuck_reason.sql` and `005_unified_panel_settings.sql`. Option C content includes leading comment block + idempotent DROP INDEX IF EXISTS + DROP TABLE IF EXISTS for: `idx_sessions_*`, `idx_session_outputs_*`, `idx_conversation_messages_*`, `idx_prompt_markers_*`, `idx_execution_diffs_*`, then DROP TABLE for `execution_diffs`, `prompt_markers`, `conversation_messages`, `session_outputs`, `sessions` (FK cascade order: children first).

4. **Update `main/src/database/database.ts`** — remove dead query methods (locate by name, not line):
   - Session methods: `createSession`, `getSession`, `getAllSessions`, `updateSession`, etc.
   - Session output methods: `addSessionOutput`, `getSessionOutputs`, etc.
   - Conversation methods: `addConversationMessage`, `getConversationMessages`, etc.
   - Prompt marker methods: `addPromptMarker`, `getPromptMarkers`, etc.
   - Execution diff methods: `createExecutionDiff`, etc.
   - Token usage / display order helpers scoped to sessions
   - The `'sessions'` overload of `getTableStructure`
   - Inline migration blocks in `runMigrations()` that bootstrap these tables (003, 004, 005-related branches; KEEP `folders` and `tool_panels` paths under option C).

5. **Update `main/src/database/models.ts`** — under option C, delete types: `Session`, `SessionOutput`, `ConversationMessage`, `CreateSessionData`, `UpdateSessionData`, `PromptMarker`, `ExecutionDiff`, `CreateExecutionDiffData`. KEEP: `Project`, `ProjectRunCommand`, `Folder`. Run `pnpm typecheck` to catch any TASK-691-missed consumer.

6. **Add test cases to `cyboflowSchema.test.ts`** modeling on the post-006 reconciler suite (lines 542-729). Three cases: fresh-install drop, upgrade-install drop, idempotency.

7. **Add regression case to `fileMigrationRunner.test.ts`** confirming 008 picks up by numeric prefix after 007.

8. **Re-run completeness gate** from step 2. Expected: zero hits outside historical 003/004/005 files. Also `grep -rnE '\b(Session|SessionOutput|ConversationMessage|CreateSessionData|UpdateSessionData|PromptMarker|ExecutionDiff)\b' main/src/database/database.ts main/src/database/models.ts` — 0 hits.

9. **Boot smoke.** `pnpm build:main && pnpm dev` for ~30s. `grep -E 'no such table' cyboflow-backend-debug.log` — 0 matches.

10. **Commit.** Atomic commit per global rule: `feat(TASK-692): drop legacy Crystal session tables via migration 008`.

## Acceptance Criteria

See frontmatter. The most-easily-missed criterion is no-orphan-types in `models.ts` — `pnpm typecheck` fails loudly if TASK-691 missed a consumer, which is the early-warning signal for re-escalation.

## Test Strategy

New tests in `cyboflowSchema.test.ts` (3 cases) + 1 in `fileMigrationRunner.test.ts`. Pattern from existing post-006 reconciler block.

## Hardest Decision

**The `panelmanager-vs-tool-panels` tension** is structural and blocks naive execution. Three sub-decisions stack:
1. **Which tables actually exist?** IDEA names "panels"/"panel_settings"; real schema has `tool_panels` and `claude_panel_settings` (the latter created by 004, inlined into `tool_panels.settings` by 005).
2. **Can TASK-691 retire panel consumers?** No — `panelManager.ts` has 22 main-process consumers; TASK-691 is frontend-only.
3. **Right drop list?** Option C — honors crystal-cuts "preserve panelManager" rule, matches actual orphan set, defers `tool_panels` decision to a later epic.

## Rejected Alternatives

- **Option A (expand to retire all consumers).** Inverts decomposer's sizing; sprint-scale.
- **Option B (insert TASK-692a sibling).** Viable but requires mid-flight re-plan.
- **Option D (defer entirely).** IDEA-017 author explicitly closed slice 5 on "drop via reconcile". Deferring contradicts user intent.
- **Tier-2 table-rebuild pattern from `reconcileWorkflowsSchema()`.** Irrelevant — DROP TABLE doesn't need column-drift reconcile.
- **Authoring as inline `runMigrations()` code.** IDEA invokes the file-based runner; inline migrations are legacy pattern.

## Lowest Confidence Area

**Option C drop list completeness.** Step 2's grep should catch all consumers but only checks raw SQL string matches in `*.ts`. If a consumer references these tables via a removed `database.ts` method, `pnpm typecheck` catches it. Boot smoke (step 9) is the runtime safety net. Confidence is medium-high that TASK-691 retires all frontend consumers and no dynamic-SQL paths exist in main-process services.
