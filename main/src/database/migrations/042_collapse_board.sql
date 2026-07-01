-- Migration 042: collapse the board to 4 stages + add approval/decompose stamps.
--
-- The 12-stage planning board (014 seeded 1..11; 015 added 12 'Decomposed';
-- 024 removed 11 'Archived') is narrowed to the FOUR kept stages at their
-- existing positions: 1 'Idea', 6 'Ready for development', 9 'Done',
-- 10 'Won't do' (terminal, hidden_by_default). Positions 2,3,4,5,7,8,12 are
-- REMOVED. The intermediate planning stages become invisible app state instead
-- of board columns:
--   * ideas.decomposed_at  (NULL = still on the board; stamped = retired,
--     reachable only via children — the old position-12 'Decomposed' meaning).
--   * epics.approved_at / tasks.approved_at  (NULL = PENDING = backend-invisible
--     + sprint-INELIGIBLE until plan approval; backfilled here so EXISTING
--     entities stay visible).
--   * workflow_runs.plan_approved_at  (stamped when a run's approve-plan gate is
--     approved; left NULL for all existing runs).
--
-- RELOCATION (mirrors 024's relocate-then-delete template exactly): every
-- occupant of a removed position is moved to a kept position on its OWN board
-- (board-scoped SET subselect, COALESCE keep-current fallback) BEFORE the
-- board_stages rows are DELETEd, because the entities' stage_id FKs are
-- ON DELETE RESTRICT — a single un-moved occupant would brick the migration.
--   ideas  2,3,4,5,7,8 -> position 1 (stay on the board).
--   ideas  12          -> position 1 AND decomposed_at = updated_at (retired).
--   epics  2,3,4,5,7,8,12 -> position 6.
--   tasks  2,3,4,5,7,8,12 -> position 6.
-- Position 10 ('Won't do') is KEPT and never touched.
--
-- EPIC ROLLUP: an epic whose every non-archived child task is at position 9
-- ('Done') is itself rolled up to its board's position-9 stage (so collapsing
-- the board does not strand a fully-done epic in 'Ready for development').
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite ALTER TABLE does not support
-- it. Re-running this file (after a ledger reset) fails on the FIRST statement
-- with 'duplicate column name: decomposed_at', which runFileBasedMigrations()
-- treats as the idempotency signal (same mechanism as 013/017/018/024); because
-- the runner wraps the file in a transaction, the later UPDATE/DELETE statements
-- never re-execute and the post-042 state is left intact.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.

-- ---------------------------------------------------------------------------
-- 1. Add the approval/decompose stamps (NULL = pending/active). The FIRST ALTER
--    is the idempotency sentinel (re-run => 'duplicate column name: decomposed_at').
-- ---------------------------------------------------------------------------
ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;
ALTER TABLE epics ADD COLUMN approved_at TEXT;
ALTER TABLE tasks ADD COLUMN approved_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;

-- ---------------------------------------------------------------------------
-- 2. Backfill approval for EXISTING entities so they stay visible (NULL would
--    make them PENDING/backend-invisible). COALESCE keeps any value already set.
--    workflow_runs.plan_approved_at is intentionally left NULL.
-- ---------------------------------------------------------------------------
UPDATE epics SET approved_at = COALESCE(approved_at, updated_at);
UPDATE tasks SET approved_at = COALESCE(approved_at, updated_at);

-- ---------------------------------------------------------------------------
-- 3. Relocate occupants of the removed positions to a kept position on the SAME
--    board. Board-scoped SET subselect with a COALESCE keep-current fallback
--    (defensive; the seed always creates 1/6/9/10). Each arm covers ALL removed
--    positions so no occupant is left to trip the ON DELETE RESTRICT FKs.
-- ---------------------------------------------------------------------------
-- ideas at 2,3,4,5,7,8 -> position 1 (stay on the board; decomposed_at stays NULL).
UPDATE ideas
SET stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = ideas.board_id AND bs.position = 1),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position IN (2, 3, 4, 5, 7, 8));

-- ideas at 12 -> position 1 AND stamp decomposed_at (retired; reachable via children).
UPDATE ideas
SET decomposed_at = updated_at,
    stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = ideas.board_id AND bs.position = 1),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position = 12);

-- epics at 2,3,4,5,7,8,12 -> position 6.
UPDATE epics
SET stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = epics.board_id AND bs.position = 6),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position IN (2, 3, 4, 5, 7, 8, 12));

-- tasks at 2,3,4,5,7,8,12 -> position 6.
UPDATE tasks
SET stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = tasks.board_id AND bs.position = 6),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position IN (2, 3, 4, 5, 7, 8, 12));

-- ---------------------------------------------------------------------------
-- 4. Null any execution-entry capture that pointed at a removed stage
--    (entry_stage_id has no FK; nulling keeps the revert target honest).
-- ---------------------------------------------------------------------------
UPDATE tasks
SET entry_stage_id = NULL
WHERE entry_stage_id IN (SELECT id FROM board_stages WHERE position IN (2, 3, 4, 5, 7, 8, 12));

-- ---------------------------------------------------------------------------
-- 5. EPIC ROLLUP: an epic with >=1 non-archived child task, where EVERY
--    non-archived child task is at position 9 ('Done'), is rolled up to its
--    board's position-9 stage. Board-scoped SET subselect (mirrors 024).
--
--    An epic a human PARKED at position 10 ('Won't do') is EXCLUDED: Won't do is
--    an explicit human decision, and resurrecting it into the visible Done column
--    is the resurrection the runtime recomputeEpicStage refuses. Board-scoped
--    lookup (mirrors the relocate arms above). Epics at any OTHER pre-collapse
--    position were already funneled to 6 by step 3, so 10 is the only guard.
-- ---------------------------------------------------------------------------
UPDATE epics
SET stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = epics.board_id AND bs.position = 9),
      stage_id
    )
WHERE stage_id NOT IN (
        SELECT bs.id FROM board_stages bs WHERE bs.board_id = epics.board_id AND bs.position = 10
      )
  AND EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.parent_epic_id = epics.id
          AND t.archived_at IS NULL
      )
  AND NOT EXISTS (
        SELECT 1
        FROM tasks t
        JOIN board_stages bs2 ON bs2.id = t.stage_id
        WHERE t.parent_epic_id = epics.id
          AND t.archived_at IS NULL
          AND bs2.position <> 9
      );

-- ---------------------------------------------------------------------------
-- 6. Remove the collapsed stages from every board. All occupants were moved in
--    steps 3 + 5, so the entities' ON DELETE RESTRICT stage_id FKs cannot fire.
--    Position 10 ('Won't do') is KEPT.
-- ---------------------------------------------------------------------------
DELETE FROM board_stages WHERE position IN (2, 3, 4, 5, 7, 8, 12);
