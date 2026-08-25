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
import type { ClaudeModelCatalogService } from '../services/claudeModelCatalogService';
import type { OmpSessionManager } from '../orchestrator/omp/ompSessionManager';
import type {
  CliManagerFactory,
  CodexPtyManagerLike,
  CodexSdkManagerLike,
  OmpPtyManagerLike,
  OmpSdkManagerLike,
} from '../services/cliManagerFactory';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import type { Logger } from '../utils/logger';
import type { ArchiveProgressManager } from '../services/archiveProgressManager';
import type { WorkflowRegistry } from '../orchestrator/workflowRegistry';
import type { RunLauncher } from '../orchestrator/runLauncher';
import type { SessionSummarySchedulerLike } from '../orchestrator/sessionSummary/sessionSummaryScheduler';
import type { ChatSentinelProvider } from '../orchestrator/chatSentinelProvider';

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
   * Structured Codex app-server runtime for quick-session chat and future
   * workflows. Typed by SEAM rather than by class so demo mode can supply a
   * demo-backed manager without impersonating the concrete one; the real
   * CodexSdkManager satisfies it unchanged.
   */
  codexSdkManager: CodexSdkManagerLike;
  /** Interactive Codex PTY runtime for quick sessions only. Seam-typed — see above. */
  codexPtyManager: CodexPtyManagerLike;
  /**
   * Structured OMP (oh-my-pi) RPC runtime for quick-session chat. Seam-typed for
   * the same reason as its Codex twin — demo mode supplies a demo-backed manager
   * carrying only the seams, never the concrete class.
   */
  ompSdkManager: OmpSdkManagerLike;
  /** Interactive OMP PTY runtime for quick sessions only. Seam-typed — see above. */
  ompPtyManager: OmpPtyManagerLike;
  /**
   * OMP fleet runtime (Phase 4 coexistence, omp-phase4-coexistence-adr.md). A
   * SIBLING to the process managers — a remote worker supervised over the Prime
   * bridge, no local child. Fail-closed: present ONLY when the bridge command
   * config resolved at boot; `undefined` means OMP is not launchable and the
   * dispatch + picker omit it entirely (never a silent fallback to a local
   * provider).
   */
  ompSessionManager?: OmpSessionManager;
  /** Dynamic Claude model catalog (SDK `supportedModels()`), for the picker's "Other models" section. */
  claudeModelCatalogService: ClaudeModelCatalogService;
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
  /** Deterministic at-spawn registration for Codex PTY quick-session panels. */
  registerCodexPtyPanel: (runId: string, panelId: string) => void;
  /** Deterministic at-spawn registration for OMP PTY quick-session panels. */
  registerOmpPtyPanel: (runId: string, panelId: string) => void;
  /**
   * Idle-debounced quick-session summarizer (session-summary-plan.md §5). The
   * sessions:input handler calls `noteTurnStart` before dispatching a user turn
   * (the PTY relay input-seam clear, §2.2 — the PTY substrate emits no 'spawned'
   * for composer turns); the sessions:get-summary read fires the lazy catch-up
   * kick (§2.7). Optional so the IPC test harnesses that build a partial
   * AppServices need not stub it.
   */
  sessionSummaryScheduler?: SessionSummarySchedulerLike;
  /**
   * Chat-gate sentinel resolver (orchestrator/chatSentinelProvider). The CLAUDE
   * lanes reach it through their managers' injected `resolveGateRunId`; the CODEX
   * lanes spawn from the IPC layer with a caller-supplied runId, so they resolve
   * it HERE instead. Both must, because the provider is what REVIVES a `__quick__`
   * sentinel that boot recovery force-failed on app restart
   * (`error_message='app_restart'`) — a raw `chat_run_id` read hands the spawn a
   * terminal run, and then every run-scoped MCP write rejects with
   * `run_not_active` and every approval-gate grab
   * (`UPDATE … WHERE status='running'`) silently misses.
   *
   * Optional so the IPC test harnesses that build a partial AppServices need not
   * stub it; the Codex seams fall back to the raw read exactly like
   * `resolveGateRunId`'s uninjected arm. Production always injects it.
   */
  chatSentinelProvider?: ChatSentinelProvider;
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
