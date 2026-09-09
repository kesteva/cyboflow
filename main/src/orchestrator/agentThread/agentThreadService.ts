/**
 * AgentThreadService — the hosting service for the global-agent chat thread.
 *
 * Mints/loads the single 'global' thread, prepares its neutral home dir, and
 * drives turns through {@link AgentSpawnManagerLike} (the narrow slice of a CLI
 * manager it needs) with the S0.2 global-agent spawn contract.
 *
 * The host provider is resolved PER TURN from `runtime()`
 * (ConfigManager.getAssistantRuntime — Claude or Codex), and the matching
 * manager is picked out of `managers`. Everything below is provider-neutral
 * except two seams: the stored conversation id is bound to the runtime that
 * minted it (see {@link AgentThread.sessionRuntime}) and dropped on a switch,
 * and 'compact-daily' retention degrades to 'clear-daily' on Codex, which has no
 * compaction RPC. The spawn contract itself is identical on both:
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
 * Context retention: the standing conversation would otherwise grow forever
 * (bounded only by SDK auto-compaction). On the first turn of each LOCAL
 * calendar day, {@link applyDailyRetention} applies the configured
 * `assistantContextRetention` strategy — start fresh ('clear-daily', the
 * default), fire a `/compact` turn ('compact-daily'), or do nothing
 * ('auto-compact') — keyed off `agent_threads.last_turn_at` (migration 080).
 *
 * Every spawn also threads {@link getAgentSystemPrompt} (S1.4) as
 * `systemPromptAppend` — the role, the promptable contract, tool guidance,
 * recap format, and proposal-quality bar. `computeOptionsFingerprint`
 * (claudeCodeManager.ts) hashes the full composed `systemPrompt` object, so an
 * edit to `agentThreadPrompt.ts` changes the append text on the next turn and
 * correctly busts the warm persistent SDK process rather than reusing a
 * process spawned under the old prompt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentThread,
  AssistantContextRetention,
  AssistantRuntime,
} from '../../../../shared/types/agentThread';
import { DEFAULT_ASSISTANT_CONTEXT_RETENTION } from '../../../../shared/types/agentThread';
import type { CliSpawnOutcome } from '../../../../shared/types/cliPanels';
import type { ClaudeSpawnOptions } from '../../services/panels/claude/claudeCodeManager';
import type { LoggerLike } from '../types';
import type { AgentThreadDbStore } from './agentThreadDbStore';
import { AgentThreadEventsSink, agentSpawnIdentity } from './agentThreadEventsSink';
import { getAgentSystemPrompt } from './agentThreadPrompt';

// ---------------------------------------------------------------------------
// Retention prompts
// ---------------------------------------------------------------------------

/**
 * Synthetic turn text for the 'compact-daily' retention strategy. `/compact`
 * sent as a prompt string is an SDK input, not a CLI-only shortcut: the CLI
 * runs conversation compaction server-side (emitting a system
 * `compact_boundary` event) instead of handing the text to the model. See
 * https://code.claude.com/docs/en/agent-sdk/slash-commands.
 */
export const COMPACT_PROMPT = '/compact';

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
  | 'hidePromptFromTranscript'
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

