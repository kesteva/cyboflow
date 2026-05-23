---
id: TASK-736
idea: SPRINT-034-compounder
status: ready
created: "2026-05-23T22:30:00Z"
files_owned:
  - main/src/services/sessionManager.ts
  - .soloflow/active/plans/cyboflow-shell-architecture/TASK-692-plan.md
files_readonly:
  - main/src/database/database.ts
  - main/src/database/schema.sql
  - main/src/database/models.ts
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/services/panelManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/executionTracker.ts
  - main/src/services/taskQueue.ts
  - main/src/ipc/session.ts
  - main/src/ipc/claudePanel.ts
  - main/src/events.ts
  - .soloflow/active/plans/cyboflow-shell-architecture/EPIC-cyboflow-shell-architecture.md
  - .soloflow/active/findings/SPRINT-034-findings.md
acceptance_criteria:
  - criterion: "Truly-orphan sessionManager methods are removed: clearConversation and the getSessionOutput alias (zero callers across frontend/src and main/src verified before deletion)."
    verification: "grep -rnE '\\.(clearConversation|getSessionOutput)\\(' frontend/src main/src returns 0 matches"
  - criterion: "sessionManager.ts no longer defines clearConversation or getSessionOutput methods."
    verification: "grep -nE '^\\s*(clearConversation|getSessionOutput)\\s*\\(' main/src/services/sessionManager.ts returns 0 matches"
  - criterion: "TASK-692-plan.md frontmatter is updated with an audit-derived audit_summary that enumerates every Crystal-era table (sessions, session_outputs, conversation_messages, prompt_markers, execution_diffs) with active-caller count, panel_id co-tenancy flag, and option-C risk."
    verification: "grep -n 'audit_summary' .soloflow/active/plans/cyboflow-shell-architecture/TASK-692-plan.md returns >= 1 match"
  - criterion: "TASK-692-plan.md escalation panelmanager-vs-tool-panels is updated with a 5th option E covering the panel_id co-tenancy gap discovered by this audit."
    verification: "grep -nE 'Option E|option_e' .soloflow/active/plans/cyboflow-shell-architecture/TASK-692-plan.md returns >= 1 match"
  - criterion: "refiner_default_if_unresolved on TASK-692-plan.md is updated to reflect the audit finding (option D — defer — until panel retirement is on the roadmap)."
    verification: "grep -n 'refiner_default_if_unresolved' .soloflow/active/plans/cyboflow-shell-architecture/TASK-692-plan.md returns the audit-updated value referencing option D"
  - criterion: "pnpm typecheck exits 0 (confirms the two removed methods truly had zero callers)."
    verification: "pnpm typecheck"
  - criterion: "pnpm lint exits 0."
    verification: "pnpm lint"
  - criterion: "pnpm --filter main test exits 0 (no regression in main-side suite; sessionManager.mainRepoPermission.test.ts remains green)."
    verification: "pnpm --filter main test"
depends_on: []
estimated_complexity: medium
epic: cyboflow-shell-architecture
prerequisites:
  - check: "ls main/src/database/migrations/008_*.sql"
    fix: "Confirm migrations directory state. If a different 008_*.sql already exists, TASK-692's planned filename will collide; surface this in the updated escalation."
    description: "TASK-692-plan.md proposes a new migration named 008_drop_legacy_crystal_tables.sql. Verify what 008_*.sql files already exist and document any collision in TASK-692-plan.md's audit_summary."
    blocking: false
test_strategy:
  needed: false
  justification: This task removes two confirmed-orphan methods (clearConversation, getSessionOutput alias) with zero callers, and edits a soloflow plan markdown to document an audit. Neither change introduces new behavior. Sibling-test scan: main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts tests getOrCreateMainRepoSession (untouched by this task). The existing suite stays green; running it as part of the AC suite is sufficient.
---
# Audit sessionManager.ts Crystal-era surface and unblock TASK-692

## Objective

