-- Migration 024: archive-in-place (`archived_at` stamp) + remove the 'Archived' board stage.
--
-- Archiving NO LONGER moves an entity to the terminal 'Archived' stage
-- (position 11). Instead each entity table gains a nullable `archived_at`
-- TEXT column (ISO timestamp; NULL = active) stamped/cleared by the
-- chokepoint (TaskChangeRouter.applyChange). Archived items keep their
-- current stage/column and are hidden client-side unless the 'Archived'
-- header toggle is on.
--
-- Existing position-11 occupants are migrated: `archived_at = updated_at`
-- (the last touch is the best available archive time) and `stage_id`
-- relocates to the type-default stage on the SAME board (idea -> position 1,
-- epic -> 4, task -> 5), with a COALESCE fallback that keeps the current
-- stage_id if the target stage is somehow missing. Task `entry_stage_id`
-- references to a position-11 stage are nulled. The position-11
-- board_stages rows are then DELETEd on every board — safe under the
-- entities' ON DELETE RESTRICT stage_id FKs because every occupant was
-- moved first. database.ts seedDefaultBoard stops seeding position 11 in
-- the same change (new boards: positions 1..10 + 12); seedBoardParity.test.ts
-- pins both sides.
--
-- NUMBERING: 022/023 are deliberately skipped — they are reserved by the
-- unmerged feat/parallel-sprint branch. The runner (runFileBasedMigrations)
-- is filename-ledgered and gap-tolerant, so the gap is harmless.
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite ALTER TABLE does not support
-- it. Re-running this file (after a ledger reset) fails on the FIRST statement
-- with 'duplicate column name: archived_at', which runFileBasedMigrations()
-- treats as the idempotency signal (same mechanism as 013/017/018); because
-- the runner wraps the file in a transaction, the later UPDATE/DELETE
-- statements never re-execute and the post-024 state is left intact.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.

-- ---------------------------------------------------------------------------
-- 1. Add the archive-in-place stamp to all three entity tables (NULL = active).
-- ---------------------------------------------------------------------------
ALTER TABLE ideas ADD COLUMN archived_at TEXT;
ALTER TABLE epics ADD COLUMN archived_at TEXT;
ALTER TABLE tasks ADD COLUMN archived_at TEXT;

-- ---------------------------------------------------------------------------
-- 2. Relocate position-11 ('Archived' stage) occupants: stamp archived_at from
--    updated_at and move stage_id to the type-default stage on the same board
--    (idea -> 1, epic -> 4, task -> 5). COALESCE keeps the current stage_id if
--    the target stage is missing (defensive; the seed always creates 1..10+12).
-- ---------------------------------------------------------------------------
UPDATE ideas
SET archived_at = updated_at,
    stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = ideas.board_id AND bs.position = 1),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position = 11);

UPDATE epics
SET archived_at = updated_at,
    stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = epics.board_id AND bs.position = 4),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position = 11);

UPDATE tasks
SET archived_at = updated_at,
    stage_id = COALESCE(
      (SELECT bs.id FROM board_stages bs WHERE bs.board_id = tasks.board_id AND bs.position = 5),
      stage_id
    )
WHERE stage_id IN (SELECT id FROM board_stages WHERE position = 11);

-- ---------------------------------------------------------------------------
-- 3. Null any execution-entry capture that pointed at the removed stage
--    (entry_stage_id has no FK; nulling keeps the revert target honest).
-- ---------------------------------------------------------------------------
UPDATE tasks
SET entry_stage_id = NULL
WHERE entry_stage_id IN (SELECT id FROM board_stages WHERE position = 11);

-- ---------------------------------------------------------------------------
-- 4. Remove the 'Archived' stage from every board. All occupants were moved in
--    step 2, so the entities' ON DELETE RESTRICT stage_id FKs cannot fire.
-- ---------------------------------------------------------------------------
DELETE FROM board_stages WHERE position = 11;
