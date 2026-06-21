/**
 * Supervisor CHAT session — the persistent monitor + human-seam slice of the
 * Stage 3 supervisory plane (see docs/sdk-program-driven-workflows.md).
 *
 * Distinct from the one-shot triage brain (sdkSupervisor.ts): this is a LONG-LIVED
 * conversational session that runs ALONGSIDE a programmatic run. It OBSERVES the
 * monitor feed (so the agent knows what the host-driven walk is doing) and lets the
 * USER converse with the supervisor — the "primary agent responds to user queries"
 * role. It does NOT sequence the workflow and does NOT triage (triage stays the
 * one-shot structured path); it is purely the observe-and-chat human seam.
 *
 * The live SDK streaming session is isolated behind `StreamingChatBackend` (a
 * fakeable boundary; the real impl is the sole SDK importer in
 * supervisorChatBackend.ts). Everything here — transcript accumulation, the
 * monitor-feed → context bridge, subscriber fan-out, the registry — is pure /
 * fakeable and unit-tested. Like the other SDK paths, the LIVE session is opt-in
 * and not headlessly verifiable.
 *
 * Standalone-typecheck invariant: shared types + sibling protocol types only — NO
 * `@anthropic-ai/claude-agent-sdk` / electron import here.
 */
import { EventEmitter } from 'events';
import type { LoggerLike } from '../types';
import type { SupervisorEvent } from './types';

/**
 * Project/run-scoped emitter for live supervisor-chat transcript deltas, consumed
 * by the tRPC `supervisorChat.onMessage` subscription (mirrors dynamicWorkflowEvents).
 * Sessions emit each appended message on `supervisorChatChannel(runId)`.
 */
export const supervisorChatEvents = new EventEmitter();

/** Build the per-run emit channel. Exported so the subscription stays in sync. */
export function supervisorChatChannel(runId: string): string {
  return `supervisor-chat-${runId}`;
}

/** The payload broadcast on a chat channel: the run + the appended message. */
export interface SupervisorChatChanged {
  runId: string;
  message: SupervisorChatMessage;
}

/** A single turn in the supervisor conversation. */
export interface SupervisorChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** ISO timestamp (assigned by the session as messages are appended). */
  ts: string;
}

/** Per-run context for a chat session. */
export interface SupervisorChatContext {
  runId: string;
  projectId: number;
  workflowName: string;
  worktreePath: string;
}

/** A live streaming chat handle — the narrow SDK boundary (fakeable). */
export interface StreamingChatHandle {
  /** Push a user message into the live session (TRIGGERS an assistant turn). */
  send(text: string): void;
  /** Push a context note WITHOUT triggering a turn (the agent just observes it). */
  note(text: string): void;
  /** Subscribe to streamed assistant text; returns an unsubscribe fn. */
  onAssistantText(cb: (text: string) => void): () => void;
  /** Tear the session down. */
  close(): Promise<void>;
}

/** Opens a persistent streaming chat session. Satisfied by the real SDK backend. */
export interface StreamingChatBackend {
  open(args: { systemPrompt: string; cwd: string; model?: string }): StreamingChatHandle;
}

/** A per-run supervisor chat session: observe the run + converse with the user. */
export interface SupervisorChatSession {
  start(ctx: SupervisorChatContext): Promise<void>;
  /** Feed a monitor event so the supervisor "sees" the run's progress. */
  observe(event: SupervisorEvent): void;
  /** The human seam: relay a user message to the supervisor. */
  sendUserMessage(text: string): void;
  /** Subscribe to transcript changes (new message appended); returns unsubscribe. */
  onMessage(cb: (message: SupervisorChatMessage) => void): () => void;
  /** Current full transcript (for late subscribers / initial render). */
  getTranscript(): SupervisorChatMessage[];
  stop(): Promise<void>;
}

/**
 * Compose the supervisor's system prompt. Pure. Frames the agent as the monitor +
 * human seam: it watches the host-driven walk and answers the user; it must NOT
 * try to run or re-sequence the workflow (host code owns that).
 */
