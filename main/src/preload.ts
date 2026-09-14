import '@sentry/electron/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { exposeElectronTRPC } from 'trpc-electron/main';
import type { CreateSessionRequest, Session } from './types/session';
import type { CreateProjectRequest, UpdateProjectRequest, Project } from '../../frontend/src/types/project';
import type { ToolPanel, FastModeStateNotice, QueuedPanelInput } from '../../shared/types/panels';
import type { UpdaterEvent, UpdateCheckResult } from '../../shared/types/updater';
import type { ModelAvailabilityMap, ModelFallbackNotice } from '../../shared/types/modelAvailability';
import type { ProviderModelCatalogs } from '../../shared/types/agentModels';
import type { AgentProvider } from '../../shared/types/agentRuntime';
import type {
  LoadArtifactHtmlRequest,
  LoadArtifactHtmlResult,
  OpenArtifactHtmlExternalRequest,
  OpenArtifactHtmlExternalResult,
} from '../../shared/types/artifacts';
import type { ReasoningEffort } from '../../shared/types/reasoningEffort';
import type { OpenIdeaSessionRequest, OpenIdeaSessionResponse } from '../../shared/types/ideaSession';
import type {
  BugReportPreview,
  BugReportRunLink,
  BugReportSubmitRequest,
  BugReportSubmitResponse,
} from '../../shared/types/bugReport';
import {
  DESIGN_PROTO_SERVER_ENSURE_CHANNEL,
  DESIGN_PROTO_SERVER_STOP_CHANNEL,
  DESIGN_PROTO_SERVER_HOST_COMMENT_CHANNEL,
  DESIGN_PROTO_SERVER_EVENT_CHANNEL,
  type EnsurePrototypeServerRequest,
  type EnsurePrototypeServerResult,
  type StopPrototypeServerRequest,
  type StopPrototypeServerResult,
  type HostCommentDocumentRequest,
  type HostCommentDocumentResult,
  type PrototypeServerEvent,
} from '../../shared/types/designPrototypeServer';
import {
  PROVIDERS_DETECT_CHANNEL,
  type ProviderDetectionResult,
} from '../../shared/types/onboarding';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

interface DialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: string[];
}

interface DashboardUpdateData {
  type: 'status' | 'session' | 'project';
  projectId?: number;
  sessionId?: string;
  data: unknown;
}

interface GitStatusUpdateData {
  sessionId: string;
  gitStatus: {
    state: string;
    ahead?: number;
    behind?: number;
    additions?: number;
    deletions?: number;
    filesChanged?: number;
  };
}

interface SessionOutputData {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'json' | 'error';
  data: unknown;
  timestamp: string;
  panelId?: string;
}

interface SessionOutputAvailableData {
  sessionId: string;
  panelId?: string;
  hasNewOutput?: boolean;
}

interface Folder {
  id: string;
  name: string;
  project_id: number;
  parent_folder_id?: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

// Increase max listeners for ipcRenderer to prevent warnings when many components listen to events
ipcRenderer.setMaxListeners(50);

// Bridge panel events from main process to renderer window as DOM CustomEvents
// This allows React components to listen with `window.addEventListener('panel:event', ...)`
try {
  ipcRenderer.on('panel:event', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('panel:event', { detail: data }));
    } catch (e) {
      // Do not let event dispatch failures break the app
      console.error('Failed to dispatch panel:event to window:', e);
    }
  });

  // Bridge project script events
  ipcRenderer.on('project-script-changed', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('project-script-changed', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch project-script-changed to window:', e);
    }
  });

  ipcRenderer.on('project-script-closing', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('project-script-closing', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch project-script-closing to window:', e);
    }
  });

  // Bridge session script events (for consistency)
  ipcRenderer.on('script-session-changed', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('script-session-changed', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch script-session-changed to window:', e);
    }
  });

  ipcRenderer.on('script-closing', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('script-closing', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch script-closing to window:', e);
    }
  });
} catch (e) {
  // Ignore if IPC is not available for some reason
}

// In development mode, capture console logs and send them to main process for Claude Code debugging
if (process.env.NODE_ENV !== 'production') {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug
  };

  // Override console methods to capture frontend logs
  (['log', 'warn', 'error', 'info', 'debug'] as const).forEach(level => {
    (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      // Call original console first so they still appear in DevTools
      (originalConsole as unknown as Record<string, (...args: unknown[]) => void>)[level](...args);
      
      // Send to main process for file logging
      try {
        ipcRenderer.invoke('console:log', {
          level,
          args: args.map(arg => {
            if (typeof arg === 'object') {
              try {
                return JSON.stringify(arg, null, 2);
              } catch (e) {
                return String(arg);
              }
            }
            return String(arg);
          }),
          timestamp: new Date().toISOString(),
          source: 'renderer'
        });
      } catch (error) {
        // Don't break if IPC fails
        originalConsole.error('Failed to send console log to main process:', error);
      }
    };
  });
}

