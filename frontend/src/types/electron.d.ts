// Type definitions for Electron preload API
import type { Session, SessionOutput, GitStatus, VersionUpdateInfo, ClaudeJsonMessage, GitCommands } from './session';
import type { Project } from './project';
import type { Folder } from './folder';
import type { SessionCreationPreferences } from '../stores/sessionPreferencesStore';
import type { ToolPanel } from '../../../shared/types/panels';
import type { CreateSessionRequest } from './session';
import type { AppConfig } from './config';
import type { ExecutionDiff, GitDiffResult } from './diff';

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

// T defaults to `unknown` (not `any`) so callers must narrow before reading .data.
// This enforces the type-contract at each IPC call site and prevents silent regressions
// on field renames (e.g. the crystalDirectory → cyboflowDirectory incident).
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
}

interface ElectronAPI {
  // Generic invoke method for direct IPC calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic IPC bridge that returns different types based on channel
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;

  // Basic app info
  getAppVersion: () => Promise<string>;
  isPackaged: () => Promise<boolean>;

  // Version checking
  checkForUpdates: () => Promise<IPCResponse<VersionUpdateInfo>>;
  getVersionInfo: () => Promise<IPCResponse<{
    current: string;
    workingDirectory?: string;
    cyboflowDirectory?: string;
    buildDate?: string;
    gitCommit?: string;
    buildTimestamp?: number;
    worktreeName?: string;
  }>>;

  // Auto-updater
  updater: {
    checkAndDownload: () => Promise<IPCResponse<void>>;
    downloadUpdate: () => Promise<IPCResponse<void>>;
    installUpdate: () => Promise<IPCResponse<void>>;
  };

  // System utilities
  openExternal: (url: string) => Promise<void>;

