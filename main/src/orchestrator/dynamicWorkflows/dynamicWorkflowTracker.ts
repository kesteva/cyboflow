/**
 * DynamicWorkflowTracker — singleton state owner for passively-detected Claude
 * Code dynamic workflows (the Workflow tool / ultracode).
 *
 * Per attached run it wires a DynamicWorkflowDetector onto the EventRouter's
 * typed stream; a detected launch reads the persisted script's meta, builds a
 * DynamicWorkflowRunState, and starts a JournalTailer for live agent progress.
 * Completion comes from the wf_<id>.json terminal record (authoritative) or
 * the in-stream `<task-notification>` accelerator; a stalled tailer marks the
 * run failed. Every state change emits on `dynamicWorkflowEvents` ('changed',
 * DynamicWorkflowChangedEvent) for the tRPC subscription bridge.
 *
 * Finalization creates a non-blocking human_task review item via the
 * ReviewItemRouter chokepoint (source = DYNAMIC_WORKFLOW_REVIEW_SOURCE);
 * `resolveReviewItemsForSession` is the merge/dismiss auto-resolve sweep.
 *
 * Singleton lifecycle mirrors ReviewItemRouter (initialize/getInstance/
 * _resetForTesting) plus `tryGetInstance` — managers that may run before
 * initialize use it and skip attaching when null. The DB is injected as the
 * narrow DatabaseLike so tests can stub it.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { EventRouter } from '../../services/streamParser/eventRouter';
import type { DatabaseLike, LoggerLike } from '../types';
import { ReviewItemRouter } from '../reviewItemRouter';
import { DynamicWorkflowDetector } from './dynamicWorkflowDetector';
import type { DynamicWorkflowLaunchInfo, DynamicWorkflowNotification } from './dynamicWorkflowDetector';
import { JournalTailer, readCompletionRecord } from './journalTailer';
import type { DynamicWorkflowCompletionRecord } from './journalTailer';
import { parseScriptMeta } from './scriptMeta';
import { DYNAMIC_WORKFLOW_REVIEW_SOURCE } from '../../../../shared/types/dynamicWorkflows';
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowChangedEvent,
  DynamicWorkflowRunState,
} from '../../../../shared/types/dynamicWorkflows';

// ---------------------------------------------------------------------------
// Public event emitter — exported HERE, mirroring reviewItemChangeEvents.
// Emits 'changed' with a DynamicWorkflowChangedEvent (full state snapshot;
// receivers replace, never merge).
// ---------------------------------------------------------------------------

export const dynamicWorkflowEvents = new EventEmitter();

/** projectId recorded when the session lookup fails — review items are skipped for it. */
const PROJECT_ID_SENTINEL = -1;
/** Most-recent states kept per session; oldest TERMINAL ones beyond this are dropped. */
const MAX_TRACKED_PER_SESSION = 5;
/** `<status>` values in a task-notification that terminate a workflow. */
const TERMINAL_NOTIFICATION_STATUSES = new Set(['completed', 'failed', 'killed']);

/** The run/session context a detector subscription is scoped to. */
export interface DynamicWorkflowRunContext {
  runId: string;
  sessionId: string;
}

export class DynamicWorkflowTracker {
  private static instance: DynamicWorkflowTracker | null = null;

  /** wfRunId -> tracked state, in launch order (Map preserves insertion). */
  private readonly states = new Map<string, DynamicWorkflowRunState>();
  /** wfRunId -> live tailer. File-based — outlives the router subscription. */
  private readonly tailers = new Map<string, JournalTailer>();
  /** wfRunId -> terminal-record path (for the notification accelerator's immediate read). */
  private readonly recordPaths = new Map<string, string>();
  /** runId -> EventRouter teardown returned by onRun. */
  private readonly teardowns = new Map<string, () => void>();
  /** Demo-mode scripted-timeline timers (injectDemoWorkflow), cleared on dispose. */
  private readonly demoTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly logger: LoggerLike | undefined;

