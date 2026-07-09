-- 057: Persistent user-controlled manual rank for board/list ordering.
-- Nullable REAL on all three entity tables; NULL = unranked (falls back to the
-- legacy created_at/ref ordering). No backfill, no index — the board's row
-- counts are small and ranked rows sort ahead of unranked in the read path.

ALTER TABLE ideas ADD COLUMN sort_order REAL;
ALTER TABLE epics ADD COLUMN sort_order REAL;
ALTER TABLE tasks ADD COLUMN sort_order REAL;
