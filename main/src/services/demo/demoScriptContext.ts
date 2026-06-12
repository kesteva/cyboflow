/**
 * DemoScriptContext — the toolkit a scripted demo run uses to drive the REAL
 * app machinery (demo mode, see demoEnvironment.ts).
 *
 * Every effect goes through the same chokepoints a live agent uses:
 *   - transcript messages  → 'output' events on the DemoCliManager (bridged to
 *     the renderer) + EventRouter/RawEventsSink persistence (mirrors
 *     ClaudeCodeManager.runSdkQuery — RunExecutor's bridge has
 *     skipPersistence:true, the manager owns raw_events).
 *   - step progress        → buildStepTransitionEvent (stepTransitionBridge)
 *   - permission gates     → ApprovalRouter.requestApproval (awaits the user)
 *   - question gates       → QuestionRouter.requestQuestion (awaits the user)
 *   - human step gates     → HumanStepManager.openHumanGate + status poll
 *   - findings/human tasks → ReviewItemRouter.applyReviewItem
 *   - sprint lanes         → SprintLaneStore.updateLane
 *   - file changes         → real fs writes + git commits in the run's worktree
 *
 * Because the gates are the real routers, the demo pauses exactly like a live
 * run until the user acts in the UI.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../orchestrator/questionRouter';
import { ReviewItemRouter } from '../../orchestrator/reviewItemRouter';
import type { ReviewItemCreate } from '../../orchestrator/reviewItemRouter';
import { HumanStepManager } from '../../orchestrator/humanStepManager';
import { SprintLaneStore } from '../../orchestrator/sprintLaneStore';
import { buildStepTransitionEvent } from '../../orchestrator/stepTransitionBridge';
import { TypedEventNarrowing } from '../streamParser';
import type { EventRouter } from '../streamParser';
import type { QuestionPayload, QuestionAnswer } from '../../../../shared/types/questions';
import type { SprintBatchTaskStatus } from '../../../../shared/types/sprintBatch';
import type { Logger } from '../../utils/logger';

/** Thrown when the script is aborted (cancel / pause / kill) — a clean exit. */
export class DemoScriptAborted extends Error {
  constructor() {
    super('demo script aborted');
    this.name = 'DemoScriptAborted';
  }
}

export interface DemoScriptArgs {
  panelId: string;
  sessionId: string;
  /** workflow_runs.id (=== panelId for workflow runs; the session's sentinel run for chat). */
  runId: string;
  worktreePath: string;
  prompt: string;
  signal: AbortSignal;
  db: Database.Database;
  /** The DemoCliManager — 'output' events are emitted on it. */
  emitter: EventEmitter;
  /** Per-run persistence pipeline (null for panel-chat turns, which the panel layer persists). */
  eventRouter: EventRouter | null;
  logger?: Logger;
}

export type DemoScript = (ctx: DemoScriptContext) => Promise<void>;

export class DemoScriptContext {
  private readonly narrowing = new TypedEventNarrowing();
  private messageCounter = 0;

  constructor(private readonly args: DemoScriptArgs) {}

  get runId(): string {
    return this.args.runId;
  }

  get worktreePath(): string {
    return this.args.worktreePath;
  }

  get prompt(): string {
    return this.args.prompt;
  }

  get db(): Database.Database {
    return this.args.db;
  }

  // -------------------------------------------------------------------------
  // Timing
  // -------------------------------------------------------------------------

  /** Abort-aware sleep — rejects with DemoScriptAborted when the run is killed. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.args.signal.aborted) {
        reject(new DemoScriptAborted());
        return;
      }
      const timer = setTimeout(() => {
        this.args.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DemoScriptAborted());
      };
      this.args.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Throw DemoScriptAborted if the run was aborted — checkpoints between effects. */
  checkpoint(): void {
    if (this.args.signal.aborted) throw new DemoScriptAborted();
  }

  // -------------------------------------------------------------------------
  // Transcript
  // -------------------------------------------------------------------------

