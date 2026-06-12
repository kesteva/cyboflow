/**
 * DemoCliManager — the scripted agent substrate for demo mode.
 *
 * When config.demoMode is on, CliManagerFactory returns this manager for EVERY
 * CLI tool id ('claude', 'claude-interactive', …), so both the orchestrator
 * spawn path (RunExecutor → SubstrateDispatchFacade → spawnCliProcess) and the
 * panel-chat path (ClaudePanelManager → startPanel/continuePanel) play canned
 * scripts instead of spawning Claude. Everything downstream is the REAL
 * pipeline: the scripts emit Claude-stream-shaped 'output' events (persisted to
 * raw_events via the manager-owned EventRouter/RawEventsSink, exactly like
 * ClaudeCodeManager — RunExecutor's bridge runs with skipPersistence:true) and
 * drive the real gate routers, so the UI behaves identically to a live run.
 *
 * spawnCliProcess resolves when the script finishes (the RunExecutor 'drained'
 * contract) and killProcess aborts the script (cancel / pause / dismiss).
 */

import type Database from 'better-sqlite3';
import { AbstractCliManager } from '../panels/cli/AbstractCliManager';
import type { SessionManager } from '../sessionManager';
import type { Logger } from '../../utils/logger';
import type { ConfigManager } from '../configManager';
import type { ConversationMessage } from '../../database/models';
import { EventRouter, RawEventsSink } from '../streamParser';
import { ApprovalRouter } from '../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../orchestrator/questionRouter';
import { DemoScriptContext, DemoScriptAborted } from './demoScriptContext';
import type { DemoScript } from './demoScriptContext';
import { chatTurnScript } from './scripts/chatTurnScript';
import { plannerScript } from './scripts/plannerScript';
import { sprintScript } from './scripts/sprintScript';
import { genericRunScript } from './scripts/genericRunScript';

interface CliSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  isResume?: boolean;
  [key: string]: unknown;
}

interface ActiveScript {
  abortController: AbortController;
  done: Promise<void>;
}

export class DemoCliManager extends AbstractCliManager {
  private readonly activeScripts = new Map<string, ActiveScript>();

  constructor(
    sessionManager: SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
  ) {
    super(sessionManager, logger, configManager);
  }

  // ---------------------------------------------------------------------------
  // Workflow-run path (RunExecutor → SubstrateDispatchFacade)
  // ---------------------------------------------------------------------------

  override async spawnCliProcess(options: CliSpawnOptions): Promise<void> {
    const { panelId, sessionId, worktreePath, prompt } = options;

    if (this.activeScripts.has(panelId)) {
      throw new Error(`Demo script already running for panel ${panelId}`);
    }

    // panelId === runId on the orchestrator path; panel chat resolves the
    // session's sentinel run for raw_events/approval scoping (mirrors CCM).
    const sessionRow = this.sessionManager.getDbSession(sessionId);
    const runId = (sessionRow?.run_id as string | null) ?? panelId;

    const workflowName = this.resolveWorkflowName(panelId);
    const script = this.resolveScript(workflowName);

    // Manager-owned persistence pipeline (RunExecutor's bridge skips it).
    const eventRouter = new EventRouter();
    const sink = new RawEventsSink(this.db, this.logger);
    sink.attachToRouter(eventRouter, runId);

    const abortController = new AbortController();
    const ctx = new DemoScriptContext({
      panelId,
      sessionId,
      runId,
      worktreePath,
      prompt,
      signal: abortController.signal,
      db: this.db,
      emitter: this,
      eventRouter,
      logger: this.logger,
    });

    // Stub process record so isPanelRunning / getAllProcesses keep working.
    this.processes.set(panelId, {
      process: undefined as never,
      panelId,
      sessionId,
      worktreePath,
    });

    // session_info descriptor — renderer-visible context (mirrors CCM).
    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: {
        type: 'session_info',
        initial_prompt: prompt,
        claude_command: 'demo-script',
        worktree_path: worktreePath,
        model: 'demo',
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date(),
    });
    this.emit('spawned', { panelId, sessionId });

