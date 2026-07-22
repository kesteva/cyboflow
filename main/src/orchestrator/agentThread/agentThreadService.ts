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
import type { CliSpawnOutcome } from '../../../../shared/types/cliPanels';
import type { ClaudeSpawnOptions } from '../../services/panels/claude/claudeCodeManager';
import type { LoggerLike } from '../types';
import type { AgentThreadDbStore } from './agentThreadDbStore';
import { AgentThreadEventsSink, agentSpawnIdentity } from './agentThreadEventsSink';
import { getAgentSystemPrompt } from './agentThreadPrompt';

// ---------------------------------------------------------------------------
// Digest trigger prompt
// ---------------------------------------------------------------------------

/**
 * Synthetic turn text sent for the auto-digest — a once-per-day **daily
 * recap**. Deliberately a short, plain ask naming the three sections; the
 * concrete FORMAT (ordering, refs, "Needs your attention" shortlist) lives in
 * {@link getAgentSystemPrompt}'s system-prompt append (S1.4), not in this
 * per-turn text, so it stays in effect no matter how the recap is triggered
 * (this synthetic prompt, or the human just asking "what's my recap?").
 */
export const DIGEST_PROMPT =
  'Give me my daily recap, in three sections: (1) what was completed in the ' +
  'last day — runs and sessions that finished, tasks integrated, ideas planned; ' +
  '(2) what is in flight right now — running or paused sessions and runs, and ' +
  'where each one is; (3) what needs my input — every blocked run, pending gate, ' +
  'and open review item across all projects. Keep it tight.';

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
  // Return widened to `CliSpawnOutcome | void` so ClaudeCodeManager (which now
  // resolves the typed step-output channel, §5.3) still structurally satisfies
  // this slice; the service awaits and ignores the resolved value.
  spawnCliProcess(options: AgentSpawnOptions): Promise<CliSpawnOutcome | void>;
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

/** Discriminated result of a digest trigger — throttled/disabled calls do NOT send. */
export type DigestTriggerResult =
  | { triggered: true }
  | { triggered: false; reason: 'throttled' | 'disabled' };

export interface AgentThreadServiceDeps {
  store: AgentThreadDbStore;
  manager: AgentSpawnManagerLike;
  /** Live-tail publish to the renderer's `cyboflow:stream:<threadId>` channel. */
  publish: (id: string, envelope: unknown) => void;
  /**
   * ConfigManager default model (null ⇒ leave the spawn's model unset). The
   * caller wires this to `getAssistantModel() ?? getDefaultModel()`, so a
   * Settings "Assistant" model override takes effect on the next turn with no
   * restart.
   */
  defaultModel: () => string | null;
  /**
   * Authoritative kill switch for the global assistant, checked per turn. The
   * caller wires this to `configManager.isAssistantEnabled()`, so a Settings
   * "Enable assistant" toggle takes effect on the very next call with no
   * restart. When false, `sendMessage` throws before any spawn/bridge work and
   * `triggerDigest` returns `{triggered:false, reason:'disabled'}` without
   * stamping the throttle.
   */
  enabled: () => boolean;
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

/**
 * True when two epoch-ms instants fall on the same LOCAL calendar day. The
 * once-per-day digest cap is a human-facing "one recap a day" notion, so it is
 * anchored to the machine's local day (a boot at 00:30 is a new day's recap),
 * not a rolling 24h window — a rolling window would also creep the recap later
 * every day (a 9am recap blocks tomorrow's 8:30am boot). DST inside one
 * timezone is handled by the local getters; a machine-TIMEZONE change between
 * two same-day boots can shift which named day the stored instant lands on
 * (accepted: rare, self-corrects the next day, worst case one extra or one
 * suppressed recap). A non-finite stored value is never "the same day" — the
 * digest fires, the safe default.
 */
function isSameLocalDay(aMs: number, bMs: number): boolean {
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export class AgentThreadService {
  /** ONE durable writer for all threads; owns the runId → threadId mapping. */
  private readonly sink: AgentThreadEventsSink;
  /** threadId → 'output' listener, so the bridge attaches at most once per thread. */
  private readonly eventBridges = new Map<string, (payload: unknown) => void>();

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
    return this.sendTurn(threadId, text, true);
  }

  /**
   * Shared turn body. `recordUserTurn` distinguishes a human-authored message
   * (persisted + live-published as a `role:'user'` turn, so it appears in the
   * transcript the same way it does in a run's chat) from the AUTO-fired digest,
   * whose synthetic prompt nobody typed — rendering that as a "You" bubble would
   * attribute a machine-triggered turn to the person.
   */
  private async sendTurn(threadId: string, text: string, recordUserTurn: boolean): Promise<void> {
    if (!this.deps.enabled()) {
      throw new Error('assistant is disabled in settings');
    }
    const thread = this.deps.store.getThread(threadId);
    if (thread === null) {
      throw new Error(`AgentThreadService: unknown thread ${threadId}`);
    }
    // Attach the live-tail bridge BEFORE spawning so the turn's system/init event
    // is captured. Idempotent — repeated turns reuse the one listener.
    this.ensureEventBridge(threadId);
    this.ensureHomeDir(threadId);

    // Persist + publish the human's own turn BEFORE the spawn, so it renders
    // immediately rather than only once the assistant's first event lands. Never
    // repeated on the stale-resume retry below (which re-enters `spawn`, not this).
    if (recordUserTurn) {
      try {
        const userEvent = this.sink.recordUserTurn(threadId, text);
        this.deps.publish(threadId, this.toEnvelope(userEvent));
      } catch (err) {
        // Fail-soft: a transcript-echo failure must never block the actual turn.
        this.deps.logger?.warn(
          `[agentThreadService] user-turn record failed for thread ${threadId}: ${errMessage(err)}`,
        );
      }
    }

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
   * Trigger the AUTO daily-recap turn, capped to at most ONE per local calendar
   * day per thread. The last-fire instant is read from — and stamped to —
   * persistent storage (agent_threads.last_digest_at, migration 076) so the cap
   * survives an app restart (the frontend fires this once per launch; the old
   * in-memory throttle reset every restart, re-firing on multi-boot days). A
   * capped call returns `{triggered:false, reason:'throttled'}` WITHOUT
   * sending. Only the AUTO path is gated — a user asking for a status update
   * (chip / typed message) goes through `sendMessage` and is never throttled.
   */
  async triggerDigest(threadId: string): Promise<DigestTriggerResult> {
    if (!this.deps.enabled()) {
      return { triggered: false, reason: 'disabled' };
    }
    const now = this.nowMs();
    const last = this.deps.store.getLastDigestAt(threadId);
    if (last !== null && isSameLocalDay(last, now)) {
      return { triggered: false, reason: 'throttled' };
    }
    // Stamp SYNCHRONOUSLY before the awaited send: better-sqlite3 is sync and
    // there is no await between the read above and this write, so a concurrent
    // same-launch trigger sees the fresh stamp and is throttled (no
    // double-fire, no in-memory shadow needed). But the send can still fail for
    // transient boot-time reasons (offline, auth, model unavailable, a
    // stale-resume whose one fresh retry also fails) — so ROLL BACK to the
    // prior value on throw, or a failed first boot of the day would consume the
    // whole day's allowance and suppress the recap until tomorrow. Restoring
    // keeps the day retryable on the next boot while preserving the synchronous
    // double-fire guard.
    this.deps.store.setLastDigestAt(threadId, now);
    try {
      await this.sendTurn(threadId, DIGEST_PROMPT, false);
    } catch (err) {
      this.deps.store.setLastDigestAt(threadId, last);
      throw err;
    }
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
