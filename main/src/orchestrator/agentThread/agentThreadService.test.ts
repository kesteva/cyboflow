import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentThreadDbStore } from './agentThreadDbStore';
import { AgentThreadEventsSink } from './agentThreadEventsSink';
import { getAgentSystemPrompt } from './agentThreadPrompt';
import {
  AgentThreadService,
  DIGEST_PROMPT,
  DIGEST_THROTTLE_MS,
  type AgentSpawnManagerLike,
  type AgentSpawnOptions,
} from './agentThreadService';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'database', 'migrations', '074_agent_threads.sql'),
  'utf-8',
);

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
  return db;
}

/**
 * Structural fake for ClaudeCodeManager's spawn/output slice. Each spawn consumes
 * the next queued behavior: 'init' emits a system/init 'output' event (with a
 * session id) synchronously then resolves; 'throw' rejects with a message. Default
 * (empty queue) emits an init with a generated id.
 */
type Behavior = { kind: 'init'; sessionId: string } | { kind: 'throw'; message: string };

class FakeManager implements AgentSpawnManagerLike {
  private readonly emitter = new EventEmitter();
  readonly calls: AgentSpawnOptions[] = [];
  private readonly behaviors: Behavior[] = [];

  queueInit(sessionId: string): void {
    this.behaviors.push({ kind: 'init', sessionId });
  }

  queueThrow(message: string): void {
    this.behaviors.push({ kind: 'throw', message });
  }