    let exitCode = 0;
    const done = (async () => {
      try {
        await script(ctx);
      } catch (err) {
        if (err instanceof DemoScriptAborted || abortController.signal.aborted) {
          this.logger?.info(`[DemoCliManager] script aborted for panel ${panelId}`);
        } else {
          exitCode = 1;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger?.error(`[DemoCliManager] script error for panel ${panelId}: ${msg}`);
          this.emit('error', { panelId, sessionId, error: msg });
        }
      } finally {
        sink.dispose(runId);
        ApprovalRouter.getInstance().clearPendingForRun(runId);
        QuestionRouter.getInstance().clearPendingForRun(runId);
        this.processes.delete(panelId);
        this.activeScripts.delete(panelId);
        this.emit('exit', { panelId, sessionId, exitCode, signal: null });
      }
    })();

    this.activeScripts.set(panelId, { abortController, done });

    // Resolve when the script finishes — RunExecutor treats this as 'drained'.
    await done;
  }

  override async killProcess(panelId: string): Promise<void> {
    const active = this.activeScripts.get(panelId);
    if (active) {
      active.abortController.abort();
      await active.done.catch(() => {});
    }
    this.processes.delete(panelId);
  }

  // ---------------------------------------------------------------------------
  // Panel-chat path (quick sessions)
  // ---------------------------------------------------------------------------

  async startPanel(panelId: string, sessionId: string, worktreePath: string, prompt: string): Promise<void> {
    return this.runChatTurn(panelId, sessionId, worktreePath, prompt);
  }

  async continuePanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    return this.runChatTurn(panelId, sessionId, worktreePath, prompt);
  }

  async stopPanel(panelId: string): Promise<void> {
    await this.killProcess(panelId);
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    await this.killProcess(panelId);
    return this.runChatTurn(panelId, sessionId, worktreePath, initialPrompt);
  }

  /**
   * A panel chat turn replays the chat script. Persistence to raw_events runs
   * under the session's sentinel run (resolved in spawnCliProcess), so the
   * unified-message transcript works for quick sessions too.
   */
  private async runChatTurn(panelId: string, sessionId: string, worktreePath: string, prompt: string): Promise<void> {
    if (this.activeScripts.has(panelId)) {
      await this.killProcess(panelId);
    }
    await this.spawnCliProcess({ panelId, sessionId, worktreePath, prompt });
  }

  // ---------------------------------------------------------------------------
  // Script resolution
  // ---------------------------------------------------------------------------

  /** Workflow name for an orchestrator run (panelId === runId); null for panel chat. */
  private resolveWorkflowName(panelId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT w.name AS name
           FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(panelId) as { name?: string } | undefined;
    return row?.name ?? null;
  }

  private resolveScript(workflowName: string | null): DemoScript {
    switch (workflowName) {
      case 'planner':
        return plannerScript;
      case 'sprint':
        return sprintScript;
      case null: // panel chat (no workflow_runs row keyed by panelId)
      case '__quick__':
        return chatTurnScript;
      default:
        return genericRunScript;
    }
  }

  // ---------------------------------------------------------------------------
  // AbstractCliManager plumbing — demo needs no real CLI
  // ---------------------------------------------------------------------------

  protected getCliToolName(): string {
    return 'Demo Agent';
  }

  protected async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: 'demo', path: 'demo' };
  }

  protected buildCommandArgs(_options: CliSpawnOptions): string[] {
    return [];
  }

  protected async getCliExecutablePath(): Promise<string> {
    return 'demo';
  }

  protected parseCliOutput(): never[] {
    return [];
  }

  protected async initializeCliEnvironment(_options: CliSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(_sessionId: string): Promise<void> {
    // Nothing to clean — scripts hold no external resources.
  }

  protected async getCliEnvironment(_options: CliSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }
}
