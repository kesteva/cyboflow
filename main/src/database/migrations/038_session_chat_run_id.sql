-- 038_session_chat_run_id.sql
-- Persistent chat-sentinel gate vehicle. Independent of sessions.run_id (which
-- keeps pointing at the latest FLOW run for display/diff/close-out). Chat turns
-- gate on chat_run_id; flow steps gate on the flow run itself.
ALTER TABLE sessions ADD COLUMN chat_run_id TEXT;

-- Backfill: a session whose run_id ALREADY points at a __quick__ sentinel keeps
-- that sentinel as its chat vehicle. Flow-only / legacy sessions get NULL and a
-- sentinel is minted ON READ at the gate-resolution chokepoint on the next chat turn.
UPDATE sessions SET chat_run_id = run_id
  WHERE run_id IN (
    SELECT wr.id FROM workflow_runs wr
    JOIN workflows w ON w.id = wr.workflow_id
    WHERE w.name = '__quick__'
  );
