-- Migration 061: re-introduce the derived position-7 'In development' stage.
--
-- Migration 014 originally seeded a position-7 'In development' stage with
-- write_policy='derived' (an orchestrator-owned execution stage); migration 042
-- collapsed the board to the four kept stages (1 'Idea', 6 'Ready for
-- development', 9 'Done', 10 "Won't do") and DELETEd positions 2,3,4,5,7,8,12.
-- We now bring back ONLY position 7 so a task pulled into a live run has a
-- visible board home distinct from 'Ready for development': the deriver
-- (recomputeTaskExecutionStage) moves a task to 7 while any run association is
-- active and reverts it to its entry stage when all its runs end without merging.
--
-- The stage is re-inserted for EVERY board with the original 014 values
-- (label / color_oklch / write_policy='derived' / is_terminal=0 /
-- hidden_by_default=0); only the hint is rephrased for the new session-pull
-- semantics. Deterministic id 'stage-{boardId}-7' + INSERT OR IGNORE
-- keeps this idempotent and safe against the UNIQUE(board_id, position) constraint
-- (a board that somehow already carries a position-7 row is left untouched).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() in database.ts wraps
-- every file in a this.transaction(...) call, so an inner BEGIN would nest.
-- Re-running the file (after a ledger reset) is a clean no-op via INSERT OR IGNORE.

INSERT OR IGNORE INTO board_stages (id, board_id, label, color_oklch, hint, position, write_policy, is_terminal, hidden_by_default)
SELECT 'stage-' || b.id || '-7', b.id, 'In development', 'oklch(0.63 0.16 45)', 'Pulled into a live session', 7, 'derived', 0, 0 FROM boards b;
