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
  COMPACT_PROMPT,
  DIGEST_PROMPT,
  type AgentSpawnManagerLike,
  type AgentSpawnOptions,
} from './agentThreadService';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { AssistantContextRetention } from '../../../../shared/types/agentThread';

/** One local calendar day, in ms — advance the clock past it to re-fire the digest. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Base clock pinned to LOCAL noon of a fixed date. The digest cap keys off the
 * local calendar day, so the fixture must start mid-local-day: a base near local
 * midnight would flip calendar day under a small `+1h` advance on some machine
 * timezones, making the same-day-throttle assertion timezone-fragile. Local noon
 * + fixed advances (`+1h` stays same day, `+ONE_DAY_MS` lands next day) is
 * deterministic in every timezone.
 */
const LOCAL_NOON_BASE = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();

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
    join(__dirname, '..', '..', 'database', 'migrations', '078_agent_thread_last_turn.sql'),
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
  /** Mutable retention strategy — flip `retention.value` mid-test to exercise each mode. */
  retention: { value: AssistantContextRetention };
}

function makeHarness(): Harness {
  const db = buildDb();
  const store = new AgentThreadDbStore(dbAdapter(db));
  const manager = new FakeManager();
  const published: Array<{ id: string; envelope: unknown }> = [];
  const homeBase = mkdtempSync(join(tmpdir(), 'agent-home-'));
  const clock = { value: LOCAL_NOON_BASE };
  const enabled = { value: true };
  const retention = { value: 'clear-daily' as AssistantContextRetention };
  const service = new AgentThreadService({
    store,
    manager,
    publish: (id, envelope) => published.push({ id, envelope }),
    defaultModel: () => 'claude-opus',
    enabled: () => enabled.value,
    contextRetention: () => retention.value,
    homeDirBase: homeBase,
    now: () => clock.value,
  });
  return { db, store, manager, service, published, homeBase, clock, enabled, retention };
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

    it('passes the injected sink and routes its only write (the human turn) through it', async () => {
      const appendSpy = vi.spyOn(h.store, 'appendEvent');
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');

      await h.service.sendMessage(thread.id, 'hello');

      const opts = h.manager.calls[0];
      expect(opts.eventsSink).toBeInstanceOf(AgentThreadEventsSink);
      // The sink stays the single durable writer: the service never calls
      // appendEvent itself — the one row here is the user turn the SINK wrote.
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy.mock.calls[0][1]).toBe('user');
    });

    it('records + publishes the human turn as a user event BEFORE spawning', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');

      await h.service.sendMessage(thread.id, 'where are my sessions?');

      // Persisted: the SDK never echoes the prompt, so without this the person's
      // own message is missing from the reconstructed transcript entirely.
      const rows = h.store.listEvents(thread.id);
      expect(rows[0].eventType).toBe('user');
      expect(rows[0].payloadJson).toContain('where are my sessions?');

      // Published first, so it renders without waiting on the assistant's reply.
      const first = h.published[0].envelope as { type: string; payload: { type: string } };
      expect(first.type).toBe('user');
      expect(first.payload.type).toBe('user');
    });

    it('a turn that fails to spawn still leaves the human turn in the transcript', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueThrow('API Error: 401 unauthorized');

      await expect(h.service.sendMessage(thread.id, 'hello')).rejects.toThrow(/401/);

      expect(h.store.listEvents(thread.id).map((r) => r.eventType)).toEqual(['user']);
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
    it('does NOT record the synthetic digest prompt as a human turn', async () => {
      const thread = h.service.ensureGlobalThread();

      await h.service.triggerDigest(thread.id);

      // The digest is auto-fired (first open per launch); nobody typed
      // DIGEST_PROMPT, so attributing it to the user would be a false "You" bubble.
      expect(h.store.listEvents(thread.id).some((r) => r.eventType === 'user')).toBe(false);
    });

    it('first triggers, a later same-day call is capped, and it fires again the next day', async () => {
      const thread = h.service.ensureGlobalThread();

      const first = await h.service.triggerDigest(thread.id);
      expect(first).toEqual({ triggered: true });
      expect(h.manager.calls).toHaveLength(1);
      expect(h.manager.calls[0].prompt).toBe(DIGEST_PROMPT);

      // Later the SAME calendar day (e.g. a second boot an hour later) — capped,
      // no new spawn. This is the multi-boot case the persisted cap fixes.
      h.clock.value += 60 * 60 * 1000;
      const second = await h.service.triggerDigest(thread.id);
      expect(second).toEqual({ triggered: false, reason: 'throttled' });
      expect(h.manager.calls).toHaveLength(1);

      // Next calendar day — the daily recap fires again.
      h.clock.value += ONE_DAY_MS;
      const third = await h.service.triggerDigest(thread.id);
      expect(third).toEqual({ triggered: true });
      expect(h.manager.calls).toHaveLength(2);
    });

    it('persists the last-digest time so the cap survives a restart (new service, same store)', async () => {
      const thread = h.service.ensureGlobalThread();

      const first = await h.service.triggerDigest(thread.id);
      expect(first).toEqual({ triggered: true });
      expect(h.store.getLastDigestAt(thread.id)).toBe(h.clock.value);

      // Simulate an app restart: a fresh service over the SAME store (all
      // in-memory state gone). A launch-time digest an hour later the same day
      // must still be capped off the persisted value.
      const restartClock = { value: h.clock.value + 60 * 60 * 1000 };
      const restarted = new AgentThreadService({
        store: h.store,
        manager: h.manager,
        publish: () => {},
        defaultModel: () => 'claude-opus',
        enabled: () => true,
        homeDirBase: h.homeBase,
        now: () => restartClock.value,
      });

      const afterRestart = await restarted.triggerDigest(thread.id);
      expect(afterRestart).toEqual({ triggered: false, reason: 'throttled' });
      expect(h.manager.calls).toHaveLength(1);

      // The next calendar day, the restarted service digests again.
      restartClock.value = h.clock.value + ONE_DAY_MS;
      const nextDay = await restarted.triggerDigest(thread.id);
      expect(nextDay).toEqual({ triggered: true });
      expect(h.manager.calls).toHaveLength(2);
      restarted.dispose();
    });

    it('a failed send rolls back the stamp so the day stays retryable (not silently burned)', async () => {
      const thread = h.service.ensureGlobalThread();

      // First trigger's send throws (e.g. offline / auth failure at boot). No
      // resumeSessionId yet, so this is a clean throw, not a stale-resume retry.
      h.manager.queueThrow('spawn failed');
      await expect(h.service.triggerDigest(thread.id)).rejects.toThrow('spawn failed');
      // The speculative stamp must have been rolled back.
      expect(h.store.getLastDigestAt(thread.id)).toBeNull();

      // Same calendar day, next boot — the recap must still fire (the failure did
      // NOT consume the day's allowance). Default behavior sends successfully.
      const retry = await h.service.triggerDigest(thread.id);
      expect(retry).toEqual({ triggered: true });
      expect(h.manager.calls.at(-1)?.prompt).toBe(DIGEST_PROMPT);
      // Now it IS stamped, so a further same-day trigger is throttled.
      expect(h.store.getLastDigestAt(thread.id)).toBe(h.clock.value);
      const third = await h.service.triggerDigest(thread.id);
      expect(third).toEqual({ triggered: false, reason: 'throttled' });
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

  describe('daily context retention', () => {
    it('stamps last_turn_at on every turn (human and digest alike)', async () => {
      const thread = h.service.ensureGlobalThread();

      await h.service.sendMessage(thread.id, 'first');
      expect(h.store.getLastTurnAt(thread.id)).toBe(h.clock.value);

      h.clock.value += 60 * 60 * 1000;
      await h.service.triggerDigest(thread.id);
      expect(h.store.getLastTurnAt(thread.id)).toBe(h.clock.value);
    });

    it("clear-daily: same-day turns keep resuming; the next day's first turn drops the resume id and starts fresh, transcript intact", async () => {
      h.retention.value = 'clear-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one, first');
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one, second');
      expect(h.manager.calls[1].resumeSessionId).toBe('sess-1');

      // Next local day: the resume id is dropped BEFORE the turn — a fresh
      // conversation cold-spawns and its new id is captured.
      h.clock.value += ONE_DAY_MS;
      h.manager.queueInit('sess-2');
      await h.service.sendMessage(thread.id, 'day two');

      expect(h.manager.calls).toHaveLength(3);
      expect(h.manager.calls[2].prompt).toBe('day two');
      expect(h.manager.calls[2].resumeSessionId).toBeUndefined();
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-2');

      // The durable UI transcript is untouched: all three human turns remain.
      const userEvents = h.store.listEvents(thread.id).filter((r) => r.eventType === 'user');
      expect(userEvents).toHaveLength(3);
    });

    it('clear-daily applies to the auto-digest too: a new day’s recap starts a fresh conversation', async () => {
      h.retention.value = 'clear-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one chat');

      h.clock.value += ONE_DAY_MS;
      h.manager.queueInit('sess-2');
      await h.service.triggerDigest(thread.id);

      expect(h.manager.calls).toHaveLength(2);
      expect(h.manager.calls[1].prompt).toBe(DIGEST_PROMPT);
      expect(h.manager.calls[1].resumeSessionId).toBeUndefined();
    });

    it("compact-daily: the next day's first turn fires a /compact turn on the stored conversation, then the real turn resumes it", async () => {
      h.retention.value = 'compact-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one');

      h.clock.value += ONE_DAY_MS;
      // Compaction rewrites the transcript in place under the same session id.
      h.manager.queueInit('sess-1');
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day two');

      expect(h.manager.calls).toHaveLength(3);
      expect(h.manager.calls[1].prompt).toBe(COMPACT_PROMPT);
      expect(h.manager.calls[1].resumeSessionId).toBe('sess-1');
      expect(h.manager.calls[2].prompt).toBe('day two');
      expect(h.manager.calls[2].resumeSessionId).toBe('sess-1');

      // The synthetic /compact prompt is never attributed to the human.
      const userEvents = h.store.listEvents(thread.id).filter((r) => r.eventType === 'user');
      expect(userEvents.map((r) => JSON.parse(r.payloadJson) as { text?: string })).not.toContainEqual(
        expect.objectContaining({ text: COMPACT_PROMPT }),
      );

      // Same day, a further turn does NOT re-compact.
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day two, second');
      expect(h.manager.calls).toHaveLength(4);
      expect(h.manager.calls[3].prompt).toBe('day two, second');
    });

    it('compact-daily: a stale resume during the compact clears the id and the real turn cold-spawns fresh', async () => {
      h.retention.value = 'compact-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one');

      h.clock.value += ONE_DAY_MS;
      h.manager.queueThrow('No conversation found with session ID sess-1');
      h.manager.queueInit('sess-2');
      await h.service.sendMessage(thread.id, 'day two');

      expect(h.manager.calls).toHaveLength(3);
      expect(h.manager.calls[1].prompt).toBe(COMPACT_PROMPT);
      expect(h.manager.calls[2].prompt).toBe('day two');
      expect(h.manager.calls[2].resumeSessionId).toBeUndefined();
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-2');
    });

    it('compact-daily is fail-soft: a non-resume compact failure logs and the real turn proceeds uncompacted', async () => {
      h.retention.value = 'compact-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one');

      h.clock.value += ONE_DAY_MS;
      h.manager.queueThrow('API Error: 500 overloaded');
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day two');

      expect(h.manager.calls).toHaveLength(3);
      expect(h.manager.calls[2].prompt).toBe('day two');
      // The conversation survives — still resumed, just not compacted.
      expect(h.manager.calls[2].resumeSessionId).toBe('sess-1');
    });

    it('auto-compact: a new day changes nothing — the conversation just keeps resuming', async () => {
      h.retention.value = 'auto-compact';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one');

      h.clock.value += ONE_DAY_MS;
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day two');

      expect(h.manager.calls).toHaveLength(2);
      expect(h.manager.calls[1].resumeSessionId).toBe('sess-1');
    });

    it('upgrade path: a legacy thread with a stored conversation but NULL last_turn_at is treated as a new day', async () => {
      h.retention.value = 'clear-daily';
      const thread = h.service.ensureGlobalThread();
      // Simulate a pre-078 thread: a live conversation id, no last_turn_at.
      h.store.updateClaudeSessionId(thread.id, 'legacy-sess');
      expect(h.store.getLastTurnAt(thread.id)).toBeNull();

      h.manager.queueInit('sess-fresh');
      await h.service.sendMessage(thread.id, 'first turn after upgrade');

      expect(h.manager.calls).toHaveLength(1);
      expect(h.manager.calls[0].resumeSessionId).toBeUndefined();
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-fresh');
    });
  });
});
