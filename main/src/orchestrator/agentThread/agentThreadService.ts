/**
 * AgentThreadService — the hosting service for the global-agent chat thread.
 *
 * Mints/loads the single 'global' thread, prepares its neutral home dir, and
 * drives turns through {@link AgentSpawnManagerLike} (the narrow slice of
 * ClaudeCodeManager it needs) with the S0.2 global-agent spawn contract:
 *   - synthetic identity  panelId === sessionId === `agent:<threadId>` (no runId,
 *     no spawnKey → warm-eligible), neutral cwd = the thread's home dir;
 *   - `isolation: 'agent'` (hermetic — no inherited MCP/plugins/rules),
 *     `tools: []` (no built-ins), `mcpScope: 'global-agent'`;
 *   - an injected {@link AgentThreadEventsSink} as the SINGLE durable writer for
 *     the transcript (the built-in RawEventsSink attach is suppressed).
 *
 * Warm reuse requires the captured `claude_session_id` threaded back as
 * `resumeSessionId` on EVERY continuation turn (evaluateWarmReuse's workflow-resume
 * arm — the SessionManager-panel path a synthetic panel can't satisfy). The
 * manager's own capture writes to `workflow_runs` (no row for a run-less thread),
 * so this service captures the id itself off the live 'output' stream. A stale
 * `--resume` (the stored conversation no longer exists) is recovered ONCE: clear
 * the id, cold-spawn fresh, re-capture.
 *
 * The event bridge is live-tail ONLY — it publishes envelopes for the renderer and
 * captures the session id; it NEVER appends events (single-writer contract: the
 * sink owns durability).
 *
 * Every spawn also threads {@link getAgentSystemPrompt} (S1.4) as
 * `systemPromptAppend` — the role, the promptable contract, tool guidance,
 * digest format, and proposal-quality bar. `computeOptionsFingerprint`
 * (claudeCodeManager.ts) hashes the full composed `systemPrompt` object, so an
 * edit to `agentThreadPrompt.ts` changes the append text on the next turn and
 * correctly busts the warm persistent SDK process rather than reusing a
 * process spawned under the old prompt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentThread } from '../../../../shared/types/agentThread';
import type { ClaudeSpawnOptions } from '../../services/panels/claude/claudeCodeManager';
import type { LoggerLike } from '../types';
import type { AgentThreadDbStore } from './agentThreadDbStore';
import { AgentThreadEventsSink, agentSpawnIdentity } from './agentThreadEventsSink';
import { getAgentSystemPrompt } from './agentThreadPrompt';

// ---------------------------------------------------------------------------
// Digest trigger prompt
// ---------------------------------------------------------------------------

/**
 * Synthetic turn text sent for a digest request. Deliberately just a short,
 * plain ask — the actual digest FORMAT (grouping, ordering, "Needs your
 * attention" shortlist) lives in {@link getAgentSystemPrompt}'s system-prompt
 * append (S1.4), not in this per-turn text, so it stays in effect no matter
 * how the digest is triggered (this synthetic prompt, or the human just
 * asking "where is everything?" themselves).
 */
export const DIGEST_PROMPT =
  'Give me a concise digest of where all sessions/runs are and what needs my attention.';

/** Server-side digest throttle: at most one synthetic digest per thread per window. */
export const DIGEST_THROTTLE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Narrow manager slice + spawn options
// ---------------------------------------------------------------------------

/**
 * The subset of the global-agent spawn contract this service passes. Defined as
 * a `Pick<>` of the manager's exported {@link ClaudeSpawnOptions} (S0.6 parity
 * fix) rather than a hand-copied structural mirror, so a field-type drift on the
 * manager side FAILS THE BUILD here instead of silently diverging under method
 * bivariance. `systemPromptAppend` carries {@link getAgentSystemPrompt} on every
 * turn (S1.4). The real ClaudeCodeManager satisfies {@link AgentSpawnManagerLike}
 * (asserted at compile time in agentThreadService.parity.test.ts).
 */
export type AgentSpawnOptions = Pick<
  ClaudeSpawnOptions,
  | 'panelId'
  | 'sessionId'
  | 'worktreePath'
  | 'prompt'
  | 'isolation'
  | 'tools'
  | 'mcpScope'
  | 'eventsSink'
  | 'model'
  | 'resumeSessionId'
  | 'systemPromptAppend'
>;

/**
 * The narrow manager slice this service depends on: the single spawn/continue
 * entry point (a warm continuation is another spawnCliProcess call with the same
 * identity), plus the 'output' EventEmitter stream it bridges for live-tail +
 * session-id capture. Kept structural so tests inject a plain fake — no SDK.
 */