// Response type for IPC calls
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ===========================================================================
// GENERIC-INVOKE CHANNEL ALLOWLIST — SECURITY BOUNDARY. Edit deliberately.
//
// Both contextBridge surfaces expose a generic `invoke(channel, ...args)`
// escape hatch (`window.electronAPI.invoke` and `window.electron.invoke`).
// Unconstrained, that hatch hands ANY renderer-side script — including one
// injected via XSS in rendered markdown, a diff, or a session name — the whole
// remaining `ipcMain.handle` surface. (Session/project-scoped file I/O and git
// execution moved off `ipcMain.handle` entirely, to the `cyboflow.workspaceFiles`
// tRPC router — see main/src/ipc/fileOps.ts.) The typed wrapper methods
// elsewhere in this file are unaffected; only the generic hatch is gated.
//
// The list is derived from the ACTUAL renderer call sites — every literal
// channel matched by `grep -rn "\.invoke(" frontend/src` (excluding tRPC), plus
// the two onboarding-detection channels the renderer passes as imported
// constants. It is intentionally NOT prefix-based: a prefix rule (`file:*`)
// would re-open every future channel in that domain by default.
//
// Adding an entry means "a compromised renderer may call this". Prefer adding a
// TYPED wrapper method instead; only widen this list when a call site genuinely
// needs the dynamic form.
// ===========================================================================
export const GENERIC_INVOKE_CHANNELS: readonly string[] = [
  // App / system
  'openExternal',
  'app:consume-open-update-settings',

  // Onboarding detection (renderer passes this as an imported constant —
  // PROVIDERS_DETECT_CHANNEL from shared/types/onboarding).
  PROVIDERS_DETECT_CHANNEL,

  // Preferences (onboarding gate snapshot)
  'preferences:get',
  'preferences:set',

  // Projects
  'projects:refresh-git-status',

  // Tool panels
  'panels:update',
  'panels:initialize',
  'panels:checkInitialized',
  'panels:emitEvent',
  'panels:clearUnviewedContent',

  // Terminal panel PTY bridge
  'terminal:getState',
  'terminal:input',
  'terminal:resize',

  // Cyboflow run control
  'cyboflow:approveRun',
];

const GENERIC_INVOKE_CHANNEL_SET = new Set<string>(GENERIC_INVOKE_CHANNELS);

/**
 * The gated body behind both generic `invoke` bridges. A non-allowlisted channel
 * is REJECTED LOUDLY (never silently resolved/ignored) so a legitimate new call
 * site fails visibly in development instead of degrading at runtime.
 *
 * Declared `async` so the rejection surfaces as a rejected Promise: the renderer
 * has fire-and-forget call sites (e.g. `terminal:input`) where a synchronous
 * throw would unwind unrelated caller code rather than showing up as an
 * unhandled rejection.
 */
async function invokeAllowlistedChannel(channel: string, args: unknown[]): Promise<unknown> {
  if (!GENERIC_INVOKE_CHANNEL_SET.has(channel)) {
    throw new Error(
      `[cyboflow] Blocked IPC channel "${channel}": not permitted through the generic invoke bridge. ` +
        `Add a typed wrapper method, or add the channel to GENERIC_INVOKE_CHANNELS in main/src/preload.ts ` +
        `if the dynamic form is genuinely required.`,
    );
  }
  return ipcRenderer.invoke(channel, ...args);
}

// Forward the main-process perf-trace flag so a single `CYBOFLOW_PERF_TRACE=1`
// at launch enables BOTH the main-process tracer and the renderer probe (which
// reads this global in utils/perfProbe.ts). Preload runs in the Node context,
// so process.env is available; the value is a plain boolean, safe to expose.
contextBridge.exposeInMainWorld('__cyboflowPerf', {
  traceEnabled: process.env.CYBOFLOW_PERF_TRACE === '1',
});