  constructor(
    private readonly db: DatabaseLike,
    opts?: { logger?: LoggerLike },
  ) {
    this.logger = opts?.logger;
  }

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring ReviewItemRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike, opts?: { logger?: LoggerLike }): DynamicWorkflowTracker {
    DynamicWorkflowTracker.instance = new DynamicWorkflowTracker(db, opts);
    return DynamicWorkflowTracker.instance;
  }

  static getInstance(): DynamicWorkflowTracker {
    if (!DynamicWorkflowTracker.instance) {
      throw new Error(
        'DynamicWorkflowTracker has not been initialized. Call DynamicWorkflowTracker.initialize() from main/src/index.ts.',
      );
    }
    return DynamicWorkflowTracker.instance;
  }

  /**
   * Null when uninitialized — managers that attach runs use this and skip
   * dynamic-workflow tracking rather than throwing at boot seams.
   */
  static tryGetInstance(): DynamicWorkflowTracker | null {
    return DynamicWorkflowTracker.instance;
  }

  /** Reset singleton — intended for tests only. Stops any live tailers first. */
  static _resetForTesting(): void {
    DynamicWorkflowTracker.instance?.dispose();
    DynamicWorkflowTracker.instance = null;
  }

  // --------------------------------------------------------------------------
  // Router attachment
  // --------------------------------------------------------------------------

  /**
   * Subscribe a detector to all typed events for `ctx.runId` on the router.
   * Re-attaching for the same runId replaces the previous subscription
   * (tears the old one down first — mirrors RawEventsSink.attachToRouter).
   */
  attachToRouter(router: EventRouter, ctx: DynamicWorkflowRunContext): void {
    const existing = this.teardowns.get(ctx.runId);
    if (existing !== undefined) {
      existing();
    }

    const detector = new DynamicWorkflowDetector({
      onLaunch: (info) => this.handleLaunch(ctx, info),
      onNotification: (info) => this.handleNotification(info),
      logger: this.logger,
    });

    const teardown = router.onRun(ctx.runId, (event) => detector.handleEvent(event));
    this.teardowns.set(ctx.runId, teardown);
  }

  /**
   * Remove the router subscription for a run. In-flight JournalTailers KEEP
   * running — they are file-based and independent of the live process — until
   * completion or stall.
   */
  detachRun(runId: string): void {
    const teardown = this.teardowns.get(runId);
    if (teardown !== undefined) {
      teardown();
      this.teardowns.delete(runId);
    }
  }

  // --------------------------------------------------------------------------
  // Demo mode (scripted, no on-disk journal)
  // --------------------------------------------------------------------------

  /**
   * Drive a CANNED dynamic-workflow timeline for demo mode — no real Workflow
   * tool launch, no journal.jsonl, no agent transcripts. The normal path is
   * strictly on-disk file-tail driven (JournalTailer); demo mode has no real
   * agent process, so this injects state directly into the same `states` map +
   * `dynamicWorkflowEvents` emitter the tRPC bridge reads, animating a fan-out
   * (agents appear → progress → complete) so the QuickSessionCanvas takeover and
   * the landing ActiveAgents cards light up exactly as they would for a live
   * ultracode run. Completion creates the same human_task review item (so the
   * merge/dismiss auto-resolve sweep covers it too).
   *
   * Idempotent per run; the scripted timers are cleared on dispose.
   */
  injectDemoWorkflow(ctx: DynamicWorkflowRunContext): void {
    const wfRunId = `wf_demo_${ctx.runId}`;
    if (this.states.has(wfRunId)) return;

    const { sessionName, projectId } = this.lookupSession(ctx.sessionId);

    const state: DynamicWorkflowRunState = {
      wfRunId,
      taskId: wfRunId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      projectId,
      sessionName,
      name: 'parallel-audit',
      description: 'Fan a codebase audit out across dimensions, then adversarially verify the findings',
      phases: [
        { title: 'Audit', detail: 'one agent per dimension' },
        { title: 'Verify', detail: 'confirm + dedupe findings' },
      ],
      agents: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.states.set(wfRunId, state);
    this.enforceSessionCap(ctx.sessionId);
    this.emitChanged(state);

    // Scripted agent fan-out. Each agent grows tokens/tool-uses, then flips done.
    const mk = (
      agentId: string,
      model: string,
      promptExcerpt: string,
      status: DynamicWorkflowAgent['status'],
      outputTokens: number,
      toolUses: number,
    ): DynamicWorkflowAgent => ({
      agentId,
      status,
      model,
      outputTokens,
      toolUses,
      startedAt: state.startedAt,
      lastActivityAt: new Date().toISOString(),
      promptExcerpt,
    });

    const OPUS = 'claude-opus-4-8';
    const HAIKU = 'claude-haiku-4-5';
    const steps: Array<{ at: number; agents: DynamicWorkflowAgent[] }> = [
      {
        at: 1200,
        agents: [mk('audit-correctness', OPUS, 'Audit auth + session handling for correctness bugs', 'running', 1400, 3)],
      },
      {
        at: 2600,
        agents: [
          mk('audit-correctness', OPUS, 'Audit auth + session handling for correctness bugs', 'running', 4200, 8),
          mk('audit-perf', OPUS, 'Audit the habits service for N+1 queries and hot paths', 'running', 2100, 5),
          mk('audit-validation', HAIKU, 'Audit input validation + sanitization across endpoints', 'running', 1800, 4),
        ],
      },
      {
        at: 5200,
        agents: [
          mk('audit-correctness', OPUS, 'Audit auth + session handling for correctness bugs', 'done', 8600, 14),
          mk('audit-perf', OPUS, 'Audit the habits service for N+1 queries and hot paths', 'running', 6400, 11),
          mk('audit-validation', HAIKU, 'Audit input validation + sanitization across endpoints', 'done', 5200, 9),
        ],
      },
      {
        at: 7600,
        agents: [
          mk('audit-correctness', OPUS, 'Audit auth + session handling for correctness bugs', 'done', 8600, 14),
          mk('audit-perf', OPUS, 'Audit the habits service for N+1 queries and hot paths', 'done', 9100, 16),
          mk('audit-validation', HAIKU, 'Audit input validation + sanitization across endpoints', 'done', 5200, 9),
          mk('verify-findings', OPUS, 'Adversarially verify each finding and dedupe overlaps', 'running', 3300, 7),
        ],
      },
    ];

    for (const step of steps) {
      const timer = setTimeout(() => {
        this.demoTimers.delete(timer);
        if (!this.states.has(wfRunId) || state.status !== 'running') return;
        state.agents = step.agents;
        this.emitChanged(state);
      }, step.at);
      this.demoTimers.add(timer);
    }

    // Terminal transition — completed with totals + a summary, then the review
    // item (mirrors finalize()). Guarded against a mid-flight dismiss (dispose
    // clears the timer; the states-membership check covers the race).
    const finishTimer = setTimeout(() => {
      this.demoTimers.delete(finishTimer);
      if (!this.states.has(wfRunId) || state.status !== 'running') return;
      state.agents = state.agents.map((a) => ({ ...a, status: 'done' as const }));
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.summary =
        'Audited 4 dimensions across the worktree. 3 findings confirmed (1 correctness, 1 N+1 query, 1 missing validation), 1 dismissed as a false positive. Fixes queued as tasks.';
      state.totals = { agentCount: 4, totalTokens: 31200, totalToolCalls: 46, durationMs: 9500 };
      this.emitChanged(state);
      this.createReviewItem(state, `Dynamic workflow finished: ${state.name}`);
    }, 9800);
    this.demoTimers.add(finishTimer);
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** All tracked states (launch order), optionally filtered to one session. */
  list(sessionId?: string): DynamicWorkflowRunState[] {
    const all = [...this.states.values()];
    const filtered = sessionId === undefined ? all : all.filter((s) => s.sessionId === sessionId);
    return filtered.map((s) => this.snapshot(s));
  }

  // --------------------------------------------------------------------------
  // Launch handling
  // --------------------------------------------------------------------------

  private handleLaunch(ctx: DynamicWorkflowRunContext, info: DynamicWorkflowLaunchInfo): void {
    try {
      if (this.states.has(info.wfRunId)) return; // replayed launch event — already tracked

      const { sessionName, projectId } = this.lookupSession(ctx.sessionId);
      const meta = this.readScriptMeta(info.scriptPath);
      // Fallback name: script filename minus the trailing `-wf_<id>` suffix.
      const fallbackName = path.basename(info.scriptPath, '.js').replace(/-wf_[A-Za-z0-9-]+$/, '');

      const state: DynamicWorkflowRunState = {
        wfRunId: info.wfRunId,
        taskId: info.taskId,
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        projectId,
        sessionName,
        name: meta.name ?? fallbackName,
        description: meta.description ?? undefined,
        phases: meta.phases,
        agents: [],
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      // scriptPath is <X>/workflows/scripts/<name>-wf_<id>.js; the terminal
      // record lives one level up at <X>/workflows/wf_<id>.json.
      const recordPath = path.join(path.dirname(path.dirname(info.scriptPath)), `${info.wfRunId}.json`);
      const journalPath = path.join(info.transcriptDir, 'journal.jsonl');

      const tailer = new JournalTailer({
        journalPath,
        recordPath,
        onAgents: (agents) => {
          state.agents = agents;
          this.emitChanged(state);
        },
        onComplete: (record) => this.finalize(state, record),
        onStalled: () => this.handleStalled(state),
        logger: this.logger,
      });

      this.states.set(info.wfRunId, state);
      this.tailers.set(info.wfRunId, tailer);
      this.recordPaths.set(info.wfRunId, recordPath);
      this.enforceSessionCap(ctx.sessionId);
      tailer.start();
      this.emitChanged(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dynamicWorkflowTracker] launch handling failed for ${info.wfRunId}: ${message}`);
    }
  }

  /**
   * Session display name + project id for review-item provenance. Lookup
   * failure is fail-soft: empty name + the projectId sentinel (review-item
   * creation is skipped for sentinel states).
   */
  private lookupSession(sessionId: string): { sessionName: string; projectId: number } {
    try {
      const row = this.db
        .prepare('SELECT name, project_id FROM sessions WHERE id = ?')
        .get(sessionId) as { name: string | null; project_id: number | null } | undefined;
      if (row === undefined) {
        this.logger?.warn(`[dynamicWorkflowTracker] session ${sessionId} not found — using sentinel project id`);
        return { sessionName: '', projectId: PROJECT_ID_SENTINEL };
      }
      return { sessionName: row.name ?? '', projectId: row.project_id ?? PROJECT_ID_SENTINEL };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dynamicWorkflowTracker] session lookup failed for ${sessionId}: ${message}`);
      return { sessionName: '', projectId: PROJECT_ID_SENTINEL };
    }
  }

  /** Read + parse the persisted script's meta literal. Fail-soft on fs errors. */
  private readScriptMeta(scriptPath: string): ReturnType<typeof parseScriptMeta> {
    try {
      return parseScriptMeta(readFileSync(scriptPath, 'utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dynamicWorkflowTracker] could not read workflow script ${scriptPath}: ${message}`);
      return { name: null, description: null, phases: [] };
    }
  }

  /**
   * Cap tracked states at the MAX_TRACKED_PER_SESSION most recent per session,
   * dropping the oldest TERMINAL (completed/failed) ones first. Running states
   * are never dropped — their tailers are still live.
   */
  private enforceSessionCap(sessionId: string): void {
    const sessionWfIds = [...this.states.entries()]
      .filter(([, s]) => s.sessionId === sessionId)
      .map(([wfRunId]) => wfRunId);
    let excess = sessionWfIds.length - MAX_TRACKED_PER_SESSION;
    if (excess <= 0) return;

    for (const wfRunId of sessionWfIds) {
      if (excess === 0) break;
      const state = this.states.get(wfRunId);
      if (state === undefined || state.status === 'running') continue;
      this.tailers.get(wfRunId)?.stop();
      this.tailers.delete(wfRunId);
      this.recordPaths.delete(wfRunId);
      this.states.delete(wfRunId);
      excess--;
    }
  }

  // --------------------------------------------------------------------------
  // Completion paths
  // --------------------------------------------------------------------------

  /**
   * In-stream `<task-notification>` accelerator. Only terminal statuses on a
   * tracked RUNNING taskId finalize — and the authoritative record is
   * PREFERRED: one immediate record read is attempted first; the notification
   * status is the fallback when the record has not landed yet.
   */
  private handleNotification(info: DynamicWorkflowNotification): void {
    try {
      if (!TERMINAL_NOTIFICATION_STATUSES.has(info.status)) return;
      const state = [...this.states.values()].find(
        (s) => s.taskId === info.taskId && s.status === 'running',
      );
      if (state === undefined) return; // not one of ours — the detector forwards every match

      const recordPath = this.recordPaths.get(state.wfRunId);
      const record = recordPath !== undefined ? readCompletionRecord(recordPath, this.logger) : null;
      if (record !== null) {
        this.finalize(state, record);
        return;
      }
      this.finalize(state, { status: info.status === 'completed' ? 'completed' : 'failed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dynamicWorkflowTracker] notification handling failed for ${info.taskId}: ${message}`);
    }
  }

  /** Terminal transition: set fields, stop the tailer, emit, create the review item. */
  private finalize(state: DynamicWorkflowRunState, record: DynamicWorkflowCompletionRecord): void {
    if (state.status !== 'running') return; // record/notification race — first finalize wins
    state.status = record.status;
    if (record.summary !== undefined) state.summary = record.summary;
    if (record.totals !== undefined) state.totals = record.totals;
    state.completedAt = new Date().toISOString();
    this.tailers.get(state.wfRunId)?.stop();
    this.emitChanged(state);
    this.createReviewItem(state, `Dynamic workflow finished: ${state.name}`);
  }

  /** Stall path: mark failed AND surface a review item so the user is pointed at it. */
  private handleStalled(state: DynamicWorkflowRunState): void {
    if (state.status !== 'running') return;
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    this.tailers.get(state.wfRunId)?.stop(); // tailer stopped itself already — idempotent
    this.emitChanged(state);
    this.createReviewItem(state, `Dynamic workflow stalled: ${state.name}`);
  }

  /**
   * Create the non-blocking human_task review item through the ReviewItemRouter
   * chokepoint. Fail-soft: a sentinel projectId (failed session lookup) skips
   * creation; getInstance() throwing (uninitialized in tests) logs a WARN.
   */
  private createReviewItem(state: DynamicWorkflowRunState, title: string): void {
    if (state.projectId === PROJECT_ID_SENTINEL) {
      this.logger?.warn(
        `[dynamicWorkflowTracker] skipping review item for ${state.wfRunId} — session lookup failed at launch`,
      );
      return;
    }

    const agentCount = state.totals?.agentCount ?? state.agents.length;
    const bodyLines = [
      state.summary ?? '(no summary in the terminal record)',
      `${agentCount} subagent${agentCount === 1 ? '' : 's'} ran.`,
      state.sessionName !== '' ? `Session: ${state.sessionName}` : null,
    ].filter((line): line is string => line !== null);

    try {
      void ReviewItemRouter.getInstance()
        .applyReviewItem(state.projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'human_task',
          title,
          body: bodyLines.join('\n'),
          blocking: false,
          runId: state.runId,
          source: DYNAMIC_WORKFLOW_REVIEW_SOURCE,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger?.warn(`[dynamicWorkflowTracker] review item create failed for ${state.wfRunId}: ${message}`);
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dynamicWorkflowTracker] review item create failed for ${state.wfRunId}: ${message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Merge/dismiss auto-resolve sweep
  // --------------------------------------------------------------------------

  /**
   * Resolve every PENDING dynamic-workflow review item attached to the
   * session's run (sessions.run_id). Called from the session merge/dismiss
   * close-out. Fail-soft per item; returns the resolved count.
   */
  async resolveReviewItemsForSession(sessionId: string, actor: 'user'): Promise<number> {
    let rows: Array<{ id: string; project_id: number }>;
    try {
      const session = this.db
        .prepare('SELECT run_id FROM sessions WHERE id = ?')
        .get(sessionId) as { run_id: string | null } | undefined;
      if (session === undefined || session.run_id === null || session.run_id === undefined) {
        return 0;
      }
      rows = this.db
        .prepare(
          `SELECT id, project_id FROM review_items
            WHERE source = ? AND run_id = ? AND status = 'pending'`,
        )
        .all(DYNAMIC_WORKFLOW_REVIEW_SOURCE, session.run_id) as Array<{ id: string; project_id: number }>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[dynamicWorkflowTracker] review-item sweep query failed for ${sessionId}: ${message}`);
      return 0;
    }

    let resolved = 0;
    for (const row of rows) {
      try {
        await ReviewItemRouter.getInstance().applyReviewItem(row.project_id, {
          op: 'resolve',
          actor,
          reviewItemId: row.id,
          resolution: 'session closed (merge/dismiss)',
        });
        resolved += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`[dynamicWorkflowTracker] failed to resolve review item ${row.id}: ${message}`);
      }
    }
    return resolved;
  }

  // --------------------------------------------------------------------------
  // Teardown
  // --------------------------------------------------------------------------

  /** Stop all tailers + router subscriptions and clear state (for tests). */
  dispose(): void {
    for (const timer of this.demoTimers.values()) clearTimeout(timer);
    this.demoTimers.clear();
    for (const tailer of this.tailers.values()) tailer.stop();
    this.tailers.clear();
    for (const teardown of this.teardowns.values()) teardown();
    this.teardowns.clear();
    this.recordPaths.clear();
    this.states.clear();
  }

  // --------------------------------------------------------------------------
  // Emit helpers
  // --------------------------------------------------------------------------

  /** Shallow snapshot so receivers can't mutate (or be mutated by) live state. */
  private snapshot(state: DynamicWorkflowRunState): DynamicWorkflowRunState {
    return { ...state, phases: [...state.phases], agents: [...state.agents] };
  }

  private emitChanged(state: DynamicWorkflowRunState): void {
    dynamicWorkflowEvents.emit('changed', {
      state: this.snapshot(state),
    } satisfies DynamicWorkflowChangedEvent);
  }
}
