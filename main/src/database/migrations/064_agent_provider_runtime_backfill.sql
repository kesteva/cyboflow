-- Migration 064: provider/runtime backfill from legacy substrate columns.
--
-- Keep sessions.substrate and workflow_runs.substrate as Claude compatibility
-- projections during the migration window, but materialize the new provider /
-- runtime columns so readers do not have to infer them ad hoc.

UPDATE sessions
SET
  agent_provider = 'claude',
  agent_runtime =
    CASE substrate
      WHEN 'interactive' THEN 'claude-interactive'
      ELSE 'claude-sdk'
    END
WHERE agent_provider = 'claude';

UPDATE workflow_runs
SET
  agent_provider = 'claude',
  agent_runtime =
    CASE substrate
      WHEN 'interactive' THEN 'claude-interactive'
      ELSE 'claude-sdk'
    END
WHERE agent_provider = 'claude';