  async spawnCliProcess(options: AgentSpawnOptions): Promise<void> {
    this.calls.push(options);
    const behavior = this.behaviors.shift() ?? { kind: 'init', sessionId: `sess-${this.calls.length}` };
    if (behavior.kind === 'throw') {
      throw new Error(behavior.message);
    }
    // Emit the turn's system/init synchronously so the service's bridge captures
    // the session id before spawnCliProcess resolves (mirrors the real ordering:
    // spawnCliProcess awaits the turn, which has already streamed its init).
    this.emitter.emit('output', {
      panelId: options.panelId,
      sessionId: options.panelId,
      type: 'json',
      data: { type: 'system', subtype: 'init', session_id: behavior.sessionId },
      timestamp: new Date(),
    });
    // A follow-up non-init event to exercise the live-tail publish path.
    this.emitter.emit('output', {
      panelId: options.panelId,
      sessionId: options.panelId,
      type: 'json',
      data: { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
      timestamp: new Date(),
    });
  }

  on(event: 'output', listener: (payload: unknown) => void): unknown {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: 'output', listener: (payload: unknown) => void): unknown {
    this.emitter.off(event, listener);
    return this;
  }
}

interface Harness {
  db: Database.Database;
  store: AgentThreadDbStore;
  manager: FakeManager;
  service: AgentThreadService;
  published: Array<{ id: string; envelope: unknown }>;
  homeBase: string;
  clock: { value: number };
  /** Mutable enabled flag — flip `enabled.value` mid-test to exercise the kill switch. */
  enabled: { value: boolean };
}

function makeHarness(): Harness {
  const db = buildDb();
  const store = new AgentThreadDbStore(dbAdapter(db));
  const manager = new FakeManager();
  const published: Array<{ id: string; envelope: unknown }> = [];
  const homeBase = mkdtempSync(join(tmpdir(), 'agent-home-'));
  const clock = { value: 1_000_000 };
  const enabled = { value: true };
  const service = new AgentThreadService({
    store,
    manager,
    publish: (id, envelope) => published.push({ id, envelope }),
    defaultModel: () => 'claude-opus',
    enabled: () => enabled.value,
    homeDirBase: homeBase,
    now: () => clock.value,
  });
  return { db, store, manager, service, published, homeBase, clock, enabled };
}

describe('AgentThreadService', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.service.dispose();
    h.db.close();
    rmSync(h.homeBase, { recursive: true, force: true });
  });

  describe('ensureGlobalThread', () => {
    it('creates a global thread and its neutral home dir with a belt-and-braces settings file', () => {
      const thread = h.service.ensureGlobalThread();
      expect(thread.scope).toBe('global');

      const settingsPath = join(h.homeBase, thread.id, '.claude', 'settings.local.json');
      expect(existsSync(settingsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        permissions: { allow: string[] };
      };
      expect(parsed.permissions.allow).toContain('mcp__cyboflow__*');
    });

    it('is idempotent: a second call returns the same thread, no duplicate row', () => {
      const first = h.service.ensureGlobalThread();
      const second = h.service.ensureGlobalThread();
      expect(second.id).toBe(first.id);
      // Only one 'global' row exists.
      const count = h.db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get() as { n: number };
      expect(count.n).toBe(1);
      expect(existsSync(join(h.homeBase, first.id, '.claude', 'settings.local.json'))).toBe(true);
    });
  });

  describe('sendMessage', () => {
    it('throws on an unknown thread', async () => {
      await expect(h.service.sendMessage('nope', 'hi')).rejects.toThrow(/unknown thread/);
    });

    it('throws and never spawns when the global assistant kill switch is off', async () => {
      const thread = h.service.ensureGlobalThread();
      h.enabled.value = false;

      await expect(h.service.sendMessage(thread.id, 'hello')).rejects.toThrow(/disabled/);

      expect(h.manager.calls).toHaveLength(0);
    });

    it('turn 1 cold-spawns with the isolation contract and no resume; captures the session id', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');

      await h.service.sendMessage(thread.id, 'hello');

      expect(h.manager.calls).toHaveLength(1);
      const opts = h.manager.calls[0];
      expect(opts.panelId).toBe(`agent:${thread.id}`);
      expect(opts.sessionId).toBe(`agent:${thread.id}`);
      expect(opts.isolation).toBe('agent');
      expect(opts.tools).toEqual([]);
      expect(opts.mcpScope).toBe('global-agent');
      expect(opts.model).toBe('claude-opus');
      expect(opts.resumeSessionId).toBeUndefined();
      expect(opts.worktreePath).toBe(join(h.homeBase, thread.id));
      // S1.4: the global-agent system prompt is threaded as systemPromptAppend
      // on every spawn (the fingerprint-busting seam noted on the class doc).
      expect(opts.systemPromptAppend).toBe(getAgentSystemPrompt());

      // system-init capture persisted the id.
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-1');
    });

    it('warm continuation threads the stored session id as resumeSessionId on turn 2', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'first');

      // Warm continuation re-emits the SAME resumed session id.
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'second');

      expect(h.manager.calls).toHaveLength(2);
      expect(h.manager.calls[1].resumeSessionId).toBe('sess-1');
    });

    it('threads the system prompt into EVERY spawn call, warm continuation included', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'first');
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'second');

      expect(h.manager.calls).toHaveLength(2);
      for (const call of h.manager.calls) {
        expect(call.systemPromptAppend).toBe(getAgentSystemPrompt());
      }
    });

    it('passes the injected sink and performs zero appendEvent calls of its own', async () => {
      const appendSpy = vi.spyOn(h.store, 'appendEvent');
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');

      await h.service.sendMessage(thread.id, 'hello');

      const opts = h.manager.calls[0];
      expect(opts.eventsSink).toBeInstanceOf(AgentThreadEventsSink);
      // The sink is the single durable writer — the service never appends itself.
      expect(appendSpy).not.toHaveBeenCalled();
    });

    it('publishes live-tail envelopes to the thread id (not the spawn identity)', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'hello');

      expect(h.published.length).toBeGreaterThan(0);
      expect(h.published.every((p) => p.id === thread.id)).toBe(true);
    });

    it('recovers from a stale resume: clears the id, respawns fresh, persists the new id exactly once', async () => {
      const updateSpy = vi.spyOn(h.store, 'updateClaudeSessionId');
      const thread = h.service.ensureGlobalThread();

      // Turn 1 establishes a stored session id.
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'first');
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-1');

      // Turn 2: the stale --resume fails, then a fresh cold spawn captures sess-2.
      h.manager.queueThrow('No conversation found with session ID sess-1');
      h.manager.queueInit('sess-2');
      await h.service.sendMessage(thread.id, 'second');

      expect(h.manager.calls).toHaveLength(3);
      // The failed turn carried the stale resume; the fresh retry carried none.
      expect(h.manager.calls[1].resumeSessionId).toBe('sess-1');
      expect(h.manager.calls[2].resumeSessionId).toBeUndefined();
      // Stale id was cleared, then the new id captured.
      expect(updateSpy).toHaveBeenCalledWith(thread.id, null);
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-2');
      const newIdWrites = updateSpy.mock.calls.filter((c) => c[1] === 'sess-2');
      expect(newIdWrites).toHaveLength(1);
    });

    it('does NOT recover on a non-resume error: rethrows, keeps the stored id', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'first');

      h.manager.queueThrow('API Error: 401 unauthorized');
      await expect(h.service.sendMessage(thread.id, 'second')).rejects.toThrow(/401/);

      // Only the failed spawn — no fresh retry — and the id survives.
      expect(h.manager.calls).toHaveLength(2);
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-1');
    });
  });

  describe('triggerDigest', () => {
    it('first triggers, second within the window is throttled, and it fires again after the window', async () => {
      const thread = h.service.ensureGlobalThread();

      const first = await h.service.triggerDigest(thread.id);
      expect(first).toEqual({ triggered: true });
      expect(h.manager.calls).toHaveLength(1);
      expect(h.manager.calls[0].prompt).toBe(DIGEST_PROMPT);

      // Within the window — throttled, no new spawn.
      h.clock.value += DIGEST_THROTTLE_MS - 1;
      const second = await h.service.triggerDigest(thread.id);
      expect(second).toEqual({ triggered: false, reason: 'throttled' });
      expect(h.manager.calls).toHaveLength(1);

      // Past the window — triggers again.
      h.clock.value += 2;
      const third = await h.service.triggerDigest(thread.id);
      expect(third).toEqual({ triggered: true });
      expect(h.manager.calls).toHaveLength(2);
    });

    it('returns {triggered:false, reason:"disabled"} without sending or stamping the throttle when the kill switch is off, and sends once re-enabled', async () => {
      const thread = h.service.ensureGlobalThread();
      h.enabled.value = false;

      const result = await h.service.triggerDigest(thread.id);
      expect(result).toEqual({ triggered: false, reason: 'disabled' });
      expect(h.manager.calls).toHaveLength(0);

      // Re-enabling immediately (no elapsed clock) still sends — proof the
      // disabled call above did NOT stamp the throttle.
      h.enabled.value = true;
      const after = await h.service.triggerDigest(thread.id);
      expect(after).toEqual({ triggered: true });
      expect(h.manager.calls).toHaveLength(1);
      expect(h.manager.calls[0].prompt).toBe(DIGEST_PROMPT);
    });
  });
});
