-- Migration 052: workflow A/B testing — variant-outcome promotion verdict.
--
-- The compare-view footer splits two decisions that used to be conflated: (1) the
-- CHANGES decision — which arm's concrete output to accept (existing
-- experiments.decide) — and (2) the VARIANT-OUTCOME decision — which workflow
-- VERSION wins going forward (experiments.promoteVariant, NEW). Piece 2 is gated
-- on piece 1 being concluded (experiment decided/abandoned), so it is recorded as
-- a separate, later stamp on the same experiments row rather than folded into the
-- existing winner_run_id/winner_arm/decided_at columns.
--
-- promoted_variant_id holds either the adopted variant's id, or the
-- BASELINE_VARIANT_SENTINEL ('__baseline__') when the current-workflow baseline
-- arm won the variant-outcome verdict (the workflow definition is left unchanged;
-- only the verdict is recorded). All three columns are NULL until promoteVariant
-- runs, and stay NULL forever for an experiment whose variant outcome was never
-- decided (piece 2 is optional — a user may only ever record the changes decision).
--
-- Migration ownership (cross-slice contract): 048 owns workflow_variants + the
-- four workflow_runs stamp columns; 049 owns the experiments table + the
-- ideas/epics/tasks sandbox+attribution columns + workflow_runs.merge_sha; 050
-- owns experiment_comparisons; 051 owns experiment_seed_tasks; 052 (this file)
-- owns ONLY these three new experiments columns.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: numbers 043/044/045/046/047/048/049 were
-- previously claimed (at various points) by sibling branches, per the collision
-- notes on 049-051. The ledger is filename-keyed; whichever branch lands second
-- must renumber. The integrator MUST verify no other 052_*.sql exists at merge
-- time (`ls main/src/database/migrations/`).

ALTER TABLE experiments ADD COLUMN promoted_variant_id TEXT;
ALTER TABLE experiments ADD COLUMN promoted_arm TEXT CHECK (promoted_arm IN ('A','B'));
ALTER TABLE experiments ADD COLUMN promoted_at TEXT;