export interface AgentThreadServiceDeps {
  store: AgentThreadDbStore;
  /**
   * One manager per assistant runtime, selected per turn by {@link runtime}.
   * A Record (not an optional map) so adding a runtime to ASSISTANT_RUNTIMES
   * fails the build at every wiring site rather than silently resolving to an
   * absent manager at the first turn on the new provider.
   */
  managers: Record<AssistantRuntime, AgentSpawnManagerLike>;
  /**
   * Which runtime hosts the assistant, checked per turn. The caller wires this
   * to `configManager.getAssistantRuntime()`, so a Settings change takes effect
   * on the very next turn with no restart.
   */
  runtime: () => AssistantRuntime;
  /** Live-tail publish to the renderer's `cyboflow:stream:<threadId>` channel. */
  publish: (id: string, envelope: unknown) => void;
  /**
   * ConfigManager default model FOR THE RESOLVED RUNTIME (null ⇒ leave the
   * spawn's model unset). The caller wires this to
   * `configManager.getAssistantModelFor(runtime)`: Claude resolves
   * `assistantModel ?? defaultModel`, while Codex floors a stale Claude alias to
   * null so the app-server picks its own default rather than rejecting a model
   * id from the wrong family.
   */
  defaultModel: (runtime: AssistantRuntime) => string | null;
  /**
   * Authoritative kill switch for the global assistant, checked per turn. The
   * caller wires this to `configManager.isAssistantEnabled()`, so a Settings
   * "Enable assistant" toggle takes effect on the very next call with no
   * restart. When false, `sendMessage` throws before any spawn/bridge work.
   */
  enabled: () => boolean;
  /**
   * Day-boundary context-retention strategy, checked on the first turn of each
   * LOCAL calendar day. The caller wires this to
   * `configManager.getAssistantContextRetention()`, so a Settings change
   * takes effect on the next turn with no restart. Absent ⇒
   * DEFAULT_ASSISTANT_CONTEXT_RETENTION ('clear-daily').
   */
  contextRetention?: () => AssistantContextRetention;
  /** Base dir for per-thread neutral home dirs (`<base>/<threadId>/`). */
  homeDirBase: string;
  /** Injectable clock for the day-boundary context-retention check (tests advance it). */
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
    // Codex's app-server calls the same thing a THREAD, not a session: a failed
    // `thread/resume` says the thread is gone, never the word "session". Without
    // this arm the identical failure would rethrow on Codex instead of
    // cold-starting, stranding the assistant on a conversation that no longer
    // exists.
    (message.includes('thread') && /(not found|invalid|expired|does not exist|no longer|unknown)/.test(message)) ||
    (message.includes('resume') && /(fail|unable|invalid|not found|expired)/.test(message))
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when two epoch-ms instants fall on the same LOCAL calendar day. The
 * day-boundary context-retention check is a human-facing "once per day" notion,
 * so it is anchored to the machine's local day (a boot at 00:30 is a new day),
 * not a rolling 24h window — a rolling window would also creep later every day
 * (a 9am boundary blocks tomorrow's 8:30am boot). DST inside one timezone is
 * handled by the local getters; a machine-TIMEZONE change between two
 * same-day boots can shift which named day the stored instant lands on
 * (accepted: rare, self-corrects the next day). A non-finite stored value is
 * never "the same day" — retention applies, the safe default.
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

/** One attached 'output' listener: which manager it is on, and under which runtime. */
interface AgentThreadBridge {
  runtime: AssistantRuntime;
  manager: AgentSpawnManagerLike;
  listener: (payload: unknown) => void;
}

export class AgentThreadService {
  /** ONE durable writer for all threads; owns the runId → threadId mapping. */
  private readonly sink: AgentThreadEventsSink;
  /**
   * threadId → the per-manager 'output' listeners bridging that thread. ONE
   * entry per (thread, runtime): the assistant can switch providers mid-life, so
   * both managers must be listened to from the first turn — a bridge attached
   * lazily only to the turn's own manager would miss the events of a turn that
   * switched, including its session-id capture. Each listener carries the
   * runtime it belongs to, which is how a captured id learns its provider.
   */
  private readonly eventBridges = new Map<string, AgentThreadBridge[]>();

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
   * Persists + publishes the human's own turn (a `role:'user'` transcript entry)
   * before spawning, so it renders immediately rather than only once the
   * assistant's first event lands. An optional `contextHint` is prepended to
   * the prompt the model sees (e.g. onboarding priming a proposal) but is
   * never recorded in the transcript — `recordUserTurn` always stores the raw
   * `text` the human actually typed.
   */
  async sendMessage(threadId: string, text: string, contextHint?: string): Promise<void> {
    if (!this.deps.enabled()) {
      throw new Error('assistant is disabled in settings');
    }
    let thread = this.deps.store.getThread(threadId);
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
    try {
      const userEvent = this.sink.recordUserTurn(threadId, text);
      this.deps.publish(threadId, this.toEnvelope(userEvent));
    } catch (err) {
      // Fail-soft: a transcript-echo failure must never block the actual turn.
      this.deps.logger?.warn(
        `[agentThreadService] user-turn record failed for thread ${threadId}: ${errMessage(err)}`,
      );
    }

    // Which provider hosts THIS turn. Resolved once and threaded through
    // everything below, so a Settings change mid-turn cannot leave the retention
    // pass, the spawn, and the id capture disagreeing about the provider.
    const runtime = this.deps.runtime();
    const model = (thread.model ?? this.deps.defaultModel(runtime)) ?? undefined;

    // A conversation id belongs to the provider that minted it: Codex's
    // `thread/resume` cannot take a Claude session id, nor the reverse. On a
    // runtime switch the stored id is therefore not stale, it is UNUSABLE —
    // drop it and cold-start on the new provider. The durable transcript in
    // agent_thread_events is untouched, so the user still sees their history.
    // A stored id with NO recorded runtime predates migration 131, when Claude
    // was the only host — so it is a Claude id, and a first Codex turn after the
    // upgrade must cold-start rather than hand it to `thread/resume`.
    const storedRuntime: AssistantRuntime | null =
      thread.claudeSessionId === null ? null : (thread.sessionRuntime ?? 'claude-sdk');
    if (storedRuntime !== null && storedRuntime !== runtime) {
      this.deps.logger?.info(
        `[agentThreadService] assistant runtime changed for thread ${threadId} ` +
          `(${storedRuntime} → ${runtime}); starting a fresh conversation`,
      );
      this.deps.store.updateClaudeSessionId(threadId, null);
      thread = this.deps.store.getThread(threadId) ?? thread;
    }

    // Day-boundary context retention: on the first turn of a new local day,
    // apply the configured strategy BEFORE this turn spawns. May clear the
    // stored resume id (clear-daily) or run a /compact turn that recaptures it
    // (compact-daily) — so re-read the thread afterwards; the stored id always
    // reflects the live conversation.
    await this.applyDailyRetention(thread, model, runtime);
    thread = this.deps.store.getThread(threadId) ?? thread;

    const resumeSessionId = thread.claudeSessionId ?? undefined;

    const prompt =
      contextHint !== undefined && contextHint.trim() !== ''
        ? `${contextHint.trim()}\n\n${text}`
        : text;

    try {
      await this.spawn(threadId, prompt, model, resumeSessionId, runtime);
    } catch (err) {
      if (resumeSessionId !== undefined && isResumeError(err)) {
        this.deps.logger?.warn(
          `[agentThreadService] stale resume for thread ${threadId}; retrying fresh: ${errMessage(err)}`,
        );
        this.deps.store.updateClaudeSessionId(threadId, null);
        try {
          await this.spawn(threadId, prompt, model, undefined, runtime);
        } catch (retryErr) {
          this.recordSpawnFailure(threadId, retryErr);
          throw retryErr;
        }
        return;
      }
      this.recordSpawnFailure(threadId, err);
      throw err;
    }
  }

  /**
   * Surface a failed turn IN THE TRANSCRIPT, then let the caller rethrow.
   *
   * Without this the rail shows the person's own message and then nothing —
   * `sendMessage` rejects into a caller with no dedicated error slot, so the
   * failure only ever reached the console. Codex makes that unacceptable: its
   * two most likely first-turn failures (ChatGPT auth required, Codex not
   * installed) are exactly what a user hits on the turn they switch providers.
   * Persisted AND published, so the running rail updates without a refetch.
   * Fail-soft in both halves — reporting the failure must never replace it.
   */
  private recordSpawnFailure(threadId: string, err: unknown): void {
    try {
      const event = this.sink.recordAssistantError(threadId, errMessage(err));
      this.deps.publish(threadId, this.toEnvelope(event));
    } catch (recordErr) {
      this.deps.logger?.warn(
        `[agentThreadService] error-event record failed for thread ${threadId}: ${errMessage(recordErr)}`,
      );
    }
  }

  /**
   * Apply the configured context-retention strategy at the LOCAL-day boundary,
   * then stamp `last_turn_at` (every turn, so the stored instant always
   * reflects the newest turn). A NULL stamp (fresh thread, or first turn after
   * the migration-080 upgrade) counts as a new day — harmless for a fresh
   * thread (no conversation to clear/compact) and correct for a legacy thread
   * carrying months of history.
   *
   * Strategies (no-ops when there is no stored conversation):
   *   - 'clear-daily'   — drop the resume id; the day's first turn cold-spawns a
   *                       fresh conversation. The durable transcript
   *                       (agent_thread_events) is untouched.
   *   - 'compact-daily' — fire a synthetic `/compact` turn on the existing
   *                       conversation. Fail-soft: a stale-resume failure clears
   *                       the id (fresh start — the conversation is gone anyway);
   *                       any other failure logs and lets the real turn proceed,
   *                       though the day's boundary is then consumed (documented
   *                       trade-off).
   *   - 'auto-compact'  — nothing; rely on the SDK's built-in auto-compaction.
   *
   * The stamp is written synchronously before the (awaited) compact spawn, so a
   * concurrent same-tick turn sees a same-day stamp and cannot double-apply —
   * better-sqlite3 is synchronous, so there is no await between the read and
   * the write for a concurrent call to race through.
   */
  private async applyDailyRetention(
    thread: AgentThread,
    model: string | undefined,
    runtime: AssistantRuntime,
  ): Promise<void> {
    const now = this.nowMs();
    const last = this.deps.store.getLastTurnAt(thread.id);
    const sameDay = last !== null && isSameLocalDay(last, now);
    this.deps.store.setLastTurnAt(thread.id, now);
    if (sameDay) return;

    const configured = this.deps.contextRetention?.() ?? DEFAULT_ASSISTANT_CONTEXT_RETENTION;
    // 'compact-daily' has no implementation on Codex: `/compact` is a Claude SDK
    // input the CLI executes server-side, whereas the Codex app-server protocol
    // exposes no compaction RPC — sending the same string there would hand the
    // model a literal user message reading "/compact". Degrade to the
    // 'clear-daily' behaviour, which honours the user's actual intent (do not
    // carry yesterday's context into today) with the mechanism that exists.
    const strategy =
      configured === 'compact-daily' && runtime !== 'claude-sdk' ? 'clear-daily' : configured;
    if (strategy !== configured) {
      this.deps.logger?.info(
        `[agentThreadService] compact-daily is not supported on ${runtime}; ` +
          `thread ${thread.id} starts the new day fresh instead`,
      );
    }
    if (strategy === 'auto-compact') return;
    if (thread.claudeSessionId === null) return;

    if (strategy === 'clear-daily') {
      this.deps.logger?.info(
        `[agentThreadService] clear-daily retention: starting thread ${thread.id} fresh for the new day`,
      );
      this.deps.store.updateClaudeSessionId(thread.id, null);
      return;
    }

    // 'compact-daily'
    try {
      this.deps.logger?.info(
        `[agentThreadService] compact-daily retention: compacting thread ${thread.id} for the new day`,
      );
      await this.spawn(thread.id, COMPACT_PROMPT, model, thread.claudeSessionId, runtime);
    } catch (err) {
      if (isResumeError(err)) {
        this.deps.logger?.warn(
          `[agentThreadService] stale resume during daily compact for thread ${thread.id}; starting fresh: ${errMessage(err)}`,
        );
        this.deps.store.updateClaudeSessionId(thread.id, null);
        return;
      }
      // Fail-soft: the day's real turn must never be blocked by a failed compact.
      this.deps.logger?.warn(
        `[agentThreadService] daily compact failed for thread ${thread.id}; continuing uncompacted: ${errMessage(err)}`,
      );
    }
  }

  /** Tear down all live-tail bridges + the sink (app shutdown). */
  dispose(): void {
    for (const bridges of this.eventBridges.values()) {
      for (const bridge of bridges) {
        bridge.manager.off('output', bridge.listener);
      }
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
    runtime: AssistantRuntime,
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
      // The two providers echo the prompt in opposite ways, and the transcript
      // must end up with exactly ONE copy of the human's turn either way. The
      // Codex app-server echoes every input natively, so its echo is suppressed
      // (this service already recorded the turn itself, from the RAW text — an
      // unsuppressed echo would also leak the contextHint, which must never
      // reach the transcript). The Claude manager suppresses its own synthesized
      // echo whenever `eventsSink` is set, so the flag is left off there.
      ...(runtime === 'codex-sdk' ? { hidePromptFromTranscript: true } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    };
    await this.managerFor(runtime).spawnCliProcess(options);
  }

  private managerFor(runtime: AssistantRuntime): AgentSpawnManagerLike {
    return this.deps.managers[runtime];
  }

  /**
   * Attach one live-tail listener per MANAGER for this thread, once. Both
   * providers are bridged from the first turn regardless of which one is
   * currently resolved: the runtime can change between turns, and a listener
   * attached lazily to only the turn's own manager would miss the switched
   * turn's events entirely, including its `system/init` — leaving the new
   * conversation's id uncaptured and every following turn cold-starting.
   *
   * Two runtimes may resolve to the SAME manager instance (a demo or test
   * wiring); the identity check keeps that from double-writing the transcript.
   */
  private ensureEventBridge(threadId: string): void {
    if (this.eventBridges.has(threadId)) return;
    const identity = agentSpawnIdentity(threadId);
    const bridges: AgentThreadBridge[] = [];
    for (const [runtime, manager] of Object.entries(this.deps.managers) as Array<
      [AssistantRuntime, AgentSpawnManagerLike]
    >) {
      if (bridges.some((bridge) => bridge.manager === manager)) continue;
      const listener = (payload: unknown): void => {
        this.onOutput(threadId, identity, runtime, payload);
      };
      manager.on('output', listener);
      bridges.push({ runtime, manager, listener });
    }
    this.eventBridges.set(threadId, bridges);
  }

  /** Bridge one 'output' event: capture the session id + publish live-tail. */
  private onOutput(
    threadId: string,
    identity: string,
    runtime: AssistantRuntime,
    payload: unknown,
  ): void {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as Partial<AgentOutputPayload>;
    if (p.panelId !== identity || p.type !== 'json') return;

    // `runtime` is the manager the event arrived ON, not the currently resolved
    // one — the id is stamped with the provider that actually minted it, which
    // is what makes a later switch detectable.
    this.maybeCaptureSessionId(threadId, runtime, p.data);
    try {
      this.deps.publish(threadId, this.toEnvelope(p.data));
    } catch (err) {
      this.deps.logger?.warn(
        `[agentThreadService] live-tail publish failed for thread ${threadId}: ${errMessage(err)}`,
      );
    }
  }

  /**
   * Persist the provider's conversation id from a system/init event, TOGETHER
   * with the runtime it was captured under. The manager's own capture targets
   * `workflow_runs` (no row for a run-less thread), so the thread relies on this.
   * Unconditional overwrite: a warm turn re-writes the same id (harmless); a
   * fresh conversation (post stale-resume, or post runtime switch) writes the
   * new id — the stored pair always reflects the live conversation.
   *
   * Provider-neutral by construction: Codex's `agent_init` reaches the 'output'
   * stream already projected to `system` / `init` with `session_id` set to its
   * `external_session_id`, so ONE shape check serves both managers.
   */
  private maybeCaptureSessionId(threadId: string, runtime: AssistantRuntime, data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const e = data as { type?: unknown; subtype?: unknown; session_id?: unknown };
    if (e.type !== 'system' || e.subtype !== 'init') return;
    if (typeof e.session_id !== 'string' || e.session_id === '') return;
    this.deps.store.updateClaudeSessionId(threadId, e.session_id, runtime);
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
