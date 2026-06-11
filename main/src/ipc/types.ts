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