import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventRouter } from '../../../../shared/streamParser/eventRouter';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { AgentStreamEvent } from '../../../../shared/types/agentStream';
import { AgentThreadDbStore } from './agentThreadDbStore';
import {
  AgentThreadEventsSink,
  agentSpawnIdentity,
  threadIdFromSpawnIdentity,
} from './agentThreadEventsSink';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

const MIGRATION =
  readFileSync(
    join(__dirname, '..', '..', 'database', 'migrations', '074_agent_threads.sql'),
    'utf-8',
  ) +
  '\n' +
  readFileSync(
    join(__dirname, '..', '..', 'database', 'migrations', '076_agent_thread_last_digest.sql'),
    'utf-8',
  ) +
  '\n' +
  readFileSync(
    join(__dirname, '..', '..', 'database', 'migrations', '131_agent_thread_session_runtime.sql'),
    'utf-8',
  );

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
  return db;
}

/** Cast an arbitrary wire object into the router's event type (sink is shape-tolerant). */
function evt(obj: Record<string, unknown>): ClaudeStreamEvent {
  return obj as unknown as ClaudeStreamEvent;
}

describe('agentSpawnIdentity / threadIdFromSpawnIdentity', () => {
  it('round-trips a threadId through the spawn identity', () => {
    expect(agentSpawnIdentity('thread-1')).toBe('agent:thread-1');
    expect(threadIdFromSpawnIdentity('agent:thread-1')).toBe('thread-1');
  });

  it('returns a prefix-less id unchanged (defensive)', () => {
    expect(threadIdFromSpawnIdentity('thread-1')).toBe('thread-1');
  });
});