export interface AgentSpawnManagerLike {
  spawnCliProcess(options: AgentSpawnOptions): Promise<void>;
  on(event: 'output', listener: (payload: unknown) => void): unknown;
  off(event: 'output', listener: (payload: unknown) => void): unknown;
}

/** The 'output' event payload ClaudeCodeManager emits (claudeCodeManager.ts). */
interface AgentOutputPayload {
  panelId: string;
  sessionId: string;
  type: string;
  data: unknown;
  timestamp: Date | string;
}

/** Discriminated result of a digest trigger — throttled calls do NOT send. */
export type DigestTriggerResult = { triggered: true } | { triggered: false; reason: 'throttled' };

export interface AgentThreadServiceDeps {
  store: AgentThreadDbStore;
  manager: AgentSpawnManagerLike;
  /** Live-tail publish to the renderer's `cyboflow:stream:<threadId>` channel. */
  publish: (id: string, envelope: unknown) => void;
  /** ConfigManager default model (null ⇒ leave the spawn's model unset). */
  defaultModel: () => string | null;
  /** Base dir for per-thread neutral home dirs (`<base>/<threadId>/`). */
  homeDirBase: string;
  /** Injectable clock for the digest throttle (tests advance it). */
  now?: () => number;
  logger?: LoggerLike;
}

/**
 * Belt-and-braces pinned permission allowlist written into each thread's neutral
 * home. UNREACHABLE in normal operation — the isolation spawn sets
 * `settingSources: []`, so the CLI never reads this file. Present ONLY as
 * defense-in-depth against a regression that re-enables settings-source reading:
 * even then the agent stays restricted to its own cyboflow MCP family, matching
 * the isolation PreToolUse hook's fail-closed policy (S0.2 §2.1a).
 */
const AGENT_SETTINGS_LOCAL_JSON = JSON.stringify(
  {
    permissions: {
      allow: ['mcp__cyboflow', 'mcp__cyboflow__*'],
      deny: [],
    },
  },
  null,
  2,
);

/**
 * Observed shapes of a stale `--resume` failure surfaced by the CLI (an is_error
 * result thrown as SdkSessionTerminalError, or a thrown spawn error). Consulted
 * ONLY when a resume was actually attempted, so inclusive matching here cannot
 * mis-recover an ordinary turn.
 */
