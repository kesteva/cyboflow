-- Add permission mode to sessions table
-- NOTE: superseded by inline ALTER in database.ts and migration 008.
ALTER TABLE sessions ADD COLUMN permission_mode TEXT DEFAULT 'approve' CHECK(permission_mode IN ('approve', 'ignore'));

-- Also add default permission mode to projects
ALTER TABLE projects ADD COLUMN default_permission_mode TEXT DEFAULT 'approve' CHECK(default_permission_mode IN ('approve', 'ignore'));