  // Session management
  sessions: {
    getAll: () => Promise<IPCResponse<Session[]>>;
    getAllWithProjects: () => Promise<IPCResponse<Session[]>>;
    getArchivedWithProjects: () => Promise<IPCResponse<Session[]>>;
    get: (sessionId: string) => Promise<IPCResponse<Session>>;
    create: (request: CreateSessionRequest) => Promise<IPCResponse<Session>>;
    delete: (sessionId: string) => Promise<IPCResponse<void>>;
    sendInput: (sessionId: string, input: string) => Promise<IPCResponse<void>>;
    continue: (sessionId: string, prompt?: string, model?: string) => Promise<IPCResponse<void>>;
    getOutput: (sessionId: string, limit?: number) => Promise<IPCResponse<string[]>>;
    getJsonMessages: (sessionId: string) => Promise<IPCResponse<ClaudeJsonMessage[]>>;
    getStatistics: (sessionId: string) => Promise<IPCResponse<unknown>>; // SessionStatistics is locally typed in SessionStats.tsx
    getConversation: (sessionId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    getConversationMessages: (sessionId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    generateCompactedContext: (sessionId: string) => Promise<IPCResponse<void>>;
    markViewed: (sessionId: string) => Promise<IPCResponse<void>>;
    stop: (sessionId: string) => Promise<IPCResponse<void>>;

    // Execution and Git operations
    getExecutions: (sessionId: string) => Promise<IPCResponse<ExecutionDiff[]>>;
    getExecutionDiff: (sessionId: string, executionId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    gitCommit: (sessionId: string, message: string) => Promise<IPCResponse<void>>;
    gitDiff: (sessionId: string) => Promise<IPCResponse<GitDiffResult>>;
    getCombinedDiff: (sessionId: string, executionIds?: number[]) => Promise<IPCResponse<GitDiffResult>>;

    // Script operations
    hasRunScript: (sessionId: string) => Promise<IPCResponse<boolean>>;
    getRunningSession: () => Promise<IPCResponse<Session | null>>;
    runScript: (sessionId: string) => Promise<IPCResponse<void>>;
    stopScript: (sessionId?: string) => Promise<IPCResponse<void>>;
    runTerminalCommand: (sessionId: string, command: string) => Promise<IPCResponse<void>>;
    sendTerminalInput: (sessionId: string, data: string) => Promise<IPCResponse<void>>;
    preCreateTerminal: (sessionId: string) => Promise<IPCResponse<void>>;
    resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<IPCResponse<void>>;

    // Prompt operations
    getPrompts: (sessionId: string) => Promise<IPCResponse<unknown[]>>; // PromptMarker is locally typed in consumers

    // Git merge operations
    mergeMainToWorktree: (sessionId: string) => Promise<IPCResponse<void>>;
    mergeWorktreeToMain: (sessionId: string) => Promise<IPCResponse<void>>;

    // Git rebase operations
    rebaseMainIntoWorktree: (sessionId: string) => Promise<IPCResponse<void>>;
    abortRebaseAndUseClaude: (sessionId: string) => Promise<IPCResponse<void>>;
    squashAndRebaseToMain: (sessionId: string, commitMessage: string) => Promise<IPCResponse<void>>;
    rebaseToMain: (sessionId: string) => Promise<IPCResponse<void>>;
    hasChangesToRebase: (sessionId: string) => Promise<IPCResponse<boolean>>;
    getGitCommands: (sessionId: string) => Promise<IPCResponse<GitCommands>>;
    generateName: (prompt: string) => Promise<IPCResponse<string>>;
    rename: (sessionId: string, newName: string) => Promise<IPCResponse<void>>;
    toggleFavorite: (sessionId: string) => Promise<IPCResponse<void>>;
    toggleAutoCommit: (sessionId: string) => Promise<IPCResponse<void>>;

    // Main repo session
    getOrCreateMainRepoSession: (projectId: number) => Promise<IPCResponse<Session>>;

    // Git pull/push operations
    gitPull: (sessionId: string) => Promise<IPCResponse<void>>;
    gitPush: (sessionId: string) => Promise<IPCResponse<void>>;
    getGitStatus: (sessionId: string, nonBlocking?: boolean, isInitialLoad?: boolean) => Promise<IPCResponse<GitStatus>>;
    getLastCommits: (sessionId: string, count: number) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly

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

  // Project management
  projects: {
    getAll: () => Promise<IPCResponse<Project[]>>;
    getActive: () => Promise<IPCResponse<Project>>;
    create: (projectData: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => Promise<IPCResponse<Project>>;
    activate: (projectId: string) => Promise<IPCResponse<void>>;
    update: (projectId: string, updates: Partial<Project>) => Promise<IPCResponse<void>>;
    delete: (projectId: string) => Promise<IPCResponse<void>>;
    detectBranch: (path: string) => Promise<IPCResponse<string>>;
    reorder: (projectOrders: Array<{ id: number; displayOrder: number }>) => Promise<IPCResponse<void>>;
    listBranches: (projectId: string) => Promise<IPCResponse<{ name: string; isCurrent: boolean; hasWorktree: boolean }[]>>;
    refreshGitStatus: (projectId: number) => Promise<IPCResponse<void>>;
    runScript: (projectId: number) => Promise<IPCResponse<void>>;
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

  // Configuration
  config: {
    get: () => Promise<IPCResponse<AppConfig>>;
    update: (updates: Record<string, unknown>) => Promise<IPCResponse<void>>;
    getSessionPreferences: () => Promise<IPCResponse<SessionCreationPreferences>>;
    updateSessionPreferences: (preferences: SessionCreationPreferences) => Promise<IPCResponse<void>>;
  };

  // Prompts
  prompts: {
    getAll: () => Promise<IPCResponse<unknown[]>>; // PromptHistoryItem is locally typed in consumers
    getByPromptId: (promptId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
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

  // Stravu MCP integration with OAuth
  stravu: {
    getConnectionStatus: () => Promise<IPCResponse<{ status: string; memberInfo?: { memberId: string; orgSlug: string; scopes: string[] }; error?: string }>>;
    initiateAuth: () => Promise<IPCResponse<{ authUrl: string; sessionId: string }>>;
    checkAuthStatus: (sessionId: string) => Promise<IPCResponse<{ status: string; memberInfo?: { memberId: string; orgSlug: string; scopes: string[] }; error?: string }>>;
    disconnect: () => Promise<IPCResponse<void>>;
    getNotebooks: () => Promise<IPCResponse<unknown[]>>; // Caller does not consume .data directly
    getNotebook: (notebookId: string) => Promise<IPCResponse<{ content: string }>>;
    searchNotebooks: (query: string, limit?: number) => Promise<IPCResponse<unknown[]>>; // Caller does not consume .data directly
  };

  // Dashboard
  dashboard: {
    getProjectStatus: (projectId: number) => Promise<IPCResponse<unknown>>; // ProjectDashboardData is locally typed in consumers
    getProjectStatusProgressive: (projectId: number) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    onUpdate: (callback: (data: Record<string, unknown>) => void) => () => void;
    onSessionUpdate: (callback: (data: { type: string; projectId?: number; sessionId?: string; data: unknown }) => void) => () => void;
  };

  // UI State management
  uiState: {
    getExpanded: () => Promise<IPCResponse<{ expandedProjects: number[]; expandedFolders: string[]; sessionSortAscending: boolean }>>;
    saveExpanded: (projectIds: number[], folderIds: string[]) => Promise<IPCResponse<void>>;
    saveExpandedProjects: (projectIds: number[]) => Promise<IPCResponse<void>>;
    saveExpandedFolders: (folderIds: string[]) => Promise<IPCResponse<void>>;
    saveSessionSortAscending: (ascending: boolean) => Promise<IPCResponse<void>>;
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
    onVersionUpdateAvailable: (callback: (versionInfo: VersionUpdateInfo) => void) => () => void;

    // Auto-updater events
    onUpdaterCheckingForUpdate: (callback: () => void) => () => void;
    onUpdaterUpdateAvailable: (callback: (info: { version: string; releaseDate: string; releaseName?: string; releaseNotes?: string }) => void) => () => void;
    onUpdaterUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void;
    onUpdaterDownloadProgress: (callback: (progressInfo: { bytesPerSecond: number; percent: number; transferred: number; total: number }) => void) => () => void;
    onUpdaterUpdateDownloaded: (callback: (info: { version: string; files: string[]; path: string; sha512: string; releaseDate: string }) => void) => () => void;
    onUpdaterError: (callback: (error: Error) => void) => () => void;

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
    getOutput: (panelId: string, limit?: number) => Promise<IPCResponse<string[]>>;
    getConversationMessages: (panelId: string) => Promise<IPCResponse<unknown>>; // Caller does not consume .data directly
    getJsonMessages: (panelId: string) => Promise<IPCResponse<ClaudeJsonMessage[]>>;
    getPrompts: (panelId: string) => Promise<IPCResponse<unknown[]>>; // PromptMarker is locally typed in consumers
    continue: (panelId: string, input: string, model?: string) => Promise<IPCResponse<void>>;
    stop: (panelId: string) => Promise<IPCResponse<void>>;
    resizeTerminal: (panelId: string, cols: number, rows: number) => Promise<IPCResponse<void>>;
    sendTerminalInput: (panelId: string, data: string) => Promise<IPCResponse<void>>;
  };

  // Claude Panels - specific API for Claude panels
  claudePanels: {
    getModel: (panelId: string) => Promise<IPCResponse<string>>;
    setModel: (panelId: string, model: string) => Promise<IPCResponse<void>>;
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

  // Analytics tracking
  analytics: {
    trackUIEvent: (eventData: {
      event: string;
      properties: Record<string, string | number | boolean | string[] | undefined>;
    }) => Promise<IPCResponse<void>>;
    categorizeResultCount: (count: number) => Promise<IPCResponse<string>>;
    hashSessionId: (sessionId: string) => Promise<IPCResponse<string>>;
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
