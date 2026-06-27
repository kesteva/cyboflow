// Type definitions for Electron preload API
import type { Session, SessionOutput, GitStatus, GitCommands } from './session';
import type { Project } from './project';
import type { Folder } from './folder';
import type { SessionCreationPreferences } from '../stores/sessionPreferencesStore';
import type { ToolPanel } from '../../../shared/types/panels';
import type { CreateSessionRequest } from './session';
import type { AppConfig } from './config';
import type { ExecutionDiff, GitDiffResult } from './diff';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';
import type { UpdaterEvent, UpdateCheckResult } from '../../../shared/types/updater';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

interface PermissionResponse {
  allow: boolean;
  reason?: string;
}

/**
 * Resume eligibility for an interactive (PTY) quick session whose REPL was lost
 * (app close/restart). Returned by sessions.getInteractiveResumeState. The UI
 * offers "Resume previous session" when the session is interactive AND
 * !replRunning AND claudeSessionId AND worktreeExists.
 */
interface InteractiveResumeState {
  /** Whether the session's interactive REPL process is currently alive. */
  replRunning: boolean;
  /** Persisted Claude conversation id to resume with, or null if none. */
  claudeSessionId: string | null;
  /** Whether the session's worktree still exists on disk (resume needs it). */
  worktreeExists: boolean;
}

// T defaults to `unknown` (not `any`) so callers must narrow before reading .data.
// This enforces the type-contract at each IPC call site and prevents silent regressions
// on field renames (e.g. the crystalDirectory → cyboflowDirectory incident).
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
  /**
   * Set by the merge handlers when the merge was BLOCKED because main has
   * advanced past the branch (a rebase is needed first). Keep in sync with the
   * dual declaration in frontend/src/utils/api.ts.
   */
  needsRebase?: boolean;
}

// IPCDataResponse<T> is like IPCResponse<T> but with data required (non-optional).
// Use for IPC channels that always return data on success and whose callers access
// .data fields directly after an `if (result.success)` check.
type IPCDataResponse<T> = Omit<IPCResponse<T>, 'data'> & { data: T };

interface ElectronAPI {
  // Generic invoke method for direct IPC calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic IPC bridge that returns different types based on channel
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;

  // Basic app info
  getAppVersion: () => Promise<string>;
  isPackaged: () => Promise<boolean>;

  // Version info — use IPCDataResponse so callers can access .data fields directly
  // after `if (result.success)` without narrowing for undefined.
  getVersionInfo: () => Promise<IPCDataResponse<{
    current: string;
    workingDirectory?: string;
    cyboflowDirectory?: string;
    buildDate?: string;
    gitCommit?: string;
    buildTimestamp?: number;
    worktreeName?: string;
    variant?: 'stable' | 'dev';
  }>>;

  // In-app auto-updater (electron-updater → updates.cyboflow.com).
  // KEEP IN SYNC with main/src/preload.ts `updater` + the updater IPC handlers.
  updater: {
    check: () => Promise<IPCResponse<UpdateCheckResult>>;
    download: () => Promise<IPCResponse<void>>;
    install: () => Promise<IPCResponse<void>>;
    onEvent: (callback: (event: UpdaterEvent) => void) => () => void;
  };

  // System utilities
  openExternal: (url: string) => Promise<void>;

  // Relaunch the app (demo-mode toggle applies on next boot)
  relaunch: () => Promise<void>;