// Verification identity (the cdp-token attestation channel of
// .cyboflow/verify-runbook.json). Present ONLY when the launcher injected the
// token, so a developer's own `pnpm dev` instance evaluates to null and can
// never satisfy a verification's attestation — which the previous channel,
// `electronAPI.getAppVersion()`, could not distinguish. Same pattern and same
// justification as the __cyboflowPerf bridge above: preload runs in the Node
// context, so process.env is available, and the value is a plain string.
contextBridge.exposeInMainWorld('__CYBOFLOW_VERIFY__', {
  token: process.env.CYBOFLOW_VERIFY_TOKEN ?? null,
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Generic invoke method for direct IPC calls. Gated by the
  // GENERIC_INVOKE_CHANNELS allowlist above (security boundary).
  invoke: (channel: string, ...args: unknown[]) => invokeAllowlistedChannel(channel, args),

  // Basic app info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  isPackaged: () => ipcRenderer.invoke('is-packaged'),

  // Version info
  getVersionInfo: (): Promise<IPCResponse> => ipcRenderer.invoke('version:get-info'),

  // In-app auto-updater (electron-updater → updates.cyboflow.com). check/download/
  // install are user-triggered; onEvent streams the lifecycle (see shared/types/updater).
  updater: {
    check: (): Promise<IPCResponse<UpdateCheckResult>> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<IPCResponse<void>> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<IPCResponse<void>> => ipcRenderer.invoke('updater:install'),
    onEvent: (callback: (event: UpdaterEvent) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, payload: UpdaterEvent) => callback(payload);
      ipcRenderer.on('updater:event', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:event', wrappedCallback);
    },
  },

  // System utilities
  openExternal: (url: string): Promise<IPCResponse> => ipcRenderer.invoke('openExternal', url),

  // Relaunch the app (demo-mode toggle applies on next boot)
  relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),

  // Session management
  sessions: {
    create: (request: CreateSessionRequest): Promise<IPCResponse> => ipcRenderer.invoke('sessions:create', request),
    // claudePanelId is set ONLY when the handler eagerly spawned the interactive
    // PTY REPL (request.substrate === 'interactive') so the frontend can skip
    // creating a duplicate claude panel. KEEP IN SYNC with the handler's return
    // and frontend/src/types/electron.d.ts (IPC handler ↔ declared T parity).
    createQuick: (request: CreateSessionRequest): Promise<IPCResponse<{ jobId: string; sessionId: string; worktreePath: string; runId: string; claudePanelId?: string }>> =>
      ipcRenderer.invoke('sessions:create-quick', request),
    // Backlog idea card "Open" — find-or-create the idea's ONE persistent,
    // in-place, SDK-pinned home session. Request/response shapes come from
    // shared/types/ideaSession.ts so this bridge, the handler, and the renderer
    // wrapper all read ONE declaration.
    openIdeaSession: (request: OpenIdeaSessionRequest): Promise<IPCResponse<OpenIdeaSessionResponse>> =>
      ipcRenderer.invoke('sessions:open-idea-session', request),
    delete: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:delete', sessionId),
    sendInput: (sessionId: string, input: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:input', sessionId, input),
    continue: (sessionId: string, prompt?: string, model?: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:continue', sessionId, prompt, model),
    getInteractiveResumeState: (sessionId: string, panelId?: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-interactive-resume-state', sessionId, panelId),
    resumeInteractive: (sessionId: string, panelId?: string, acknowledgeProviderDisabled?: boolean): Promise<IPCResponse> => ipcRenderer.invoke('sessions:resume-interactive', sessionId, panelId, acknowledgeProviderDisabled),
    restartInteractive: (sessionId: string, panelId?: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:restart-interactive', sessionId, panelId),
    getOutput: (sessionId: string, limit?: number): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-output', sessionId, limit),
    getConversation: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-conversation', sessionId),
    getConversationMessages: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-conversation-messages', sessionId),
    generateCompactedContext: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:generate-compacted-context', sessionId),
    stop: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:stop', sessionId),
    
    // Main repo session
    getOrCreateMainRepoSession: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-or-create-main-repo', projectId),
    
    // Script operations
    hasRunScript: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:has-run-script', sessionId),
    getRunningSession: (): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-running-session'),
    runScript: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:run-script', sessionId),
    stopScript: (sessionId?: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:stop-script', sessionId),
    runTerminalCommand: (sessionId: string, command: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:run-terminal-command', sessionId, command),
    sendTerminalInput: (sessionId: string, data: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:send-terminal-input', sessionId, data),
    preCreateTerminal: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:pre-create-terminal', sessionId),
    resizeTerminal: (sessionId: string, cols: number, rows: number): Promise<IPCResponse> => ipcRenderer.invoke('sessions:resize-terminal', sessionId, cols, rows),

    // IDE operations
    openIDE: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:open-ide', sessionId),
    
    // Image operations
    saveImages: (sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>): Promise<string[]> => ipcRenderer.invoke('sessions:save-images', sessionId, images),
    
    // Text file operations
    saveLargeText: (sessionId: string, text: string): Promise<string> => ipcRenderer.invoke('sessions:save-large-text', sessionId, text),
    
    // Log operations
    getLogs: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-logs', sessionId),
    clearLogs: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:clear-logs', sessionId),
    addLog: (sessionId: string, entry: LogEntry): Promise<IPCResponse> => ipcRenderer.invoke('sessions:add-log', sessionId, entry),
  },

  // Idea image attachments (migration 028) — raw file IO, returns plain values
  // (NOT IPCResponse), mirroring sessions.saveImages.
  ideas: {
    saveAttachments: (
      ownerKey: string,
      images: Array<{ name: string; dataUrl: string; type: string }>,
    ): Promise<Array<{ id: string; name: string; path: string; type: string; size: number }>> =>
      ipcRenderer.invoke('ideas:save-attachments', ownerKey, images),
    loadAttachments: (paths: string[]): Promise<Array<{ path: string; dataUrl: string }>> =>
      ipcRenderer.invoke('ideas:load-attachments', paths),
  },

  // Artifact images (FU4 screenshots gallery) — serves on-disk PNGs the
  // visual-verifier producer wrote under CYBOFLOW_DIR/artifacts/runs/<runId>/.
  // Returns the IPCResponse wrapper (unlike the raw ideas.* file IO above).
  artifacts: {
    loadImages: (
      req: { runId: string; fileNames: string[] },
    ): Promise<IPCResponse<{ images: Array<{ fileName: string; dataUrl: string }> }>> =>
      ipcRenderer.invoke('artifacts:load-images', req),
    // Static-mockup HTML load (Approach C) — reads the canonical
    // prototype/index.html for a ui-prototype/generic artifact, CSP-injected
    // by the main-process handler. Request/response are the SHARED types so this
    // and frontend/src/types/electron.d.ts `artifacts.loadHtml` can't drift.
    loadHtml: (
      req: LoadArtifactHtmlRequest,
    ): Promise<IPCResponse<LoadArtifactHtmlResult>> =>
      ipcRenderer.invoke('artifacts:load-html', req),
    // Open the canonical prototype HTML in the user's default browser (raw
    // temp-file copy via shell.openExternal — see artifacts:open-in-browser).
    openHtmlExternal: (
      req: OpenArtifactHtmlExternalRequest,
    ): Promise<IPCResponse<OpenArtifactHtmlExternalResult>> =>
      ipcRenderer.invoke('artifacts:open-in-browser', req),
    // Verifier-transcript text loader (verifier-transcript capture) — reads an
    // on-disk .md/.txt/.log file back verbatim from the run's artifacts root
    // (same containment guard as loadImages).
    loadText: (
      req: { runId: string; fileName: string },
    ): Promise<IPCResponse<{ text: string }>> =>
      ipcRenderer.invoke('artifacts:load-text', req),
  },

  // Design-mode v1 interactive prototype server (design-mode.md "Process
  // isolation" + "Server lifecycle"). Surface-scoped lifecycle: the design
  // surface `ensure`s on entry/respawn and `stop`s on exit; onEvent streams
  // watchdog terminations + out-of-band server stops. Shared contract types —
  // see shared/types/designPrototypeServer.ts.
  designPrototypeServer: {
    ensure: (
      req: EnsurePrototypeServerRequest,
    ): Promise<IPCResponse<EnsurePrototypeServerResult>> =>
      ipcRenderer.invoke(DESIGN_PROTO_SERVER_ENSURE_CHANNEL, req),
    stop: (
      req: StopPrototypeServerRequest,
    ): Promise<IPCResponse<StopPrototypeServerResult>> =>
      ipcRenderer.invoke(DESIGN_PROTO_SERVER_STOP_CHANNEL, req),
    hostComment: (
      req: HostCommentDocumentRequest,
    ): Promise<IPCResponse<HostCommentDocumentResult>> =>
      ipcRenderer.invoke(DESIGN_PROTO_SERVER_HOST_COMMENT_CHANNEL, req),
    onEvent: (callback: (event: PrototypeServerEvent) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, payload: PrototypeServerEvent) =>
        callback(payload);
      ipcRenderer.on(DESIGN_PROTO_SERVER_EVENT_CHANNEL, wrappedCallback);
      return () => ipcRenderer.removeListener(DESIGN_PROTO_SERVER_EVENT_CHANNEL, wrappedCallback);
    },
  },

  // Project management
  projects: {
    getAll: (): Promise<IPCResponse> => ipcRenderer.invoke('projects:get-all'),
    getActive: (): Promise<IPCResponse> => ipcRenderer.invoke('projects:get-active'),
    create: (projectData: CreateProjectRequest): Promise<IPCResponse> => ipcRenderer.invoke('projects:create', projectData),
    activate: (projectId: string): Promise<IPCResponse> => ipcRenderer.invoke('projects:activate', projectId),
    update: (projectId: string, updates: UpdateProjectRequest): Promise<IPCResponse> => ipcRenderer.invoke('projects:update', projectId, updates),
    delete: (projectId: string): Promise<IPCResponse> => ipcRenderer.invoke('projects:delete', projectId),
    detectBranch: (path: string): Promise<IPCResponse> => ipcRenderer.invoke('projects:detect-branch', path),
    reorder: (projectOrders: Array<{ id: number; displayOrder: number }>): Promise<IPCResponse> => ipcRenderer.invoke('projects:reorder', projectOrders),
    listBranches: (projectId: string): Promise<IPCResponse> => ipcRenderer.invoke('projects:list-branches', projectId),
    refreshGitStatus: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('projects:refresh-git-status', projectId),
    runScript: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('projects:run-script', projectId),
    getRunningScript: (): Promise<IPCResponse> => ipcRenderer.invoke('projects:get-running-script'),
    stopScript: (projectId?: number): Promise<IPCResponse> => ipcRenderer.invoke('projects:stop-script', projectId),
  },

  // Git operations
  git: {
    detectBranch: (path: string): Promise<IPCResponse<string>> => ipcRenderer.invoke('projects:detect-branch', path),
  },

  // Folders
  folders: {
    getByProject: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('folders:get-by-project', projectId),
    create: (name: string, projectId: number, parentFolderId?: string | null): Promise<IPCResponse> => ipcRenderer.invoke('folders:create', name, projectId, parentFolderId),
    update: (folderId: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }): Promise<IPCResponse> => ipcRenderer.invoke('folders:update', folderId, updates),
    delete: (folderId: string): Promise<IPCResponse> => ipcRenderer.invoke('folders:delete', folderId),
    reorder: (projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>): Promise<IPCResponse> => ipcRenderer.invoke('folders:reorder', projectId, folderOrders),
    moveSession: (sessionId: string, folderId: string | null): Promise<IPCResponse> => ipcRenderer.invoke('folders:move-session', sessionId, folderId),
    move: (folderId: string, parentFolderId: string | null): Promise<IPCResponse> => ipcRenderer.invoke('folders:move', folderId, parentFolderId),
  },

  // Configuration
  demo: {
    getInfo: (): Promise<IPCResponse<{ demoMode: boolean; sandboxPath: string | null; projectName: string }>> =>
      ipcRenderer.invoke('demo:get-info'),
  },

  // Telemetry (fire-and-forget renderer -> main)
  telemetry: {
    track: (eventName: string, properties?: Record<string, string | number | boolean>): void => {
      ipcRenderer.send('telemetry:track', { eventName, properties });
    },
    // Synchronous boot-time check: whether MAIN initialized Sentry. The renderer
    // SDK forwards events over a custom `sentry-ipc://` protocol that ONLY exists
    // when main's Sentry is active, so the renderer must gate its init on this.
    isSentryActive: (): boolean => {
      try {
        return ipcRenderer.sendSync('telemetry:is-sentry-active') === true;
      } catch {
        return false;
      }
    },
  },

  // In-app bug reporting (user-initiated; independent of the telemetry toggle)
  bugReport: {
    getPreview: (): Promise<IPCResponse<BugReportPreview>> =>
      ipcRenderer.invoke('bugReport:getPreview'),
    submit: (request: BugReportSubmitRequest): Promise<IPCResponse<BugReportSubmitResponse>> =>
      ipcRenderer.invoke('bugReport:submit', request),
    resolveRun: (sessionId: string): Promise<IPCResponse<BugReportRunLink | null>> =>
      ipcRenderer.invoke('bugReport:resolveRun', { sessionId }),
  },

  // Dialog
  dialog: {
    openFile: (options?: DialogOptions): Promise<IPCResponse<string | null>> => ipcRenderer.invoke('dialog:open-file', options),
    openDirectory: (options?: DialogOptions): Promise<IPCResponse<string | null>> => ipcRenderer.invoke('dialog:open-directory', options),
  },

  // Dashboard
  dashboard: {
    getProjectStatus: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('dashboard:get-project-status', projectId),
    getProjectStatusProgressive: (projectId: number): Promise<IPCResponse> => ipcRenderer.invoke('dashboard:get-project-status-progressive', projectId),
    onUpdate: (callback: (data: DashboardUpdateData) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, data: DashboardUpdateData) => callback(data);
      ipcRenderer.on('dashboard:update', subscription);
      return () => ipcRenderer.removeListener('dashboard:update', subscription);
    },
    onSessionUpdate: (callback: (data: DashboardUpdateData) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, data: DashboardUpdateData) => callback(data);
      ipcRenderer.on('dashboard:session-update', subscription);
      return () => ipcRenderer.removeListener('dashboard:session-update', subscription);
    },
  },

  // First-run onboarding + Settings — per-provider login/runtime probe
  // ("Check again"). Provider-keyed: one channel, the provider as its argument.
  providers: {
    detect: <P extends AgentProvider>(provider: P): Promise<IPCResponse<ProviderDetectionResult<P>>> =>
      ipcRenderer.invoke(PROVIDERS_DETECT_CHANNEL, provider),
  },

  // Model availability (guarded models, e.g. Fable 5.1)
  models: {
    getAvailability: (): Promise<IPCResponse<ModelAvailabilityMap>> =>
      ipcRenderer.invoke('models:get-availability'),
    getCatalog: <P extends AgentProvider>(provider: P): Promise<IPCResponse<ProviderModelCatalogs[P]>> =>
      ipcRenderer.invoke('models:get-catalog', provider),
    onAvailabilityChanged: (callback: (map: ModelAvailabilityMap) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, map: ModelAvailabilityMap) => callback(map);
      ipcRenderer.on('model-availability-changed', subscription);
      return () => ipcRenderer.removeListener('model-availability-changed', subscription);
    },
    onModelFallback: (callback: (notice: ModelFallbackNotice) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, notice: ModelFallbackNotice) => callback(notice);
      ipcRenderer.on('model-fallback', subscription);
      return () => ipcRenderer.removeListener('model-fallback', subscription);
    },
  },

  // UI State management
  uiState: {
    getExpanded: (): Promise<IPCResponse> => ipcRenderer.invoke('ui-state:get-expanded'),
    saveExpanded: (projectIds: number[], folderIds: string[]): Promise<IPCResponse> => ipcRenderer.invoke('ui-state:save-expanded', projectIds, folderIds),
    saveExpandedProjects: (projectIds: number[]): Promise<IPCResponse> => ipcRenderer.invoke('ui-state:save-expanded-projects', projectIds),
    saveExpandedFolders: (folderIds: string[]): Promise<IPCResponse> => ipcRenderer.invoke('ui-state:save-expanded-folders', folderIds),
  },

  // Event listeners for real-time updates
  events: {
    // Session events
    onSessionCreated: (callback: (session: Session) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on('session:created', wrappedCallback);
      return () => ipcRenderer.removeListener('session:created', wrappedCallback);
    },
    onSessionUpdated: (callback: (session: Session) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on('session:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('session:updated', wrappedCallback);
    },
    onSessionDeleted: (callback: (session: Session) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on('session:deleted', wrappedCallback);
      return () => ipcRenderer.removeListener('session:deleted', wrappedCallback);
    },
    onSessionsLoaded: (callback: (sessions: Session[]) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, sessions: Session[]) => callback(sessions);
      ipcRenderer.on('sessions:loaded', wrappedCallback);
      return () => ipcRenderer.removeListener('sessions:loaded', wrappedCallback);
    },
    onGitStatusUpdated: (callback: (data: GitStatusUpdateData) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: GitStatusUpdateData) => callback(data);
      ipcRenderer.on('git-status-updated', wrappedCallback);
      return () => ipcRenderer.removeListener('git-status-updated', wrappedCallback);
    },
    onGitStatusLoading: (callback: (data: { sessionId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on('git-status-loading', wrappedCallback);
      return () => ipcRenderer.removeListener('git-status-loading', wrappedCallback);
    },
    onSessionOutput: (callback: (output: SessionOutputData) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, output: SessionOutputData) => callback(output);
      ipcRenderer.on('session:output', wrappedCallback);
      return () => ipcRenderer.removeListener('session:output', wrappedCallback);
    },
    onSessionLog: (callback: (data: LogEntry) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: LogEntry) => callback(data);
      ipcRenderer.on('session-log', wrappedCallback);
      return () => ipcRenderer.removeListener('session-log', wrappedCallback);
    },
    onSessionLogsCleared: (callback: (data: { sessionId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on('session-logs-cleared', wrappedCallback);
      return () => ipcRenderer.removeListener('session-logs-cleared', wrappedCallback);
    },
    onSessionOutputAvailable: (callback: (info: SessionOutputAvailableData) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, info: SessionOutputAvailableData) => callback(info);
      ipcRenderer.on('session:output-available', wrappedCallback);
      return () => ipcRenderer.removeListener('session:output-available', wrappedCallback);
    },
    
    // Project events
    onProjectUpdated: (callback: (project: Project) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, project: Project) => callback(project);
      ipcRenderer.on('project:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('project:updated', wrappedCallback);
    },
    
    // Panel events
    onPanelCreated: (callback: (panel: ToolPanel) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, panel: ToolPanel) => callback(panel);
      ipcRenderer.on('panel:created', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:created', wrappedCallback);
    },
    onPanelUpdated: (callback: (panel: ToolPanel) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, panel: ToolPanel) => callback(panel);
      ipcRenderer.on('panel:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:updated', wrappedCallback);
    },
    
    // Folder events
    onFolderCreated: (callback: (folder: Folder) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, folder: Folder) => callback(folder);
      ipcRenderer.on('folder:created', wrappedCallback);
      return () => ipcRenderer.removeListener('folder:created', wrappedCallback);
    },
    onFolderUpdated: (callback: (folder: Folder) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, folder: Folder) => callback(folder);
      ipcRenderer.on('folder:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('folder:updated', wrappedCallback);
    },
    onFolderDeleted: (callback: (folderId: string) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, folderId: string) => callback(folderId);
      ipcRenderer.on('folder:deleted', wrappedCallback);
      return () => ipcRenderer.removeListener('folder:deleted', wrappedCallback);
    },
    
    // Panel events
    onPanelPromptAdded: (callback: (data: { panelId: string; content: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; content: string }) => callback(data);
      ipcRenderer.on('panel:prompt-added', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:prompt-added', wrappedCallback);
    },
    
    onPanelResponseAdded: (callback: (data: { panelId: string; content: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; content: string }) => callback(data);
      ipcRenderer.on('panel:response-added', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:response-added', wrappedCallback);
    },
    
    onTerminalOutput: (callback: (output: SessionOutputData) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, output: SessionOutputData) => callback(output);
      ipcRenderer.on('terminal:output', wrappedCallback);
      return () => ipcRenderer.removeListener('terminal:output', wrappedCallback);
    },

    // Generic event cleanup
    removeAllListeners: (channel: string) => {
      ipcRenderer.removeAllListeners(channel);
    },
    
    // Main process logging
    onMainLog: (callback: (level: string, message: string) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, level: string, message: string) => callback(level, message);
      ipcRenderer.on('main-log', wrappedCallback);
      return () => ipcRenderer.removeListener('main-log', wrappedCallback);
    },

    // Process management events
    onZombieProcessesDetected: (callback: (data: { count: number; processes: string[] }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { count: number; processes: string[] }) => callback(data);
      ipcRenderer.on('zombie-processes-detected', wrappedCallback);
      return () => ipcRenderer.removeListener('zombie-processes-detected', wrappedCallback);
    },
  },

  // Panels API for Claude panels and other panel types
  panels: {
    // Forwards the WHOLE CreatePanelRequest verbatim. It used to take four
    // positional args and REBUILD the request here, which silently dropped every
    // field the signature did not name — `substrate` (the Add-chat picker's
    // per-panel override, so an added PTY chat always launched as SDK) and
    // `metadata` (the dashboard/setup-tasks `permanent` flag). A structural
    // request type keeps renderer and main in type parity: a new field on
    // CreatePanelRequest reaches the handler without touching this line.
    createPanel: (request: {
      sessionId: string;
      type: string;
      title?: string;
      initialState?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      substrate?: 'sdk' | 'interactive';
    }): Promise<IPCResponse> => ipcRenderer.invoke('panels:create', request),
    getSessionPanels: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:list', sessionId),
    deletePanel: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:delete', panelId),
    renamePanel: (panelId: string, name: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:update', panelId, { name }),
    setActivePanel: (sessionId: string, panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:set-active', sessionId, panelId),
    resizeTerminal: (panelId: string, cols: number, rows: number): Promise<IPCResponse> => ipcRenderer.invoke('panels:resize-terminal', panelId, cols, rows),
    sendTerminalInput: (panelId: string, data: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:send-terminal-input', panelId, data),
    getOutput: (panelId: string, limit?: number): Promise<IPCResponse> => ipcRenderer.invoke('panels:get-output', panelId, limit),
    getConversationMessages: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:get-conversation-messages', panelId),
    getJsonMessages: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:get-json-messages', panelId),
    getPrompts: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:get-prompts', panelId),
    sendInput: (panelId: string, input: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:send-input', panelId, input),
    continue: (panelId: string, input: string, model?: string, interrupt?: boolean, pendingId?: string): Promise<IPCResponse> => ipcRenderer.invoke('panels:continue', panelId, input, model, interrupt, pendingId),
    // Mid-turn input queue ("always allow messaging a running quick session").
    queueInput: (panelId: string, id: string, text: string): Promise<IPCResponse<{ queued: boolean }>> =>
      ipcRenderer.invoke('panels:queue-input', panelId, id, text),
    listQueuedInput: (panelId: string): Promise<IPCResponse<QueuedPanelInput[]>> =>
      ipcRenderer.invoke('panels:list-queued-input', panelId),
    dequeueInput: (panelId: string, id: string): Promise<IPCResponse<{ dequeued: boolean }>> =>
      ipcRenderer.invoke('panels:dequeue-input', panelId, id),
  },

  // Claude Panels - specific API for Claude panels
  claudePanels: {
    getModel: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:get-model', panelId),
    getSubstrate: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:get-substrate', panelId),
    setSubstrate: (panelId: string, substrate: 'sdk' | 'interactive' | null): Promise<IPCResponse> =>
      ipcRenderer.invoke('claude-panels:set-substrate', panelId, substrate),
    setModel: (panelId: string, model: string): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:set-model', panelId, model),
    setFastMode: (panelId: string, fastMode: boolean): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:set-fast-mode', panelId, fastMode),
    getFastMode: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:get-fast-mode', panelId),
    getFastModeState: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:get-fast-mode-state', panelId),
    setEffort: (panelId: string, effort: ReasoningEffort | null): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:set-effort', panelId, effort),
    getEffort: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('claude-panels:get-effort', panelId),
    onFastModeState: (callback: (notice: FastModeStateNotice) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, notice: FastModeStateNotice) => callback(notice);
      ipcRenderer.on('fast-mode-state', subscription);
      return () => ipcRenderer.removeListener('fast-mode-state', subscription);
    },
  },

  // Logs panel operations
  logs: {
    runScript: (sessionId: string, command: string, cwd: string): Promise<IPCResponse> => ipcRenderer.invoke('logs:runScript', sessionId, command, cwd),
    stopScript: (panelId: string): Promise<IPCResponse> => ipcRenderer.invoke('logs:stopScript', panelId),
    isRunning: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('logs:isRunning', sessionId),
  },

  // Nimbalyst integration
  nimbalyst: {
    checkInstalled: (): Promise<IPCResponse> => ipcRenderer.invoke('nimbalyst:check-installed'),
    openWorktree: (worktreePath: string): Promise<IPCResponse> => ipcRenderer.invoke('nimbalyst:open-worktree', worktreePath),
  },
});

// Wire trpc-electron's IPC bridge so the renderer can use the typed tRPC client.
// Must be called in the preload script after contextBridge is set up.
// Cyboflow's existing contextBridge surfaces above are preserved — this is additive.
exposeElectronTRPC();

// Wrapper storage for the 'electron' contextBridge on/off pair.
// Outer map: channel string → Inner map: user callback → ipcRenderer wrapper.
// This ensures off() removes the exact wrapper that on() registered, not the
// bare callback (which would be a no-op since ipcRenderer never saw it directly).
const electronListenerWrappers = new Map<
  string,
  Map<(...args: unknown[]) => void, (event: Electron.IpcRendererEvent, ...args: unknown[]) => void>
>();

// Expose electron event listeners for the streaming/PTY/shell push channels
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  // Gated by the GENERIC_INVOKE_CHANNELS allowlist above (security boundary).
  invoke: (channel: string, ...args: unknown[]) => invokeAllowlistedChannel(channel, args),
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) | undefined => {
    const validChannels: string[] = [];
    if (validChannels.includes(channel) || channel.startsWith('cyboflow:stream:') || channel.startsWith('cyboflow:pty:') || channel.startsWith('cyboflow:shell:')) {
      const wrapper = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
      if (!electronListenerWrappers.has(channel)) {
        electronListenerWrappers.set(channel, new Map());
      }
      electronListenerWrappers.get(channel)!.set(callback, wrapper);
      ipcRenderer.on(channel, wrapper);
      // Return a disposer bound to THIS wrapper. Function identity is NOT
      // preserved across the contextBridge (the renderer's callback arrives here
      // as a fresh proxy on every call), so `off(channel, callback)` cannot find
      // the wrapper in the Map and silently leaks the listener — the renderer
      // MUST prefer this disposer over `off`.
      return () => {
        ipcRenderer.removeListener(channel, wrapper);
        const inner = electronListenerWrappers.get(channel);
        if (inner) {
          inner.delete(callback);
          if (inner.size === 0) electronListenerWrappers.delete(channel);
        }
      };
    }
    return undefined;
  },
  off: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels: string[] = [];
    if (validChannels.includes(channel) || channel.startsWith('cyboflow:stream:') || channel.startsWith('cyboflow:pty:') || channel.startsWith('cyboflow:shell:')) {
      const inner = electronListenerWrappers.get(channel);
      if (inner) {
        const wrapper = inner.get(callback);
        if (wrapper) {
          ipcRenderer.removeListener(channel, wrapper);
          inner.delete(callback);
          if (inner.size === 0) {
            electronListenerWrappers.delete(channel);
          }
        }
      }
    }
  },
});
