---
id: IDEA-004
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "cyboflow-schema-migration"
slices:
  - title: "006_cyboflow_schema.sql migration with 5 new tables"
    description: "Single migration file in main/src/database/migrations/ creating: workflows, workflow_runs, raw_events, messages, approvals. IF NOT EXISTS guards. No foreign keys to Crystal's tables (sessions, tool_panels) — strict separation per design doc §5.3."
    value_statement: "Atomic schema addition; reviewable as one diff; no partial-apply states"
  - title: "Day-1 indexes for raw_events and approvals query patterns"
    description: "Create indexes: raw_events(run_id, id), raw_events(event_type, run_id), approvals(status, created_at), workflow_runs(status, created_at). 100k+ raw_events rows projected for 1-day self-host make these non-optional."
    value_statement: "Prevents WAL checkpoint starvation and slow history-view queries during the self-host bar"
  - title: "State machine columns supporting 8-state enum on workflow_runs"
    description: "Status column accepts: queued | starting | running | awaiting_review | stuck | completed | failed | canceled. Plus stuck_at, stuck_reason for stuck-detection (added in epic 10)."
    value_statement: "Enables the full state machine from §5.3 plus the §5.7 stuck-state detection"
  - title: "Atomic awaiting_review co-write transaction helper"
    description: "Wrap workflow_runs UPDATE + approvals INSERT in db.transaction() with BEGIN IMMEDIATE. Status guard on the UPDATE ('AND status=running') prevents revival of canceled runs by late approvals."
    value_statement: "Race-condition protection between approval routing and run cancellation"
  - title: "Verify Crystal's migration runner applies numeric-prefixed files in order"
    description: "Crystal's runMigrations() in database.ts uses hybrid approach (inline ALTER TABLE + numbered .sql files). Confirm 006_cyboflow_schema.sql runs after 005_unified_panel_settings.sql, not lexicographically before files with no numeric prefix."
    value_statement: "Ensures the migration actually runs at the right time on fresh installs"
open_questions:
  - "Does Crystal's migration runner sort by lexicographic or numeric order? Architecture research called this out as needing inspection past line 250 of database.ts."
assumptions: []
research_recommendation: not_needed
research_rationale: "Architecture research (§8, §9) detailed the schema delta, the state machine invariants, and the migration system gotchas. The transaction-helper pattern is concrete."
---

# Cyboflow Schema Migration

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "cyboflow-schema-migration".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

System design §5.3 specifies the 5 new tables. Architecture research §8 confirmed strict separation (no FKs to Crystal's sessions/tool_panels) is correct, and that Crystal's migration runner is a hybrid mess (inline 003-005 + sometimes-named .sql files). Risks research §8 grounded the index choices in the 115k-row projection for a 1-day self-host.

## Slices

See frontmatter `slices` field. Five slices: (1) migration file, (2) indexes, (3) state machine columns, (4) transaction helper, (5) migration runner verification.

## Open Questions

- Migration runner ordering — need to confirm Crystal's runMigrations() sorts numeric-prefixed files correctly.

## Assumptions

None — schema design is validated by research.