  /** Emit an assistant text message. */
  say(text: string): void {
    this.emitStreamEvent({
      type: 'assistant',
      message: {
        id: this.nextMessageId(),
        model: 'demo',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      session_id: this.args.sessionId,
    });
  }

  /** Emit an assistant thinking block. */
  think(text: string): void {
    this.emitStreamEvent({
      type: 'assistant',
      message: {
        id: this.nextMessageId(),
        model: 'demo',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: text }],
      },
      session_id: this.args.sessionId,
    });
  }

  /**
   * Emit a tool_use + matching tool_result pair (renders as a folded tool call
   * in ChatTranscript). Returns the tool_use id.
   */
  tool(name: string, input: Record<string, unknown>, result: string): string {
    const toolUseId = `demo-tool-${randomUUID().slice(0, 8)}`;
    this.emitStreamEvent({
      type: 'assistant',
      message: {
        id: this.nextMessageId(),
        model: 'demo',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name, input }],
      },
      session_id: this.args.sessionId,
    });
    this.emitStreamEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
      },
      session_id: this.args.sessionId,
    });
    return toolUseId;
  }

  /**
   * Emit a raw Claude-stream-shaped JSON event: narrow → persist (when a
   * pipeline exists) → emit 'output' for the renderer bridge / panel layer.
   */
  emitStreamEvent(event: Record<string, unknown>): void {
    this.checkpoint();
    if (this.args.eventRouter) {
      const typed = this.narrowing.narrow(event);
      try {
        this.args.eventRouter.emitForRun(this.args.runId, typed);
      } catch (err) {
        this.args.logger?.warn(
          `[DemoScriptContext] eventRouter.emitForRun failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.args.emitter.emit('output', {
      panelId: this.args.panelId,
      sessionId: this.args.sessionId,
      type: 'json',
      data: event,
      timestamp: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // Workflow progress
  // -------------------------------------------------------------------------

  /** Record + broadcast the run's current workflow step (FlowProgress panel). */
  reportStep(stepId: string, status: 'pending' | 'running' | 'done' = 'running'): void {
    this.checkpoint();
    // Raw better-sqlite3 satisfies DatabaseLike structurally (prepare/transaction).
    buildStepTransitionEvent(this.args.runId, stepId, status, this.args.db);
  }

  // -------------------------------------------------------------------------
  // Human gates — each blocks the script exactly like a live agent
  // -------------------------------------------------------------------------

  /**
   * Permission gate: pauses the run until the user approves/rejects in the
   * review queue. Returns true when allowed.
   */
  async requestPermission(toolName: string, input: Record<string, unknown>): Promise<boolean> {
    this.checkpoint();
    const decision = await ApprovalRouter.getInstance().requestApproval(
      this.args.runId,
      toolName,
      input,
      () => {},
    );
    this.checkpoint();
    return decision.behavior === 'allow';
  }

  /**
   * AskUserQuestion gate: emits the tool_use block (so the inline card renders
   * in the transcript) and blocks until the user answers.
   */
  async askQuestion(questions: QuestionPayload[]): Promise<QuestionAnswer> {
    this.checkpoint();
    const toolUseId = `demo-ask-${randomUUID().slice(0, 8)}`;
    this.emitStreamEvent({
      type: 'assistant',
      message: {
        id: this.nextMessageId(),
        model: 'demo',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions } }],
      },
      session_id: this.args.sessionId,
    });
    const answer = await QuestionRouter.getInstance().requestQuestion(
      this.args.runId,
      toolUseId,
      questions,
      () => {},
    );
    this.checkpoint();
    // Close the tool call in the transcript with the chosen answers.
    this.emitStreamEvent({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(answer.answers) }],
      },
      session_id: this.args.sessionId,
    });
    return answer;
  }

  /**
   * Human workflow-step gate (e.g. planner approve-plan): opens a blocking
   * decision review item and waits until the user resolves it (the run
   * auto-resumes via HumanStepManager.resolveHumanGate / aggregate-unblock).
   */
  async humanGate(stepId: string, stepName: string): Promise<void> {
    this.checkpoint();
    await HumanStepManager.getInstance().openHumanGate(this.args.runId, stepId, stepName);
    await this.waitUntilRunning();
  }

  /**
   * Poll workflow_runs.status until the run is back to 'running' (a gate was
   * resolved). Throws DemoScriptAborted when the run goes terminal.
   */
  async waitUntilRunning(pollMs = 400): Promise<void> {
    for (;;) {
      this.checkpoint();
      const row = this.args.db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(this.args.runId) as { status?: string } | undefined;
      const status = row?.status;
      if (status === 'running') return;
      if (!status || status === 'canceled' || status === 'failed' || status === 'completed') {
        throw new DemoScriptAborted();
      }
      await this.sleep(pollMs);
    }
  }

  // -------------------------------------------------------------------------
  // Review inbox + sprint lanes
  // -------------------------------------------------------------------------

  /** Create a review item (finding / human_task / …) through the chokepoint. */
  async createReviewItem(change: Omit<ReviewItemCreate, 'op' | 'actor' | 'runId'>): Promise<void> {
    this.checkpoint();
    const projectId = this.resolveProjectId();
    await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
      ...change,
      op: 'create',
      actor: 'agent:demo',
      runId: this.args.runId,
    });
  }

  /** Update a sprint lane through the SprintLaneStore chokepoint. */
  updateLane(args: {
    batchId: string;
    taskId: string;
    status?: SprintBatchTaskStatus;
    currentStepId?: string | null;
    attempt?: number;
  }): void {
    this.checkpoint();
    SprintLaneStore.getInstance().updateLane({ runId: this.args.runId, ...args });
  }

  // -------------------------------------------------------------------------
  // Worktree effects — real files, real commits
  // -------------------------------------------------------------------------

  /** Write a file inside the run's worktree (creating parent dirs). */
  writeFile(relPath: string, content: string): void {
    this.checkpoint();
    const abs = path.join(this.args.worktreePath, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /** Read a file from the worktree ('' when absent). */
  readFile(relPath: string): string {
    const abs = path.join(this.args.worktreePath, relPath);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
  }

  /** Stage everything and commit in the worktree. */
  commit(message: string): void {
    this.checkpoint();
    const cwd = this.args.worktreePath;
    execSync('git add -A', { cwd, stdio: 'pipe' });
    execSync(
      `git -c user.name="Cyboflow Demo" -c user.email="demo@cyboflow.dev" -c commit.gpgsign=false commit -m ${JSON.stringify(message)}`,
      { cwd, stdio: 'pipe' },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private nextMessageId(): string {
    this.messageCounter += 1;
    return `demo-msg-${this.args.runId.slice(0, 8)}-${this.messageCounter}`;
  }

  private resolveProjectId(): number {
    const row = this.args.db
      .prepare(
        `SELECT w.project_id AS projectId
           FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(this.args.runId) as { projectId?: number } | undefined;
    if (typeof row?.projectId !== 'number') {
      throw new Error(`[DemoScriptContext] cannot resolve project for run ${this.args.runId}`);
    }
    return row.projectId;
  }
}
