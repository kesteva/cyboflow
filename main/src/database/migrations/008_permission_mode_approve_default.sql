-- Migration 008: backfill NULL permission_mode rows to 'approve'.
-- Idempotent — runs only when rows have NULL (never set by the application).
-- Does NOT rewrite existing 'ignore' rows; users who explicitly chose it via
-- the legacy UI may have intended that value.
UPDATE sessions SET permission_mode = 'approve' WHERE permission_mode IS NULL;
UPDATE projects SET default_permission_mode = 'approve' WHERE default_permission_mode IS NULL;