describe('AgentThreadEventsSink', () => {
  let db: Database.Database;
  let store: AgentThreadDbStore;

  beforeEach(() => {
    db = buildDb();
    store = new AgentThreadDbStore(dbAdapter(db));
    store.createThread({ id: 'thread-1' });
  });

  afterEach(() => {
    db.close();
  });

  it('maps agent:<id> events to bare-id rows and derives the event type', () => {
    const sink = new AgentThreadEventsSink(store);
    const router = new EventRouter();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));

    const assistant = evt({ type: 'assistant', message: { role: 'assistant', content: 'hi' } });
    const result = evt({ type: 'result', subtype: 'success' });
    router.emitForRun('agent:thread-1', assistant);
    router.emitForRun('agent:thread-1', result);

    const rows = store.listEvents('thread-1');
    expect(rows.map((r) => r.eventType)).toEqual(['assistant', 'result']);
    expect(rows[0].payloadJson).toBe(JSON.stringify(assistant));
    expect(rows[0].threadId).toBe('thread-1');
  });

  it('normalizes an unknown (typeless) event shape to event_type "unknown", stored raw', () => {
    const sink = new AgentThreadEventsSink(store);
    const router = new EventRouter();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));

    const weird = evt({ kind: '__unknown__', blob: { a: 1 } });
    router.emitForRun('agent:thread-1', weird);

    const rows = store.listEvents('thread-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('unknown');
    expect(rows[0].payloadJson).toBe(JSON.stringify(weird));
  });

  it('re-attach for the same runId does not double-write', () => {
    const sink = new AgentThreadEventsSink(store);
    const router = new EventRouter();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));
    // Cold RESPAWN reuses the same sink with a fresh router for the same runId.
    const router2 = new EventRouter();
    sink.attachToRouter(router2, agentSpawnIdentity('thread-1'));

    router.emitForRun('agent:thread-1', evt({ type: 'assistant' }));
    router2.emitForRun('agent:thread-1', evt({ type: 'result' }));

    // The first router was detached on re-attach — only the router2 event lands.
    expect(store.listEvents('thread-1').map((r) => r.eventType)).toEqual(['result']);
  });

  it('is fail-soft on a store error: warns with the thread id and never throws', () => {
    const warn = vi.fn();
    const sink = new AgentThreadEventsSink(store, {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    });
    const router = new EventRouter();
    // 'ghost' has no agent_threads row → the FK'd INSERT throws inside the sink.
    sink.attachToRouter(router, agentSpawnIdentity('ghost'));

    expect(() => router.emitForRun('agent:ghost', evt({ type: 'assistant' }))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ghost');
    expect(store.listEvents('ghost')).toHaveLength(0);
  });

  it('scopes two threads independently on one router', () => {
    store.createThread({ id: 'thread-2' });
    const sink = new AgentThreadEventsSink(store);
    const router = new EventRouter();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));
    sink.attachToRouter(router, agentSpawnIdentity('thread-2'));

    router.emitForRun('agent:thread-1', evt({ type: 'assistant' }));
    router.emitForRun('agent:thread-2', evt({ type: 'result' }));

    expect(store.listEvents('thread-1').map((r) => r.eventType)).toEqual(['assistant']);
    expect(store.listEvents('thread-2').map((r) => r.eventType)).toEqual(['result']);
  });

  it('dispose(runId) stops persistence for that run', () => {
    const sink = new AgentThreadEventsSink(store);
    const router = new EventRouter();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));

    router.emitForRun('agent:thread-1', evt({ type: 'assistant' }));
    sink.dispose('agent:thread-1');
    router.emitForRun('agent:thread-1', evt({ type: 'result' }));

    expect(store.listEvents('thread-1').map((r) => r.eventType)).toEqual(['assistant']);
  });

  it('dispose() with no arg tears down all runs', () => {
    store.createThread({ id: 'thread-2' });
    const sink = new AgentThreadEventsSink(store);
    const router = new EventRouter();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));
    sink.attachToRouter(router, agentSpawnIdentity('thread-2'));

    sink.dispose();
    router.emitForRun('agent:thread-1', evt({ type: 'assistant' }));
    router.emitForRun('agent:thread-2', evt({ type: 'result' }));

    expect(store.listEvents('thread-1')).toHaveLength(0);
    expect(store.listEvents('thread-2')).toHaveLength(0);
  });

  it('persists Codex agent_* events VERBATIM under their agent_* persisted types', () => {
    const sink = new AgentThreadEventsSink(store);
    // The Codex app-server substrate routes the provider-neutral shape, so the
    // ONE injected sink has to serve an EventRouter<AgentStreamEvent> too.
    const router = new EventRouter<AgentStreamEvent>();
    sink.attachToRouter(router, agentSpawnIdentity('thread-1'));

    const init: AgentStreamEvent = {
      type: 'agent_init',
      provider: 'codex',
      external_session_id: 'codex-thread-9',
      cwd: '/tmp/agent-home',
      model: 'gpt-5.3-codex',
      tools: [],
      mcp_servers: [],
      permission_mode: 'never',
    };
    const message: AgentStreamEvent = {
      type: 'agent_message',
      provider: 'codex',
      role: 'assistant',
      id: 'msg-1',
      model: 'gpt-5.3-codex',
      content: [{ type: 'text', text: 'here are your sessions' }],
    };
    router.emitForRun('agent:thread-1', init);
    router.emitForRun('agent:thread-1', message);

    const rows = store.listEvents('thread-1');
    // agent_* keeps its OWN persisted namespace — storage never implies a Codex
    // event came from Claude (derivePersistedEventType).
    expect(rows.map((r) => r.eventType)).toEqual(['agent_system', 'agent_assistant']);
    // Verbatim: the listing projection converts the agent_* payload on READ, so
    // the sink must not normalize the shape on the way in.
    expect(rows[0].payloadJson).toBe(JSON.stringify(init));
    expect(rows[1].payloadJson).toBe(JSON.stringify(message));
    expect(rows[0].threadId).toBe('thread-1');
  });

  it('recordAssistantError persists a terminal error result the transcript can render', () => {
    const sink = new AgentThreadEventsSink(store);
    const event = sink.recordAssistantError('thread-1', 'Codex is not installed');

    const rows = store.listEvents('thread-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('result');
    const persisted = JSON.parse(rows[0].payloadJson) as {
      type: string;
      subtype: string;
      is_error: boolean;
      result: string;
    };
    expect(persisted.type).toBe('result');
    expect(persisted.subtype).toBe('error_during_execution');
    expect(persisted.is_error).toBe(true);
    expect(persisted.result).toBe('Codex is not installed');
    expect(event).toEqual(persisted);
  });

  it('recordAssistantError is fail-soft: an unknown thread warns instead of throwing', () => {
    const warn = vi.fn();
    const sink = new AgentThreadEventsSink(store, {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    });
    // It must never throw OVER the original spawn failure the caller rethrows.
    expect(() => sink.recordAssistantError('ghost', 'boom')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('recordUserTurn persists the human turn as a projectable user-text event', () => {
    const sink = new AgentThreadEventsSink(store);
    // No router attach — the human's turn is written directly, not off the stream.
    const event = sink.recordUserTurn('thread-1', 'where are my sessions?');

    const rows = store.listEvents('thread-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('user');
    const persisted = JSON.parse(rows[0].payloadJson) as {
      type: string;
      parent_tool_use_id: string | null;
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(persisted.type).toBe('user');
    // Parentless — MessageProjection only renders top-level user events as turns.
    expect(persisted.parent_tool_use_id).toBeNull();
    expect(persisted.message.content).toEqual([
      { type: 'text', text: 'where are my sessions?' },
    ]);
    expect(event).toEqual(persisted);
  });
});