FIND-SPRINT-034-11 (TASK-692 executor BLOCKED report) flags that `sessionManager.ts` actively uses Crystal-era DatabaseService methods, preventing TASK-692 from cleanly dropping the underlying tables under option C. **This task does NOT try to retire all Crystal-era sessionManager methods** — that would touch 63+ call sites across `events.ts`, `taskQueue.ts`, `executionTracker.ts`, `claudeCodeManager.ts`, `gitStatusManager.ts`, `AbstractCliManager.ts`, `ipc/session.ts`, `ipc/claudePanel.ts`, `ipc/git.ts`, `ipc/prompt.ts`, `ipc/script.ts`, and `ipc/project.ts`, and the cyboflow-shell-architecture EPIC explicitly puts main-side session-only handlers in **Out of scope**.

Instead, this task does the smaller, targeted work that genuinely helps:

1. **Audit** every Crystal-era table (`sessions`, `session_outputs`, `conversation_messages`, `prompt_markers`, `execution_diffs`) for active main-side consumers. The headline discovery is the **panel_id co-tenancy** problem: `session_outputs`, `conversation_messages`, and `prompt_markers` all hold panel-level rows (panel_id non-NULL, written by `addPanelOutput`, `addPanelConversationMessage`, `addPanelPromptMarker`) alongside session-level rows. TASK-692's option C drops the entire tables, which deletes panel data and breaks `panelManager`.
2. **Delete only truly-orphan methods** from `sessionManager.ts`: `clearConversation` and `getSessionOutput` (the alias to `getSessionOutputs`). Confirmed zero callers across the codebase.
3. **Update TASK-692-plan.md frontmatter** to document the audit findings, add a new escalation option E (column-shrink reconcile), and shift `refiner_default_if_unresolved` from option C to option D (defer) given the panel_id co-tenancy risk.

The deliverable to TASK-692's next executor is: a precise, evidence-backed picture of what option C actually breaks, plus a 5th option for the user to consider.

## Implementation Steps

1. **Completeness gate grep (audit entry point):**
   ```bash
   grep -nE '^  [a-z][A-Za-z]+\(' main/src/services/sessionManager.ts | head -80
   # For each candidate method, count active callers:
   for m in clearConversation getSessionOutput getSessionOutputs addSessionOutput \
            addPromptMarker getPromptMarkers addConversationMessage getConversationMessages \
            createExecutionDiff getExecutionDiffs getExecutionDiff getNextExecutionSequence \
            addInitialPromptMarker addSessionError continueConversation getPromptHistory \
            getPromptById markSessionAsViewed; do
     count=$(grep -rcE "\\.${m}\\(" main/src frontend/src 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
     echo "${m}: ${count}"
   done
   ```
   Methods with `count == 0` are deletion candidates; methods with `count > 0` must stay.

2. **Capture panel_id co-tenancy evidence:**
   ```bash
   grep -nE 'panel_id' main/src/database/database.ts | head -40
   grep -nE 'addPanel(Output|ConversationMessage|PromptMarker)' main/src/database/database.ts
   ```
   Expected: `addPanelOutput` writes to `session_outputs` with non-NULL `panel_id`; `addPanelConversationMessage` writes to `conversation_messages`; `addPanelPromptMarker` writes to `prompt_markers`.

3. **Delete `clearConversation`** from `main/src/services/sessionManager.ts` (the 4-line method calling `db.clearConversationMessages` + `db.clearSessionOutputs`). Confirm zero callers BEFORE deletion via `grep -rn '\.clearConversation(' frontend/src main/src` returning 0.

4. **Delete the `getSessionOutput` alias** from `main/src/services/sessionManager.ts` (the 3-line method that delegates to `getSessionOutputs(id, limit)`). Confirm zero callers via `grep -rn '\.getSessionOutput(' frontend/src main/src` returning 0 (the trailing `(` excludes `getSessionOutputs`).

