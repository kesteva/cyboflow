-- 059: entity `category` classification (feature|bug|chore), mirroring `priority`.
-- NOT-NULL-with-default + column-level CHECK is legal on ADD COLUMN (no table
-- recreate needed, unlike a CHECK widen on an EXISTING column — see 058's
-- kind/status rebuild for that harder case). Default 'feature' backfills every
-- existing row.

ALTER TABLE ideas ADD COLUMN category TEXT NOT NULL DEFAULT 'feature' CHECK (category IN ('feature','bug','chore'));
ALTER TABLE epics ADD COLUMN category TEXT NOT NULL DEFAULT 'feature' CHECK (category IN ('feature','bug','chore'));
ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'feature' CHECK (category IN ('feature','bug','chore'));
