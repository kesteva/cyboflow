import type { App, BrowserWindow } from 'electron';
import type { TaskQueue } from '../services/taskQueue';
import type { SessionManager } from '../services/sessionManager';
import type { ConfigManager } from '../services/configManager';
import type { WorktreeManager } from '../services/worktreeManager';
import type { GitDiffManager } from '../services/gitDiffManager';
import type { GitStatusManager } from '../services/gitStatusManager';
import type { ExecutionTracker } from '../services/executionTracker';
import type { DatabaseService } from '../database/database';
import type { RunCommandManager } from '../services/runCommandManager';
import type { ClaudeCodeManager } from '../services/panels/claude/claudeCodeManager';
import type { InteractiveClaudeManager } from '../services/panels/claude/interactiveClaudeManager';
import type { CliManagerFactory } from '../services/cliManagerFactory';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import type { Logger } from '../utils/logger';
import type { ArchiveProgressManager } from '../services/archiveProgressManager';
import type { WorkflowRegistry } from '../orchestrator/workflowRegistry';
import type { RunLauncher } from '../orchestrator/runLauncher';

export interface AppServices {
  app: App;
  configManager: ConfigManager;
  databaseService: DatabaseService;
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
  cliManagerFactory: CliManagerFactory;
  claudeCodeManager: AbstractCliManager; // Now uses abstract base class
  /**
   * The PTY-substrate sibling of claudeCodeManager (IDEA-030 quick sessions).
   * Typed CONCRETE (not AbstractCliManager) so the persistent-REPL seams —
   * relayUserTurn / endSession — are visible to the sessions:input relay branch
   * and the create-quick eager spawn. Safe: a type-only import, and
   * interactiveClaudeManager.ts imports nothing from ipc/ (no cycle).
   */
  interactiveCliManager: InteractiveClaudeManager;
  /**
   * Live-session close-out seams for QUICK sessions (mirrors the RelayDeps
   * closures wired in index.ts). Both take the session's sentinel `__quick__`
   * runId. Interactive: the SubstrateDispatchFacade translates it to the live
   * panelId; `endLiveSession` writes the graceful EOF/`/exit` (merge/rebase:
   * claude is idle and reads it); `killLiveSession` hard-kills the process tree
   * (dismiss/archive: claude may be mid-turn and never read PTY stdin). SDK:
   * both route to the manager's killProcess so a WARM persistent query() does
   * not outlive close-out. Callers must treat both as fail-soft.
   */
  endLiveSession: (runId: string) => Promise<void>;
  killLiveSession: (runId: string) => Promise<void>;
  /**
   * Deterministic at-spawn registration of a PTY quick session's
   * runId→panelId translation on the SubstrateDispatchFacade
   * (registerInteractivePanel). The facade's event-fed mapping
   * ('pty-output'/'turn-end') only exists after the first PTY byte, so the
   * spawn sites (sessions:create-quick eager spawn, sessions:input dead-REPL
   * re-spawn) call this immediately BEFORE the fire-and-forget startPanel —
   * otherwise a relay/close-out racing the first byte falls back to the
   * sentinel runId and throws "No claude process found". Idempotent.
   */
  registerLivePanel: (runId: string, panelId: string) => void;
  gitDiffManager: GitDiffManager;
  gitStatusManager: GitStatusManager;
  executionTracker: ExecutionTracker;
  runCommandManager: RunCommandManager;
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  logger?: Logger;
  archiveProgressManager?: ArchiveProgressManager;
  cyboflow: {
    workflowRegistry: WorkflowRegistry;
    runLauncher: RunLauncher;
    /**
     * Cancel every NON-terminal workflow run hosted on the session (git-neutral
     * — same path as runs.cancel: stops the live agent, settles pending
     * approvals/questions, closes a sprint run's lane batch). Called by the
     * sessions:delete (Dismiss) handler BEFORE archiving so dismissing a session
     * never strands a live run in the rail / review queue.
     */
    cancelHostedRuns: (sessionId: string) => Promise<void>;
  };
} 