5. **Update TASK-692-plan.md frontmatter** with two structural additions:

   a. **Add a new top-level `audit_summary:` block** under the existing frontmatter (after `epic:` and before `escalations:`). Populate with the discovered active-caller counts (use ≥ floors), panel_id_cotenancy boolean per table, option_c_risk per table, the two orphan methods this task drops, and a `filename_collision_note` documenting any 008_*.sql collision.

   b. **Add `option_e` to `escalations[0].options`** describing a panel_id-co-tenancy-safe rebuild: table-rebuild reconcile that drops session-only rows (panel_id IS NULL) while preserving panel-level rows. Then drop `sessions` + `execution_diffs` cleanly. Cost: high, but ONLY option compatible with the EPIC's preserve-panelManager rule.

   c. **Update `refiner_default_if_unresolved`** from "C — drop only the Crystal-session subgraph" to "D — defer entirely. The TASK-736 audit revealed option C deletes panel-co-tenant data; option E is feasible but sprint-scale. Deferring is least-risk until panel retirement is on the roadmap."

6. **Re-run the audit greps** from step 1 to confirm the two deletions stuck and the other 30+ methods still exist.

7. **`pnpm typecheck`** — deterministic backstop confirming the two deletions had zero missed callers.

8. **`pnpm lint`** — must exit 0.

9. **`pnpm --filter main test`** — must exit 0. `sessionManager.mainRepoPermission.test.ts` stays green (it tests `getOrCreateMainRepoSession`, untouched here).

10. **Atomic commit:** `refactor(TASK-736): drop orphan sessionManager methods and audit Crystal-era surface for TASK-692`.

## Acceptance Criteria

See frontmatter. The structurally-critical AC is the panel_id co-tenancy escalation update on TASK-692-plan.md — without it, TASK-692's next executor walks into the same trap.

## Test Strategy

No new tests. Two method deletions with zero callers (no behavior to test) plus a documentation-frontmatter update. The existing `sessionManager.mainRepoPermission.test.ts` is the regression backstop.

## Hardest Decision

**Whether to retire any Crystal-era method with non-zero callers.** The proposal's wording sounds sweeping, but the call-graph audit reveals every such method has at least one active caller in the still-shipping orchestrator/panel pipeline (the methods Crystal originated are also the methods the panel pipeline now uses via `panel_id` columns added by migration 004). There is no method to retire without also retiring its panel-level caller, and panel retirement is out-of-scope per the EPIC. So the audit *is* the deliverable; method deletion is necessarily small.

## Rejected Alternatives

- **Wholesale retirement of Crystal-era sessionManager methods.** Rejected as out-of-scope per the cyboflow-shell-architecture EPIC. Would touch ~12 files / ~63 callsites. Sprint-scale work.
- **Drop sessions-table-only methods while keeping panel-level methods.** Rejected: `sessions` is FK-referenced by `tool_panels.session_id`; dropping it cascades into panel-init errors.
- **Stub orphan methods to no-op instead of deleting.** Rejected: zero callers means nothing observes the stub. Deletion is cleaner; `pnpm typecheck` is the backstop.
- **Author the new migration in this task to "actually unblock" TASK-692.** Rejected: this task is the audit; the migration authoring is TASK-692's job and depends on the user's escalation resolution. Conflating ownership risks a partial commit.

## Lowest Confidence Area

**Completeness of the active-caller counts in `audit_summary`.** The `grep -rcE` counts are line-count summaries, not semantic-caller counts. A comment line mentioning a method counts. The numbers are documented as floors (≥15, ≥20, etc.); the deterministic backstop is `pnpm typecheck` after step 3/4's actual deletions — any missed real caller will surface.

**Whether option E (column-shrink reconcile) is actually feasible.** Table-rebuild reconciles are precedented in this codebase (post-006 reconciler in database.ts) but writing three in parallel under SQLite FK semantics is non-trivial. The audit only proposes option E as a candidate; the user/TASK-692-executor evaluates feasibility when they read the updated escalation.
