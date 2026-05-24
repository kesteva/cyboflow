---
id: TASK-736
sprint: SPRINT-036
epic: cyboflow-shell-architecture
status: done
summary: "Audit sessionManager Crystal-era surface, drop two orphan methods, update TASK-692 plan with panel_id co-tenancy escalation."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-736 — Done

## Summary
Audited Crystal-era tables (`sessions`, `session_outputs`, `conversation_messages`, `prompt_markers`, `execution_diffs`) for active main-side consumers, surfaced the panel_id co-tenancy risk (three tables hold panel-level rows that TASK-692 option C would silently delete), deleted two confirmed-orphan methods (`clearConversation`, `getSessionOutput` alias) from `sessionManager.ts`, and updated TASK-692-plan.md frontmatter with `audit_summary`, new option E (panel-co-tenancy-safe rebuild), and revised `refiner_default_if_unresolved → D`. Also surfaced `008_permission_mode_approve_default.sql` filename collision so TASK-692 must use `009_*`.

## Verification
- `pnpm typecheck` → 0 errors (deterministic backstop for zero-caller claim).
- `pnpm --filter main test` → 653/653 pass.
- `pnpm lint` → 0 errors.
- All eight acceptance criteria pass.
- Visual verification: not_applicable — backend deletion + plan markdown update.

## Code Review
CLEAN. Audit findings accurate per database.ts inspection.

## Commit
- `c183a9b` — `refactor(TASK-736): drop orphan sessionManager methods and audit Crystal-era surface for TASK-692`
