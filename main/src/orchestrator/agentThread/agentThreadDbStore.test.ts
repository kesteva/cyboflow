import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentThreadDbStore } from './agentThreadDbStore';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type {
  EditWorkflowProposalPayload,
  LaunchRunProposalPayload,
  OpenSessionProposalPayload,
  ReprioritizeBacklogProposalPayload,
} from '../../../../shared/types/agentThread';

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
    join(__dirname, '..', '..', 'database', 'migrations', '080_agent_thread_last_turn.sql'),
    'utf-8',
  );

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
  return db;
}

describe('AgentThreadDbStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('threads', () => {
    it('creates and reads back a thread with defaults', () => {
      const store = new AgentThreadDbStore(dbAdapter(db), () => 'thread-1');
      const created = store.createThread();
      expect(created.id).toBe('thread-1');
      expect(created.scope).toBe('global');
      expect(created.model).toBeNull();
      expect(created.claudeSessionId).toBeNull();
      expect(typeof created.createdAt).toBe('string');
      expect(typeof created.updatedAt).toBe('string');

      const fetched = store.getThread('thread-1');
      expect(fetched).toEqual(created);
    });

    it('returns null for a missing thread', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      expect(store.getThread('nope')).toBeNull();
    });

    it('honors an explicit id and model on create', () => {
      const store = new AgentThreadDbStore(dbAdapter(db), () => 'unused');
      const created = store.createThread({ id: 'explicit-id', model: 'claude-opus' });
      expect(created.id).toBe('explicit-id');
      expect(created.model).toBe('claude-opus');
    });

    it('findLatestThreadByScope returns the newest thread for that scope', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'older' });
      // Force distinct created_at ordering since CURRENT_TIMESTAMP is second-granular.
      db.prepare("UPDATE agent_threads SET created_at = '2020-01-01 00:00:00' WHERE id = 'older'").run();
      store.createThread({ id: 'newer' });

      const latest = store.findLatestThreadByScope('global');
      expect(latest?.id).toBe('newer');
    });

    it('updateClaudeSessionId returns true on hit, false on missing id, and round-trips including back to null', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'thread-1' });

      expect(store.updateClaudeSessionId('missing', 'sess-1')).toBe(false);
      expect(store.updateClaudeSessionId('thread-1', 'sess-1')).toBe(true);
      expect(store.getThread('thread-1')?.claudeSessionId).toBe('sess-1');

      expect(store.updateClaudeSessionId('thread-1', null)).toBe(true);
      expect(store.getThread('thread-1')?.claudeSessionId).toBeNull();
    });

    it('last_digest_at defaults to null and round-trips through set/get (migration 076)', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'thread-1' });

      // Never digested → null. A missing thread also reads null (no row).
      expect(store.getLastDigestAt('thread-1')).toBeNull();
      expect(store.getLastDigestAt('missing')).toBeNull();

      store.setLastDigestAt('thread-1', 1_700_000_000_000);
      expect(store.getLastDigestAt('thread-1')).toBe(1_700_000_000_000);

      // A later stamp overwrites.
      store.setLastDigestAt('thread-1', 1_700_000_500_000);
      expect(store.getLastDigestAt('thread-1')).toBe(1_700_000_500_000);

      // null restores/clears it — the rollback path when a recap send fails.
      store.setLastDigestAt('thread-1', null);
      expect(store.getLastDigestAt('thread-1')).toBeNull();
    });

    it('last_turn_at defaults to null and round-trips through set/get (migration 080)', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'thread-1' });

      // No turn recorded since the column shipped → null ("new day" to the
      // service). A missing thread also reads null (no row).
      expect(store.getLastTurnAt('thread-1')).toBeNull();
      expect(store.getLastTurnAt('missing')).toBeNull();

      store.setLastTurnAt('thread-1', 1_700_000_000_000);
      expect(store.getLastTurnAt('thread-1')).toBe(1_700_000_000_000);

      // A later stamp overwrites — the column always reflects the newest turn.
      store.setLastTurnAt('thread-1', 1_700_000_500_000);
      expect(store.getLastTurnAt('thread-1')).toBe(1_700_000_500_000);
    });
  });

  describe('events', () => {
    it('appends events with increasing ids and lists them in order', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'thread-1' });

      const id1 = store.appendEvent('thread-1', 'message', '{"n":1}');
      const id2 = store.appendEvent('thread-1', 'message', '{"n":2}');
      const id3 = store.appendEvent('thread-1', 'message', '{"n":3}');
      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);

      const all = store.listEvents('thread-1');
      expect(all.map((e) => e.payloadJson)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
      expect(all[0]).toMatchObject({ threadId: 'thread-1', eventType: 'message' });
    });

    it('afterId is strictly-greater and limit caps the page', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'thread-1' });
      const id1 = store.appendEvent('thread-1', 'message', '{"n":1}');
      store.appendEvent('thread-1', 'message', '{"n":2}');
      store.appendEvent('thread-1', 'message', '{"n":3}');

      const afterFirst = store.listEvents('thread-1', { afterId: id1 });
      expect(afterFirst.map((e) => e.payloadJson)).toEqual(['{"n":2}', '{"n":3}']);

      const limited = store.listEvents('thread-1', { limit: 1 });
      expect(limited.map((e) => e.payloadJson)).toEqual(['{"n":1}']);
    });

    it('scopes events to their thread', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      store.createThread({ id: 'thread-1' });
      store.createThread({ id: 'thread-2' });
      store.appendEvent('thread-1', 'message', '{"t":1}');
      store.appendEvent('thread-2', 'message', '{"t":2}');

      expect(store.listEvents('thread-1').map((e) => e.payloadJson)).toEqual(['{"t":1}']);
      expect(store.listEvents('thread-2').map((e) => e.payloadJson)).toEqual(['{"t":2}']);
    });
  });

  describe('proposals', () => {
    function seedThread(store: AgentThreadDbStore, id = 'thread-1'): void {
      store.createThread({ id });
    }

    it('round-trips a launch-run payload', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      const payload: LaunchRunProposalPayload = {
        kind: 'launch-run',
        projectId: 7,
        workflowName: 'sprint',
        substrate: 'sdk',
        taskIds: ['TASK-1'],
        note: 'go',
      };
      const created = store.createProposal({ id: 'p1', threadId: 'thread-1', payload });
      expect(created.kind).toBe('launch-run');
      expect(created.payload).toEqual(payload);
      expect(created.preconditions).toBeNull();
      expect(created.status).toBe('proposed');
      expect(created.result).toBeNull();
      expect(created.idempotencyKey).toBeNull();
      expect(created.decidedAt).toBeNull();

      expect(store.getProposal('p1')).toEqual(created);
    });

    it('round-trips a reprioritize-backlog payload with preconditions', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      const payload: ReprioritizeBacklogProposalPayload = {
        kind: 'reprioritize-backlog',
        projectId: 7,
        items: [{ taskId: 'TASK-1', priority: 'P0' }, { taskId: 'TASK-2', stageId: 'in-progress' }],
      };
      const created = store.createProposal({
        id: 'p2',
        threadId: 'thread-1',
        payload,
        preconditions: { kind: 'reprioritize-backlog', expectedVersions: { 'TASK-1': 3, 'TASK-2': 1 } },
      });
      expect(created.payload).toEqual(payload);
      expect(created.preconditions).toEqual({
        kind: 'reprioritize-backlog',
        expectedVersions: { 'TASK-1': 3, 'TASK-2': 1 },
      });
      expect(store.getProposal('p2')).toEqual(created);
    });

    it('round-trips an edit-workflow payload with preconditions', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      const payload: EditWorkflowProposalPayload = {
        kind: 'edit-workflow',
        workflowId: 'wf-1',
        definitionJson: '{"steps":[]}',
        summary: 'tweak step order',
      };
      const created = store.createProposal({
        id: 'p3',
        threadId: 'thread-1',
        payload,
        preconditions: { kind: 'edit-workflow', specHash: 'abc123' },
      });
      expect(created.payload).toEqual(payload);
      expect(created.preconditions).toEqual({ kind: 'edit-workflow', specHash: 'abc123' });
      expect(store.getProposal('p3')).toEqual(created);
    });

    it('round-trips an open-session payload', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      const payload: OpenSessionProposalPayload = {
        kind: 'open-session',
        navigation: { target: 'quick-session', sessionId: 'sess-1' },
      };
      const created = store.createProposal({ id: 'p4', threadId: 'thread-1', payload });
      expect(created.payload).toEqual(payload);
      expect(store.getProposal('p4')).toEqual(created);
    });

    it('returns null for a missing proposal', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      expect(store.getProposal('nope')).toBeNull();
    });

    it('listProposals orders by creation and can filter by status', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      store.createProposal({
        id: 'p1',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });
      store.createProposal({
        id: 'p2',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'planner' },
      });
      store.claimProposal('p2', 'idem-1');

      expect(store.listProposals('thread-1').map((p) => p.id)).toEqual(['p1', 'p2']);
      expect(store.listProposals('thread-1', { statuses: ['executing'] }).map((p) => p.id)).toEqual(['p2']);
    });

    it('claimProposal: first claim wins, second claim loses and does not overwrite the winner', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      store.createProposal({
        id: 'p1',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });

      expect(store.claimProposal('p1', 'idem-winner')).toBe(true);
      const claimed = store.getProposal('p1');
      expect(claimed?.status).toBe('executing');
      expect(claimed?.idempotencyKey).toBe('idem-winner');

      expect(store.claimProposal('p1', 'idem-loser')).toBe(false);
      const afterLoser = store.getProposal('p1');
      expect(afterLoser?.status).toBe('executing');
      expect(afterLoser?.idempotencyKey).toBe('idem-winner');
    });

    it('finalizeProposal requires executing status and sets result + decidedAt', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      store.createProposal({
        id: 'p1',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });

      expect(store.finalizeProposal('p1', 'executed', '{"ok":true}')).toBe(false);

      store.claimProposal('p1', 'idem-1');
      expect(store.finalizeProposal('p1', 'executed', '{"ok":true}')).toBe(true);
      const finalized = store.getProposal('p1');
      expect(finalized?.status).toBe('executed');
      expect(finalized?.result).toEqual({ ok: true });
      expect(finalized?.decidedAt).not.toBeNull();

      expect(store.finalizeProposal('p1', 'executed', '{"ok":true}')).toBe(false);
    });

    it('finalizeProposal can transition to failed', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      store.createProposal({
        id: 'p1',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });
      store.claimProposal('p1', 'idem-1');

      expect(store.finalizeProposal('p1', 'failed', '{"error":"boom"}')).toBe(true);
      const failed = store.getProposal('p1');
      expect(failed?.status).toBe('failed');
      expect(failed?.result).toEqual({ error: 'boom' });
    });

    it('dismissProposal only succeeds from proposed', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      store.createProposal({
        id: 'p1',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });

      expect(store.dismissProposal('p1')).toBe(true);
      expect(store.getProposal('p1')?.status).toBe('dismissed');

      store.createProposal({
        id: 'p2',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });
      store.claimProposal('p2', 'idem-1');
      expect(store.dismissProposal('p2')).toBe(false);
      expect(store.getProposal('p2')?.status).toBe('executing');
    });

    it('supersedeProposal succeeds from proposed or executing, fails from terminal states', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);

      store.createProposal({
        id: 'p1',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });
      expect(store.supersedeProposal('p1')).toBe(true);
      expect(store.getProposal('p1')?.status).toBe('superseded');

      store.createProposal({
        id: 'p2',
        threadId: 'thread-1',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });
      store.claimProposal('p2', 'idem-1');
      expect(store.supersedeProposal('p2', '{"reason":"replaced"}')).toBe(true);
      const superseded = store.getProposal('p2');
      expect(superseded?.status).toBe('superseded');
      expect(superseded?.result).toEqual({ reason: 'replaced' });

      // Already terminal: a second supersede must fail.
      expect(store.supersedeProposal('p1')).toBe(false);
      expect(store.supersedeProposal('p2')).toBe(false);
    });

    it('listProposalsByStatus finds executing rows across different threads', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store, 'thread-a');
      seedThread(store, 'thread-b');
      store.createProposal({
        id: 'p1',
        threadId: 'thread-a',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'sprint' },
      });
      store.createProposal({
        id: 'p2',
        threadId: 'thread-b',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'planner' },
      });
      store.createProposal({
        id: 'p3',
        threadId: 'thread-a',
        payload: { kind: 'launch-run', projectId: 1, workflowName: 'ship' },
      });
      store.claimProposal('p1', 'idem-1');
      store.claimProposal('p2', 'idem-2');

      const executing = store.listProposalsByStatus('executing');
      expect(executing.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('getProposal throws an Error naming the proposal id on corrupt payload_json', () => {
      const store = new AgentThreadDbStore(dbAdapter(db));
      seedThread(store);
      db.prepare(
        `INSERT INTO agent_proposals (id, thread_id, kind, payload_json)
         VALUES ('corrupt-1', 'thread-1', 'launch-run', 'not json')`,
      ).run();

      expect(() => store.getProposal('corrupt-1')).toThrow(/corrupt-1/);
    });
  });
});