function isResumeError(err: unknown): boolean {
  const message = errMessage(err).toLowerCase();
  if (message.length === 0) return false;
  return (
    message.includes('no conversation found') ||
    /conversation .*not found/.test(message) ||
    (message.includes('session') && /(not found|invalid|expired|does not exist|no longer)/.test(message)) ||
    (message.includes('resume') && /(fail|unable|invalid|not found|expired)/.test(message))
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentThreadService {
  /** ONE durable writer for all threads; owns the runId → threadId mapping. */
  private readonly sink: AgentThreadEventsSink;
  /** threadId → 'output' listener, so the bridge attaches at most once per thread. */
  private readonly eventBridges = new Map<string, (payload: unknown) => void>();
  /**
   * threadId → last-digest wall-clock (ms). In-memory only: resets on app
   * restart, which is acceptable — the throttle guards against burst spam within
   * a session, not across restarts.
   */
  private readonly lastDigestAt = new Map<string, number>();

  constructor(private readonly deps: AgentThreadServiceDeps) {
    this.sink = new AgentThreadEventsSink(deps.store, deps.logger);
  }

  // -------------------------------------------------------------------------
  // Thread lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load the newest 'global' thread or create one, and ensure its neutral home
   * dir exists. Idempotent: a second call returns the SAME thread (no duplicate
   * row, no duplicate dir — mkdir is recursive/idempotent).
   */
  ensureGlobalThread(): AgentThread {
    const existing = this.deps.store.findLatestThreadByScope('global');
    // model left NULL on create ⇒ resolved from defaultModel() at each spawn, so
    // the thread tracks a live config-default change instead of pinning at mint.
    const thread = existing ?? this.deps.store.createThread({ scope: 'global' });
    this.ensureHomeDir(thread.id);
    return thread;
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /**
   * Send one turn. Spawns (or warm-continues) via the manager with the isolation
   * contract, threading the stored `claude_session_id` as `resumeSessionId` on
   * every continuation turn. On a stale-resume failure, clears the id and retries
   * ONCE fresh (the bridge re-captures the new id from the fresh turn's init).
   */
  async sendMessage(threadId: string, text: string): Promise<void> {
    const thread = this.deps.store.getThread(threadId);
    if (thread === null) {
      throw new Error(`AgentThreadService: unknown thread ${threadId}`);
    }
    // Attach the live-tail bridge BEFORE spawning so the turn's system/init event
    // is captured. Idempotent — repeated turns reuse the one listener.
    this.ensureEventBridge(threadId);
    this.ensureHomeDir(threadId);

    const model = (thread.model ?? this.deps.defaultModel()) ?? undefined;
    const resumeSessionId = thread.claudeSessionId ?? undefined;

    try {
      await this.spawn(threadId, text, model, resumeSessionId);
    } catch (err) {
      if (resumeSessionId !== undefined && isResumeError(err)) {
        this.deps.logger?.warn(
          `[agentThreadService] stale resume for thread ${threadId}; retrying fresh: ${errMessage(err)}`,
        );
        this.deps.store.updateClaudeSessionId(threadId, null);
        await this.spawn(threadId, text, model, undefined);
        return;
      }
      throw err;
    }
  }

  /**
   * Trigger a digest turn, server-throttled to at most one per
   * {@link DIGEST_THROTTLE_MS} per thread. A throttled call returns
   * `{triggered:false, reason:'throttled'}` WITHOUT sending.
   */
  async triggerDigest(threadId: string): Promise<DigestTriggerResult> {
    const now = this.nowMs();
    const last = this.lastDigestAt.get(threadId);
    if (last !== undefined && now - last < DIGEST_THROTTLE_MS) {
      return { triggered: false, reason: 'throttled' };
    }
    // Stamp BEFORE the (awaited) send so a concurrent trigger cannot double-fire.
    this.lastDigestAt.set(threadId, now);
    await this.sendMessage(threadId, DIGEST_PROMPT);
    return { triggered: true };
  }

  /** Tear down all live-tail bridges + the sink (app shutdown). */
  dispose(): void {
    for (const listener of this.eventBridges.values()) {
      this.deps.manager.off('output', listener);
    }
    this.eventBridges.clear();
    this.sink.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async spawn(
    threadId: string,
    text: string,
    model: string | undefined,
    resumeSessionId: string | undefined,
  ): Promise<void> {
    const identity = agentSpawnIdentity(threadId);
    const options: AgentSpawnOptions = {
      panelId: identity,
      sessionId: identity,
      worktreePath: this.homeDir(threadId),
      prompt: text,
      isolation: 'agent',
      tools: [],
      mcpScope: 'global-agent',
      eventsSink: this.sink,
      // Every turn — cold spawn or warm continuation — carries the SAME
      // system-prompt append, so a warm process's fingerprint only changes
      // when the prompt content itself changes (see the class doc comment).
      systemPromptAppend: getAgentSystemPrompt(),
      ...(model !== undefined ? { model } : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    };
    await this.deps.manager.spawnCliProcess(options);
  }

  private ensureEventBridge(threadId: string): void {
    if (this.eventBridges.has(threadId)) return;
    const identity = agentSpawnIdentity(threadId);
    const listener = (payload: unknown): void => {
      this.onOutput(threadId, identity, payload);
    };
    this.deps.manager.on('output', listener);
    this.eventBridges.set(threadId, listener);
  }

  /** Bridge one 'output' event: capture the session id + publish live-tail. */
  private onOutput(threadId: string, identity: string, payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as Partial<AgentOutputPayload>;
    if (p.panelId !== identity || p.type !== 'json') return;

    this.maybeCaptureSessionId(threadId, p.data);
    try {
      this.deps.publish(threadId, this.toEnvelope(p.data));
    } catch (err) {
      this.deps.logger?.warn(
        `[agentThreadService] live-tail publish failed for thread ${threadId}: ${errMessage(err)}`,
      );
    }
  }

  /**
   * Persist the SDK conversation id from a system/init event. The manager's own
   * capture targets `workflow_runs` (no row for a run-less thread), so the thread
   * relies on this. Unconditional overwrite: a warm turn re-writes the same id
   * (harmless); a fresh conversation (post stale-resume) writes the new id — the
   * stored id always reflects the live conversation.
   */
  private maybeCaptureSessionId(threadId: string, data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const e = data as { type?: unknown; subtype?: unknown; session_id?: unknown };
    if (e.type !== 'system' || e.subtype !== 'init') return;
    if (typeof e.session_id !== 'string' || e.session_id === '') return;
    this.deps.store.updateClaudeSessionId(threadId, e.session_id);
  }

  private toEnvelope(data: unknown): { type: string; payload: unknown; timestamp: string } {
    const type =
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      typeof (data as { type: unknown }).type === 'string'
        ? (data as { type: string }).type
        : 'unknown';
    return { type, payload: data, timestamp: new Date().toISOString() };
  }

  private homeDir(threadId: string): string {
    return join(this.deps.homeDirBase, threadId);
  }

  private ensureHomeDir(threadId: string): string {
    const home = this.homeDir(threadId);
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), AGENT_SETTINGS_LOCAL_JSON);
    return home;
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
