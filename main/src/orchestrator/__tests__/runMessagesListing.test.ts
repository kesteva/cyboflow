/**
 * Integration tests for selectRunMessages (TASK-759).
 *
 * Tests:
 *  1. Empty raw_events for the run → []
 *  2. Assistant text + user text events → ChatMessage[] in created_at ASC order
 *  3. Pure tool_use assistant event → skipped (no ChatMessage emitted)
 *  4. Pure tool_result user event → skipped (no ChatMessage emitted)
 *  5. Mixed assistant event (tool_use + text blocks) → only text extracted
 *  6. Run isolation: only rows for the given runId are returned
 */
import { describe, it, expect } from 'vitest';
import { selectRunMessages } from '../runMessagesListing';
import { makeRawEventsDb } from '../__test_fixtures__/rawEvents';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Helpers: build raw_events payload_json in the wire format used by
// AssistantEvent and UserEvent (claudeStream.ts).
// ---------------------------------------------------------------------------

function assistantTextPayload(id: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function assistantToolUsePayload(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: { cmd: 'ls' } }],
    },
  });
}

function assistantMixedPayload(id: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-4',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu-2', name: 'bash', input: { cmd: 'pwd' } },
        { type: 'text', text },
      ],
    },
  });
}

function userTextPayload(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

function userToolResultPayload(): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '/home/user\n', is_error: false }],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectRunMessages', () => {
  it('returns [] when raw_events is empty for the run', () => {
    const db = makeRawEventsDb();
    const adapter = dbAdapter(db);

    const result = selectRunMessages(adapter, 'run-empty');
    expect(result).toEqual([]);
  });

  it('returns user and assistant text ChatMessage[] in created_at ASC order', () => {
    const db = makeRawEventsDb();
    const adapter = dbAdapter(db);
    const runId = 'run-basic';

    // Insert in reverse order to confirm ORDER BY matters.
    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runId, 'assistant', assistantTextPayload('msg-asst-1', 'Hello from Claude'), '2026-01-01T00:00:02Z');

    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runId, 'user', userTextPayload('Hi there'), '2026-01-01T00:00:01Z');

    const result = selectRunMessages(adapter, runId);

    expect(result).toHaveLength(2);
    // Oldest first.
    expect(result[0].role).toBe('user');
    expect(result[0].text).toBe('Hi there');
    expect(result[0].runId).toBe(runId);
    expect(result[0].createdAt).toBe(new Date('2026-01-01T00:00:01Z').toISOString());

    expect(result[1].role).toBe('assistant');
    expect(result[1].text).toBe('Hello from Claude');
    expect(result[1].id).toBe('msg-asst-1'); // extracted from payload.message.id
    expect(result[1].runId).toBe(runId);
    expect(result[1].createdAt).toBe(new Date('2026-01-01T00:00:02Z').toISOString());
  });

  it('skips pure tool_use assistant events (no text block)', () => {
    const db = makeRawEventsDb();
    const adapter = dbAdapter(db);
    const runId = 'run-tool-use';

    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runId, 'assistant', assistantToolUsePayload('msg-tool'), '2026-01-01T00:00:01Z');

    const result = selectRunMessages(adapter, runId);
    expect(result).toEqual([]);
  });

  it('skips pure tool_result user events', () => {
    const db = makeRawEventsDb();
    const adapter = dbAdapter(db);
    const runId = 'run-tool-result';

    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runId, 'user', userToolResultPayload(), '2026-01-01T00:00:01Z');

    const result = selectRunMessages(adapter, runId);
    expect(result).toEqual([]);
  });

  it('extracts only text from a mixed (tool_use + text) assistant event', () => {
    const db = makeRawEventsDb();
    const adapter = dbAdapter(db);
    const runId = 'run-mixed';

    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runId, 'assistant', assistantMixedPayload('msg-mixed', 'I ran the command.'), '2026-01-01T00:00:01Z');

    const result = selectRunMessages(adapter, runId);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].text).toBe('I ran the command.');
  });

  it('only returns messages for the requested runId (isolation)', () => {
    const db = makeRawEventsDb();
    const adapter = dbAdapter(db);
    const runA = 'run-iso-a';
    const runB = 'run-iso-b';

    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runA, 'assistant', assistantTextPayload('msg-a', 'Message for run A'), '2026-01-01T00:00:01Z');

    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(runB, 'assistant', assistantTextPayload('msg-b', 'Message for run B'), '2026-01-01T00:00:02Z');

    const resultA = selectRunMessages(adapter, runA);
    expect(resultA).toHaveLength(1);
    expect(resultA[0].text).toBe('Message for run A');

    const resultB = selectRunMessages(adapter, runB);
    expect(resultB).toHaveLength(1);
    expect(resultB[0].text).toBe('Message for run B');
  });
});