  // Session management
  sessions: {
    getAll: () => Promise<IPCResponse<Session[]>>;
    // getAllWithProjects returns ProjectWithSessions[] (Project + sessions + folders),
    // but that type is locally defined in DraggableProjectTreeView.
    // Typed as unknown[] here; callers cast to their local interface.
    getAllWithProjects: () => Promise<IPCResponse<unknown[]>>;
    get: (sessionId: string) => Promise<IPCResponse<Session>>;
    create: (request: CreateSessionRequest) => Promise<IPCResponse<Session>>;
    // claudePanelId is present only when the server eagerly created the claude
    // panel (interactive-substrate sessions spawn the PTY REPL during create-quick);
    // callers must then SKIP their own claude createPanel. KEEP IN SYNC with the
    // sessions:create-quick handler (IPC handler ↔ declared T parity rule).
    createQuick: (request: CreateSessionRequest) => Promise<IPCResponse<{ jobId: string; sessionId: string; worktreePath: string; runId: string; claudePanelId?: string }>>;
    delete: (sessionId: string) => Promise<IPCResponse<void>>;
    sendInput: (sessionId: string, input: string) => Promise<IPCResponse<void>>;
    continue: (sessionId: string, prompt?: string, model?: string) => Promise<IPCResponse<void>>;
    getInteractiveResumeState: (sessionId: string) => Promise<IPCResponse<InteractiveResumeState>>;
    resumeInteractive: (sessionId: string) => Promise<IPCResponse<void>>;
    // getOutput returns SessionOutput[] (not raw strings); callers pass to setSessionOutputs
    getOutput: (sessionId: string, limit?: number) => Promise<IPCDataResponse<SessionOutput[]>>;
    // getStatistics is locally typed in SessionStats.tsx; use IPCDataResponse so caller can access .data
    getStatistics: (sessionId: string) => Promise<IPCDataResponse<unknown>>;
    getConversation: (sessionId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    getConversationMessages: (sessionId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    generateCompactedContext: (sessionId: string) => Promise<IPCDataResponse<{ summary: string }>>;
    markViewed: (sessionId: string) => Promise<IPCResponse<void>>;
    stop: (sessionId: string) => Promise<IPCResponse<void>>;

    // Execution and Git operations
    getExecutions: (sessionId: string) => Promise<IPCResponse<ExecutionDiff[]>>;
    getExecutionDiff: (sessionId: string, executionId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    gitCommit: (sessionId: string, message: string) => Promise<IPCResponse<void>>;
    gitDiff: (sessionId: string) => Promise<IPCResponse<GitDiffResult>>;
    getCombinedDiff: (sessionId: string, executionIds?: number[]) => Promise<IPCDataResponse<GitDiffResult>>;

    // Script operations
    // IPCDataResponse so callers can use response.data directly after success check
    hasRunScript: (sessionId: string) => Promise<IPCDataResponse<boolean>>;
    getRunningSession: () => Promise<IPCResponse<string | null>>;
    runScript: (sessionId: string) => Promise<IPCResponse<void>>;
    stopScript: (sessionId?: string) => Promise<IPCResponse<void>>;
    runTerminalCommand: (sessionId: string, command: string) => Promise<IPCResponse<void>>;
    sendTerminalInput: (sessionId: string, data: string) => Promise<IPCResponse<void>>;
    preCreateTerminal: (sessionId: string) => Promise<IPCResponse<void>>;
    resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<IPCResponse<void>>;

    // Prompt operations — PromptMarker is locally typed; IPCDataResponse for direct .data access
    getPrompts: (sessionId: string) => Promise<IPCDataResponse<unknown[]>>;

    // Git merge operations
    mergeMainToWorktree: (sessionId: string) => Promise<IPCResponse<void>>;
    mergeWorktreeToMain: (sessionId: string) => Promise<IPCResponse<void>>;

    // Git rebase operations
    rebaseMainIntoWorktree: (sessionId: string) => Promise<IPCResponse<void>>;
    abortRebaseAndUseClaude: (sessionId: string) => Promise<IPCResponse<void>>;
    squashAndRebaseToMain: (sessionId: string, commitMessage: string) => Promise<IPCResponse<void>>;
    rebaseToMain: (sessionId: string) => Promise<IPCResponse<void>>;
    // IPCDataResponse so callers can use response.data directly after success check
    hasChangesToRebase: (sessionId: string) => Promise<IPCDataResponse<boolean>>;
    getGitCommands: (sessionId: string) => Promise<IPCDataResponse<GitCommands>>;
    getRemoteUrl: (sessionId: string) => Promise<IPCDataResponse<{ remoteUrl: string; branchName: string }>>;
    rename: (sessionId: string, newName: string) => Promise<IPCResponse<void>>;
    toggleFavorite: (sessionId: string) => Promise<IPCResponse<void>>;
    toggleAutoCommit: (sessionId: string) => Promise<IPCResponse<void>>;
    updateAgentPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<IPCResponse<void>>;
    updateSessionMcps: (sessionId: string, disabledMcpServers: string[]) => Promise<IPCResponse<void>>;
    updateSessionPlugins: (sessionId: string, enabledPlugins: string[]) => Promise<IPCResponse<void>>;

    // Main repo session
    getOrCreateMainRepoSession: (projectId: number) => Promise<IPCResponse<Session>>;

    // Git pull/push operations
    gitPull: (sessionId: string) => Promise<IPCResponse<void>>;
    gitPush: (sessionId: string) => Promise<IPCResponse<void>>;
    getGitStatus: (sessionId: string, nonBlocking?: boolean, isInitialLoad?: boolean) => Promise<IPCResponse<GitStatus>>;
    getLastCommits: (sessionId: string, count: number) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    // Subjects of the session branch's own commits (main..HEAD), newest first
    getBranchCommitSubjects: (sessionId: string) => Promise<IPCResponse<{ subjects: string[] }>>;

    // IDE operations
    openIDE: (sessionId: string) => Promise<IPCResponse<void>>;

    // Reorder operations
    reorder: (sessionOrders: Array<{ id: string; displayOrder: number }>) => Promise<IPCResponse<void>>;

    // Image operations
    saveImages: (sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>) => Promise<string[]>;

    // Log operations
    getLogs: (sessionId: string) => Promise<IPCResponse<LogEntry[]>>;
    clearLogs: (sessionId: string) => Promise<IPCResponse<void>>;
    addLog: (sessionId: string, entry: LogEntry) => Promise<IPCResponse<void>>;

    // Large text operations
    saveLargeText: (sessionId: string, text: string) => Promise<string>;
  };

  // Idea image attachments (migration 028) — raw file IO (not IPCResponse).
  ideas: {
    saveAttachments: (
      ownerKey: string,
      images: Array<{ name: string; dataUrl: string; type: string }>,
    ) => Promise<Array<{ id: string; name: string; path: string; type: string; size: number }>>;
    loadAttachments: (paths: string[]) => Promise<Array<{ path: string; dataUrl: string }>>;
  };

  // Run-scoped artifact images (screenshots gallery) — reads PNG/JPG written under
  // CYBOFLOW_DIR/artifacts/runs/<runId>/ and returns base64 data: URLs (IPCResponse).
  artifacts: {
    loadImages: (
      req: { runId: string; fileNames: string[] },
    ) => Promise<IPCResponse<{ images: Array<{ fileName: string; dataUrl: string }> }>>;
  };

  // Project management
  projects: {
    // IPCDataResponse so callers can do response.data.find(...) directly after success check
    getAll: () => Promise<IPCDataResponse<Project[]>>;
    getActive: () => Promise<IPCResponse<Project | null>>;
    create: (projectData: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => Promise<IPCResponse<Project>>;
    activate: (projectId: string) => Promise<IPCResponse<void>>;
    update: (projectId: string, updates: Partial<Project>) => Promise<IPCResponse<void>>;
    delete: (projectId: string) => Promise<IPCResponse<void>>;
    detectBranch: (path: string) => Promise<IPCResponse<string>>;
    reorder: (projectOrders: Array<{ id: number; displayOrder: number }>) => Promise<IPCResponse<void>>;
    listBranches: (projectId: string) => Promise<IPCResponse<{ name: string; isCurrent: boolean; hasWorktree: boolean }[]>>;
    refreshGitStatus: (projectId: number) => Promise<IPCResponse<void>>;
    runScript: (projectId: number) => Promise<IPCResponse<{ sessionId: string }>>;
    getRunningScript: () => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    stopScript: (projectId?: number) => Promise<IPCResponse<void>>;
  };

  // Git operations
  git: {
    detectBranch: (path: string) => Promise<IPCResponse<string>>;
    cancelStatusForProject: (projectId: number) => Promise<{ success: boolean; error?: string }>;
    executeProject: (projectId: number, args: string[]) => Promise<IPCResponse<string>>;
  };

  // Folders
  folders: {
    getByProject: (projectId: number) => Promise<IPCResponse<Folder[]>>;
    create: (name: string, projectId: number, parentFolderId?: string | null) => Promise<IPCResponse<Folder>>;
    update: (folderId: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }) => Promise<IPCResponse<void>>;
    delete: (folderId: string) => Promise<IPCResponse<void>>;
    reorder: (projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>) => Promise<IPCResponse<void>>;
    moveSession: (sessionId: string, folderId: string | null) => Promise<IPCResponse<void>>;
    move: (folderId: string, parentFolderId: string | null) => Promise<IPCResponse<void>>;
  };

  // Configuration — IPCDataResponse so callers can access .data fields directly after success check
  // Demo-mode tour info (sandbox repo to prefill in the Create Project dialog)
  demo: {
    getInfo: () => Promise<IPCDataResponse<{ demoMode: boolean; sandboxPath: string | null; projectName: string }>>;
  };

  config: {
    get: () => Promise<IPCDataResponse<AppConfig>>;
    update: (updates: Record<string, unknown>) => Promise<IPCResponse<void>>;
    getSessionPreferences: () => Promise<IPCResponse<SessionCreationPreferences>>;
    updateSessionPreferences: (preferences: SessionCreationPreferences) => Promise<IPCResponse<void>>;
  };

  // Telemetry — fire-and-forget renderer → main usage tracking (returns void, never throws).
  // isSentryActive is a synchronous boot-time check so the renderer only inits its
  // Sentry SDK when main's `sentry-ipc://` transport actually exists.
  telemetry: {
    track(eventName: string, properties?: Record<string, string | number | boolean>): void;
    isSentryActive(): boolean;
  };

  // Prompts — IPCDataResponse so callers can use response.data directly after success check
  prompts: {
    getAll: () => Promise<IPCDataResponse<unknown[]>>;
  };

  // File operations
  file: {
    listProject: (projectId: number, path?: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    readProject: (projectId: number, filePath: string) => Promise<IPCResponse<string | null>>;
    writeProject: (projectId: number, filePath: string, content: string) => Promise<IPCResponse<void>>;
  };

  // Dialog
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<IPCResponse<string | null>>;
    openDirectory: (options?: Electron.OpenDialogOptions) => Promise<IPCResponse<string | null>>;
  };

  // Permissions
  permissions: {
    respond: (requestId: string, response: PermissionResponse) => Promise<IPCResponse<void>>;
    getPending: () => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
  };

  // Dashboard — ProjectDashboardData is locally typed in ProjectDashboard.tsx; IPCDataResponse for direct .data access
  dashboard: {
    getProjectStatus: (projectId: number) => Promise<IPCDataResponse<unknown>>;
    getProjectStatusProgressive: (projectId: number) => Promise<IPCDataResponse<unknown>>; // Caller does not consume .data directly
    onUpdate: (callback: (data: Record<string, unknown>) => void) => () => void;
    onSessionUpdate: (callback: (data: { type: string; projectId?: number; sessionId?: string; data: unknown }) => void) => () => void;
  };

  // UI State management
  uiState: {
    getExpanded: () => Promise<IPCResponse<{ expandedProjects: number[]; expandedFolders: string[] }>>;
    saveExpanded: (projectIds: number[], folderIds: string[]) => Promise<IPCResponse<void>>;
    saveExpandedProjects: (projectIds: number[]) => Promise<IPCResponse<void>>;
    saveExpandedFolders: (folderIds: string[]) => Promise<IPCResponse<void>>;
  };

  // Event listeners for real-time updates
  events: {
    onSessionCreated: (callback: (session: Session) => void) => () => void;
    onSessionUpdated: (callback: (session: Session) => void) => () => void;
    onSessionDeleted: (callback: (session: Session) => void) => () => void;
    onSessionsLoaded: (callback: (sessions: Session[]) => void) => () => void;
    onSessionOutput: (callback: (output: SessionOutput) => void) => () => void;
    onSessionLog: (callback: (data: { sessionId: string; entry: LogEntry }) => void) => () => void;
    onSessionLogsCleared: (callback: (data: { sessionId: string }) => void) => () => void;
    onSessionOutputAvailable: (callback: (info: { sessionId: string; hasNewOutput: boolean }) => void) => () => void;
    onGitStatusUpdated: (callback: (data: { sessionId: string; gitStatus: GitStatus }) => void) => () => void;
    onGitStatusLoading: (callback: (data: { sessionId: string }) => void) => () => void;
    onGitStatusLoadingBatch?: (callback: (sessionIds: string[]) => void) => () => void;
    onGitStatusUpdatedBatch?: (callback: (updates: Array<{ sessionId: string; status: GitStatus }>) => void) => () => void;

    // Project events
    onProjectUpdated: (callback: (project: Project) => void) => () => void;

    // Folder events
    onFolderCreated: (callback: (folder: Folder) => void) => () => void;
    onFolderUpdated: (callback: (folder: Folder) => void) => () => void;
    onFolderDeleted: (callback: (folderId: string) => void) => () => void;

    // Panel events
    onPanelCreated: (callback: (panel: ToolPanel) => void) => () => void;
    onPanelUpdated: (callback: (panel: ToolPanel) => void) => () => void;
    onPanelPromptAdded: (callback: (data: { panelId: string; content: string }) => void) => () => void;
    onPanelResponseAdded: (callback: (data: { panelId: string; content: string }) => void) => () => void;

    onTerminalOutput: (callback: (output: { sessionId: string; data: string; type: 'stdout' | 'stderr' }) => void) => () => void;
    onMainLog: (callback: (level: string, message: string) => void) => () => void;

    // Process management events
    onZombieProcessesDetected: (callback: (data: { sessionId?: string | null; pids?: number[]; message: string }) => void) => () => void;

    removeAllListeners: (channel: string) => void;
  };

  // Panel operations
  panels: {
    getSessionPanels: (sessionId: string) => Promise<IPCResponse<ToolPanel[]>>;
    createPanel: (sessionId: string, type: string, name: string, config?: Record<string, unknown>) => Promise<IPCResponse<ToolPanel>>;
    deletePanel: (panelId: string) => Promise<IPCResponse<void>>;
    renamePanel: (panelId: string, name: string) => Promise<IPCResponse<void>>;
    setActivePanel: (sessionId: string, panelId: string) => Promise<IPCResponse<void>>;
    sendInput: (panelId: string, input: string, images?: Array<{ name: string; dataUrl: string; type: string }>) => Promise<IPCResponse<void>>;
    // getOutput returns SessionOutput[] — IPCDataResponse so callers can pass directly to setSessionOutputs
    getOutput: (panelId: string, limit?: number) => Promise<IPCDataResponse<SessionOutput[]>>;
    getConversationMessages: (panelId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    getJsonMessages: (panelId: string) => Promise<IPCResponse<UnifiedMessage[]>>;
    // PromptMarker is locally typed; IPCDataResponse for direct .data access
    getPrompts: (panelId: string) => Promise<IPCDataResponse<unknown[]>>;
    continue: (panelId: string, input: string, model?: string) => Promise<IPCResponse<void>>;
    stop: (panelId: string) => Promise<IPCResponse<void>>;
    resizeTerminal: (panelId: string, cols: number, rows: number) => Promise<IPCResponse<void>>;
    sendTerminalInput: (panelId: string, data: string) => Promise<IPCResponse<void>>;
  };

  // Claude Panels - specific API for Claude panels
  claudePanels: {
    getModel: (panelId: string) => Promise<IPCResponse<string>>;
    setModel: (panelId: string, model: string) => Promise<IPCResponse<void>>;
    setFastMode: (panelId: string, fastMode: boolean) => Promise<IPCResponse<void>>;
    getFastMode: (panelId: string) => Promise<IPCResponse<boolean>>;
  };

  // Logs panel operations
  logs: {
    runScript: (sessionId: string, command: string, cwd: string) => Promise<IPCResponse<void>>;
    stopScript: (panelId: string) => Promise<IPCResponse<void>>;
    isRunning: (sessionId: string) => Promise<IPCResponse<boolean>>;
  };

  // Debug utilities
  debug: {
    getTableStructure: (tableName: 'folders' | 'sessions') => Promise<IPCResponse<{
      columns: Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | number | boolean | null;
        pk: number;
      }>;
      foreignKeys: Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>;
      indexes: Array<{
        name: string;
        tbl_name: string;
        sql: string;
      }>;
    }>>;
  };

  // Nimbalyst integration
  nimbalyst: {
    checkInstalled: () => Promise<IPCResponse<boolean>>;
    openWorktree: (worktreePath: string) => Promise<IPCResponse<void>>;
  };
}

// Additional electron interface for IPC event listeners
interface ElectronInterface {
  openExternal: (url: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic IPC bridge that returns different types based on channel
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic IPC event callback that receives different argument types
  on: (channel: string, callback: (...args: any[]) => void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic IPC event callback that receives different argument types
  off: (channel: string, callback: (...args: any[]) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    electron?: ElectronInterface;
  }
}

export {};
