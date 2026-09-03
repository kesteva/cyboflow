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
  type AgentSpawnManagerLike,
  type AgentSpawnOptions,
} from './agentThreadService';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type {
  AssistantContextRetention,
  AssistantRuntime,
} from '../../../../shared/types/agentThread';

/** One local calendar day, in ms — advance the clock past it to cross the retention day boundary. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Base clock pinned to LOCAL noon of a fixed date. The day-boundary retention
 * check keys off the local calendar day, so the fixture must start mid-local-day:
 * a base near local midnight would flip calendar day under a small `+1h` advance
 * on some machine timezones, making the same-day assertions timezone-fragile.
 * Local noon + fixed advances (`+1h` stays same day, `+ONE_DAY_MS` lands next
 * day) is deterministic in every timezone.
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
    join(__dirname, '..', '..', 'database', 'migrations', '080_agent_thread_last_turn.sql'),
    'utf-8',
  ) +
  '\n' +
  readFileSync(
    join(__dirname, '..', '..', 'database', 'migrations', '130_agent_thread_session_runtime.sql'),
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

  /**
   * Emit a bare system/init on this manager's 'output' stream WITHOUT a spawn —
   * used to prove a listener is (or is no longer) attached.
   */
  emitInit(panelId: string, sessionId: string): void {
    this.emitter.emit('output', {
      panelId,
      sessionId: panelId,
      type: 'json',
      data: { type: 'system', subtype: 'init', session_id: sessionId },
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
  /** The Claude manager — the default runtime, so most tests drive this one. */
  manager: FakeManager;
  /** The Codex manager, selected when `runtime.value` is 'codex-sdk'. */
  codexManager: FakeManager;
  service: AgentThreadService;
  published: Array<{ id: string; envelope: unknown }>;
  homeBase: string;
  clock: { value: number };
  /** Mutable enabled flag — flip `enabled.value` mid-test to exercise the kill switch. */
  enabled: { value: boolean };
  /** Mutable retention strategy — flip `retention.value` mid-test to exercise each mode. */
  retention: { value: AssistantContextRetention };
  /** Mutable assistant runtime — flip `runtime.value` mid-test to exercise a provider switch. */
  runtime: { value: AssistantRuntime };
  /** Per-runtime model resolution, mirroring ConfigManager.getAssistantModelFor. */
  models: Record<AssistantRuntime, string | null>;
}

function makeHarness(): Harness {
  const db = buildDb();
  const store = new AgentThreadDbStore(dbAdapter(db));
  const manager = new FakeManager();
  const codexManager = new FakeManager();
  const published: Array<{ id: string; envelope: unknown }> = [];
  const homeBase = mkdtempSync(join(tmpdir(), 'agent-home-'));
  const clock = { value: LOCAL_NOON_BASE };
  const enabled = { value: true };
  const retention = { value: 'clear-daily' as AssistantContextRetention };
  const runtime = { value: 'claude-sdk' as AssistantRuntime };
  const models: Record<AssistantRuntime, string | null> = {
    'claude-sdk': 'claude-opus',
    'codex-sdk': 'gpt-5.3-codex',
  };
  const service = new AgentThreadService({
    store,
    managers: { 'claude-sdk': manager, 'codex-sdk': codexManager },
    runtime: () => runtime.value,
    publish: (id, envelope) => published.push({ id, envelope }),
    defaultModel: (rt) => models[rt],
    enabled: () => enabled.value,
    contextRetention: () => retention.value,
    homeDirBase: homeBase,
    now: () => clock.value,
  });
  return {
    db,
    store,
    manager,
    codexManager,
    service,
    published,
    homeBase,
    clock,
    enabled,
    retention,
    runtime,
    models,
  };
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

    it('an optional contextHint is prepended to the spawned prompt but never persisted to the transcript', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');

      await h.service.sendMessage(thread.id, 'hello', 'HINT');

      expect(h.manager.calls).toHaveLength(1);
      expect(h.manager.calls[0].prompt).toBe('HINT\n\nhello');

      // The recorded transcript turn stores the RAW text only — no hint.
      const rows = h.store.listEvents(thread.id);
      const userRow = rows.find((r) => r.eventType === 'user');
      expect(userRow).toBeDefined();
      const persisted = JSON.parse(userRow!.payloadJson) as {
        message: { content: Array<{ type: string; text: string }> };
      };
      expect(persisted.message.content).toEqual([{ type: 'text', text: 'hello' }]);
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

    it('a turn that fails to spawn leaves the human turn AND a terminal error in the transcript', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueThrow('API Error: 401 unauthorized');

      await expect(h.service.sendMessage(thread.id, 'hello')).rejects.toThrow(/401/);

      // The rail has no dedicated error slot, so the failure has to reach the
      // transcript or the user sees their own message and then silence.
      const rows = h.store.listEvents(thread.id);
      expect(rows.map((r) => r.eventType)).toEqual(['user', 'result']);
      const persisted = JSON.parse(rows[1].payloadJson) as {
        subtype: string;
        is_error: boolean;
        result: string;
      };
      expect(persisted.subtype).toBe('error_during_execution');
      expect(persisted.is_error).toBe(true);
      expect(persisted.result).toContain('401');

      // Published too, so the LIVE rail updates without waiting on a refetch.
      const last = h.published[h.published.length - 1].envelope as { type: string };
      expect(last.type).toBe('result');
    });

    it('a stale-resume retry that ALSO fails surfaces the error event and still rejects', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'first');

      // The resume fails (recoverable), then the FRESH retry fails too.
      h.manager.queueThrow('No conversation found with session ID sess-1');
      h.manager.queueThrow('Claude Code is not installed');
      await expect(h.service.sendMessage(thread.id, 'second')).rejects.toThrow(/not installed/);

      const rows = h.store.listEvents(thread.id);
      // Exactly ONE error row — the recovered first failure is not surfaced.
      const errors = rows.filter((r) => r.eventType === 'result');
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0].payloadJson).result).toContain('not installed');
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

  describe('runtime selection', () => {
    it('spawns through the manager for the RESOLVED runtime, and never the other one', async () => {
      const thread = h.service.ensureGlobalThread();
      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');

      await h.service.sendMessage(thread.id, 'hello');

      expect(h.codexManager.calls).toHaveLength(1);
      expect(h.manager.calls).toHaveLength(0);
    });

    it('a Codex turn carries the full isolation contract plus the prompt-echo suppression', async () => {
      const thread = h.service.ensureGlobalThread();
      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');

      await h.service.sendMessage(thread.id, 'hello');

      const opts = h.codexManager.calls[0];
      expect(opts.isolation).toBe('agent');
      expect(opts.tools).toEqual([]);
      expect(opts.mcpScope).toBe('global-agent');
      expect(opts.eventsSink).toBeInstanceOf(AgentThreadEventsSink);
      // Codex's app-server echoes the input natively and the service already
      // recorded the human turn, so the echo must be suppressed — otherwise the
      // transcript double-renders the turn AND leaks any contextHint.
      expect(opts.hidePromptFromTranscript).toBe(true);
      // The model comes from the per-runtime resolver, not the Claude alias.
      expect(opts.model).toBe('gpt-5.3-codex');
    });

    it('a Claude turn leaves hidePromptFromTranscript unset (its manager suppresses its own echo)', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');

      await h.service.sendMessage(thread.id, 'hello');

      expect(h.manager.calls[0].hidePromptFromTranscript).toBeUndefined();
    });

    it('a null per-runtime model leaves the spawn model unset (the provider default)', async () => {
      const thread = h.service.ensureGlobalThread();
      h.runtime.value = 'codex-sdk';
      // A stale Claude alias floors to null in ConfigManager.getAssistantModelFor.
      h.models['codex-sdk'] = null;
      h.codexManager.queueInit('codex-thread-1');

      await h.service.sendMessage(thread.id, 'hello');

      expect(h.codexManager.calls[0].model).toBeUndefined();
    });

    it('captures the session id WITH the runtime it was minted under', async () => {
      const thread = h.service.ensureGlobalThread();
      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');

      await h.service.sendMessage(thread.id, 'hello');

      const stored = h.store.getThread(thread.id);
      expect(stored?.claudeSessionId).toBe('codex-thread-1');
      expect(stored?.sessionRuntime).toBe('codex-sdk');
    });

    it('a runtime switch clears the stored id, cold-starts on the new provider, and re-stamps the pair', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'on claude');
      expect(h.store.getThread(thread.id)?.sessionRuntime).toBe('claude-sdk');

      // The user switches the assistant to Codex in Settings.
      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'on codex');

      // A Claude session id must NEVER reach Codex's thread/resume.
      expect(h.codexManager.calls).toHaveLength(1);
      expect(h.codexManager.calls[0].resumeSessionId).toBeUndefined();
      const stored = h.store.getThread(thread.id);
      expect(stored?.claudeSessionId).toBe('codex-thread-1');
      expect(stored?.sessionRuntime).toBe('codex-sdk');

      // The durable transcript is untouched by the switch: both turns survive.
      const userEvents = h.store.listEvents(thread.id).filter((r) => r.eventType === 'user');
      expect(userEvents).toHaveLength(2);
    });

    it('switching BACK cold-starts again rather than resuming the Claude id still on file', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'on claude');

      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'on codex');

      h.runtime.value = 'claude-sdk';
      h.manager.queueInit('sess-2');
      await h.service.sendMessage(thread.id, 'back on claude');

      expect(h.manager.calls).toHaveLength(2);
      expect(h.manager.calls[1].resumeSessionId).toBeUndefined();
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-2');
      expect(h.store.getThread(thread.id)?.sessionRuntime).toBe('claude-sdk');
    });

    it('staying on one runtime still warm-resumes (the switch check is not a blanket clear)', async () => {
      const thread = h.service.ensureGlobalThread();
      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'first');
      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'second');

      expect(h.codexManager.calls[1].resumeSessionId).toBe('codex-thread-1');
    });

    it('a legacy thread with an id but NO recorded runtime resumes rather than cold-starting', async () => {
      const thread = h.service.ensureGlobalThread();
      // Exactly the pre-130 shape: an id captured before the column existed.
      h.db
        .prepare('UPDATE agent_threads SET claude_session_id = ? WHERE id = ?')
        .run('legacy-sess', thread.id);
      // Keep the day-boundary from clearing it, so the resume is what is tested.
      h.store.setLastTurnAt(thread.id, h.clock.value);
      expect(h.store.getThread(thread.id)?.sessionRuntime).toBeNull();

      h.manager.queueInit('legacy-sess');
      await h.service.sendMessage(thread.id, 'hello');

      expect(h.manager.calls[0].resumeSessionId).toBe('legacy-sess');
    });

    it('a legacy id with NO recorded runtime is a CLAUDE id: the first Codex turn cold-starts', async () => {
      const thread = h.service.ensureGlobalThread();
      h.db
        .prepare('UPDATE agent_threads SET claude_session_id = ? WHERE id = ?')
        .run('legacy-sess', thread.id);
      h.store.setLastTurnAt(thread.id, h.clock.value);

      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'hello');

      expect(h.codexManager.calls).toHaveLength(1);
      expect(h.codexManager.calls[0].resumeSessionId).toBeUndefined();
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('codex-thread-1');
      expect(h.store.getThread(thread.id)?.sessionRuntime).toBe('codex-sdk');
    });

    it('bridges BOTH managers, so a turn on either provider live-tails and captures', async () => {
      const thread = h.service.ensureGlobalThread();
      // First turn attaches the bridges — on Claude only, historically.
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'on claude');
      const afterClaude = h.published.length;

      // Without a Codex-side bridge this turn would publish nothing and capture
      // no id, leaving every following turn cold-starting.
      h.runtime.value = 'codex-sdk';
      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'on codex');

      expect(h.published.length).toBeGreaterThan(afterClaude + 1);
      expect(h.published.every((p) => p.id === thread.id)).toBe(true);
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('codex-thread-1');
    });

    it('dispose detaches BOTH managers listeners', async () => {
      const thread = h.service.ensureGlobalThread();
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'hello');

      h.service.dispose();
      const before = h.published.length;

      // Emitting on either manager after dispose must publish nothing.
      h.manager.emitInit(`agent:${thread.id}`, 'ghost-claude');
      h.codexManager.emitInit(`agent:${thread.id}`, 'ghost-codex');

      expect(h.published.length).toBe(before);
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('sess-1');
    });
  });

  describe('daily context retention', () => {
    it('stamps last_turn_at on every turn', async () => {
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'first');
      expect(h.store.getLastTurnAt(thread.id)).toBe(h.clock.value);

      h.clock.value += 60 * 60 * 1000;
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'second');
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

    it('clear-daily: a new day’s turn starts a fresh conversation with no resume id', async () => {
      h.retention.value = 'clear-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one chat');

      h.clock.value += ONE_DAY_MS;
      h.manager.queueInit('sess-2');
      await h.service.sendMessage(thread.id, 'day two chat');

      expect(h.manager.calls).toHaveLength(2);
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

    it('compact-daily degrades to clear-daily on Codex: no /compact turn, the day starts fresh', async () => {
      h.retention.value = 'compact-daily';
      h.runtime.value = 'codex-sdk';
      const thread = h.service.ensureGlobalThread();

      h.codexManager.queueInit('codex-thread-1');
      await h.service.sendMessage(thread.id, 'day one');

      h.clock.value += ONE_DAY_MS;
      h.codexManager.queueInit('codex-thread-2');
      await h.service.sendMessage(thread.id, 'day two');

      // Only the two real turns — Codex's app-server has no compaction RPC, and
      // '/compact' sent as prompt text would land as a literal user message.
      expect(h.codexManager.calls).toHaveLength(2);
      expect(h.codexManager.calls.map((c) => c.prompt)).toEqual(['day one', 'day two']);
      // The user's intent (do not carry yesterday's context) is still honoured.
      expect(h.codexManager.calls[1].resumeSessionId).toBeUndefined();
      expect(h.store.getThread(thread.id)?.claudeSessionId).toBe('codex-thread-2');
    });

    it('compact-daily still fires the /compact turn on Claude (the degrade is Codex-only)', async () => {
      h.retention.value = 'compact-daily';
      const thread = h.service.ensureGlobalThread();

      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day one');

      h.clock.value += ONE_DAY_MS;
      h.manager.queueInit('sess-1');
      h.manager.queueInit('sess-1');
      await h.service.sendMessage(thread.id, 'day two');

      expect(h.manager.calls.map((c) => c.prompt)).toEqual([
        'day one',
        COMPACT_PROMPT,
        'day two',
      ]);
    });

    it('upgrade path: a legacy thread with a stored conversation but NULL last_turn_at is treated as a new day', async () => {
      h.retention.value = 'clear-daily';
      const thread = h.service.ensureGlobalThread();
      // Simulate a pre-080 thread: a live conversation id, no last_turn_at.
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