export function buildSupervisorChatSystemPrompt(ctx: SupervisorChatContext): string {
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree.

The workflow's steps are sequenced by HOST CODE, not by you — do NOT try to run, edit, or re-order steps. Your role is to:
- MONITOR the run: you receive a feed of step/run lifecycle events as system notes.
- Be the HUMAN SEAM: answer the user's questions about what the run is doing, why a step failed, what is pending, and help them decide.

Be concise and concrete. When the user asks about progress, ground your answer in the events you have observed. You have read-only tools for inspecting the worktree; use them to answer accurately.`;
}

/**
 * Render a monitor event as a short system note injected into the conversation so
 * the supervisor stays aware of the run. Pure.
 */
export function renderEventNote(event: SupervisorEvent): string {
  const where = event.stepId ? ` step '${event.stepId}'` : '';
  switch (event.kind) {
    case 'run-started':
      return '[run] started';
    case 'step-running':
      return `[step] running:${where}`;
    case 'step-settled':
      return `[step] settled:${where}${event.outcome ? ` (${event.outcome})` : ''}`;
    case 'step-failed':
      return `[step] FAILED:${where}${event.error ? ` — ${event.error}` : ''}`;
    case 'gate-opened':
      return `[gate] opened:${where} (awaiting human)`;
    case 'run-finished':
      return `[run] finished${event.outcome ? ` (${event.outcome})` : ''}`;
    default:
      return `[event] ${event.kind}`;
  }
}

/**
 * The default chat session over a `StreamingChatBackend`. Owns the transcript and
 * subscriber fan-out; bridges monitor events into the live session as system notes
 * and the user's turns as messages; appends streamed assistant text to the
 * transcript. Fail-soft: a not-yet-started / already-stopped session drops sends
 * (logged) rather than throwing.
 */
export class DefaultSupervisorChatSession implements SupervisorChatSession {
  private handle: StreamingChatHandle | null = null;
  private unsubscribeAssistant: (() => void) | null = null;
  private readonly transcript: SupervisorChatMessage[] = [];
  private readonly subscribers = new Set<(m: SupervisorChatMessage) => void>();
  private ctx: SupervisorChatContext | null = null;
  /** Assistant text can stream in fragments; coalesce consecutive chunks. */
  private pendingAssistant: SupervisorChatMessage | null = null;

  constructor(
    private readonly backend: StreamingChatBackend,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly logger?: LoggerLike,
  ) {}

  async start(ctx: SupervisorChatContext): Promise<void> {
    this.ctx = ctx;
    this.handle = this.backend.open({
      systemPrompt: buildSupervisorChatSystemPrompt(ctx),
      cwd: ctx.worktreePath,
    });
    this.unsubscribeAssistant = this.handle.onAssistantText((text) => this.appendAssistant(text));
    this.logger?.info('[SupervisorChat] session started', { runId: ctx.runId });
  }

  observe(event: SupervisorEvent): void {
    // Flush any in-flight assistant message so the note lands after it.
    this.flushAssistant();
    const note = renderEventNote(event);
    this.append({ role: 'system', text: note, ts: this.now() });
    // note() injects context WITHOUT triggering a turn (shouldQuery:false in the
    // real backend), so the supervisor stays aware without replying to every event.
    this.handle?.note(note);
  }

  sendUserMessage(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.flushAssistant();
    this.append({ role: 'user', text: trimmed, ts: this.now() });
    if (!this.handle) {
      this.logger?.warn('[SupervisorChat] user message dropped — session not started', { runId: this.ctx?.runId });
      return;
    }
    this.handle.send(trimmed);
  }

  onMessage(cb: (message: SupervisorChatMessage) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getTranscript(): SupervisorChatMessage[] {
    return [...this.transcript];
  }

  async stop(): Promise<void> {
    this.flushAssistant();
    this.unsubscribeAssistant?.();
    this.unsubscribeAssistant = null;
    const h = this.handle;
    this.handle = null;
    if (h) {
      try {
        await h.close();
      } catch (err) {
        this.logger?.warn('[SupervisorChat] handle.close failed (fail-soft)', {
          runId: this.ctx?.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.subscribers.clear();
  }

  /** Coalesce streamed assistant fragments into one message until a flush. */
  private appendAssistant(text: string): void {
    if (text.length === 0) return;
    if (this.pendingAssistant) {
      this.pendingAssistant.text += text;
      this.notify(this.pendingAssistant); // re-emit the growing message
      return;
    }
    this.pendingAssistant = { role: 'assistant', text, ts: this.now() };
    this.transcript.push(this.pendingAssistant);
    this.notify(this.pendingAssistant);
  }

  private flushAssistant(): void {
    this.pendingAssistant = null;
  }

  private append(message: SupervisorChatMessage): void {
    this.transcript.push(message);
    this.notify(message);
  }

  private notify(message: SupervisorChatMessage): void {
    for (const cb of this.subscribers) {
      try {
        cb(message);
      } catch (err) {
        this.logger?.warn('[SupervisorChat] subscriber threw (fail-soft)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Also broadcast on the module emitter so the tRPC subscription (which has no
    // direct handle to this session) streams the delta. Keyed by runId.
    if (this.ctx) {
      supervisorChatEvents.emit(supervisorChatChannel(this.ctx.runId), {
        runId: this.ctx.runId,
        message,
      } satisfies SupervisorChatChanged);
    }
  }
}

/**
 * Per-run registry of active supervisor chat sessions, so the tRPC layer (and the
 * renderer) can reach the session for a run by id. Created on programmatic-run
 * start, removed on stop. Singleton, mirroring the other orchestrator registries.
 */
export class SupervisorChatRegistry {
  private static instance: SupervisorChatRegistry | null = null;
  private readonly sessions = new Map<string, SupervisorChatSession>();

  static getInstance(): SupervisorChatRegistry {
    if (!SupervisorChatRegistry.instance) {
      SupervisorChatRegistry.instance = new SupervisorChatRegistry();
    }
    return SupervisorChatRegistry.instance;
  }

  static _resetForTesting(): void {
    SupervisorChatRegistry.instance = null;
  }

  register(runId: string, session: SupervisorChatSession): void {
    this.sessions.set(runId, session);
  }

  get(runId: string): SupervisorChatSession | undefined {
    return this.sessions.get(runId);
  }

  unregister(runId: string): void {
    this.sessions.delete(runId);
  }
}
