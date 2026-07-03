// Utility for making API calls using Electron IPC
import type { CreateSessionRequest } from '../types/session';
import type { Project } from '../types/project';
import type { SessionCreationPreferences } from '../stores/sessionPreferencesStore';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { ModelAvailabilityMap, ModelFallbackNotice } from '../../../shared/types/modelAvailability';

// Type for IPC response.
// T defaults to `unknown` (not `any`) so callers must narrow before reading .data.
// This enforces the type-contract at each IPC call site and prevents silent regressions
// on field renames (e.g. the crystalDirectory → cyboflowDirectory incident).
export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
  /**
   * Set by the merge handlers (sessions:squash-and-rebase-to-main /
   * sessions:rebase-to-main) when the merge was BLOCKED because main has
   * advanced past the branch — a rebase is needed first. Distinguishes the
   * "rebase required" block from a generic git failure. Keep in sync with the
   * dual declaration in frontend/src/types/electron.d.ts.
   */
  needsRebase?: boolean;
}

// Type for Git error response.
// Extends IPCResponse<unknown> because the .data field is not consumed by GitErrorResponse callers.
export interface GitErrorResponse extends IPCResponse<unknown> {
  gitError?: {
    command?: string;
    commands?: string[];
    output?: string;
    workingDirectory?: string;
    projectPath?: string;
    originalError?: string;
    hasConflicts?: boolean;
    conflictingFiles?: string[];
    conflictingCommits?: {
      ours: string[];
      theirs: string[];
    };
  };
}

// Check if we're running in Electron
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI;
};

// Wrapper class for API calls that provides error handling and consistent interface
export class API {
  // Session management
  static sessions = {
    async getAll() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getAll();
    },

    async getAllWithProjects() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getAllWithProjects();
    },

    async get(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.get(sessionId);
    },

    async create(request: CreateSessionRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.create(request);
    },

    async createQuick(request: CreateSessionRequest) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.createQuick(request);
    },

    async delete(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.delete(sessionId);
    },

    async sendInput(sessionId: string, input: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.sendInput(sessionId, input);
    },

    async continue(sessionId: string, prompt?: string, model?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.continue(sessionId, prompt, model);
    },

    // Interactive (PTY) quick-session resume — see ResumeSessionPrompt / ClaudePanel.
    async getInteractiveResumeState(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getInteractiveResumeState(sessionId);
    },

    async resumeInteractive(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.resumeInteractive(sessionId);
    },

    async getOutput(sessionId: string, limit?: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getOutput(sessionId, limit);
    },
    async getStatistics(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getStatistics(sessionId);
    },

    async getConversation(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getConversation(sessionId);
    },

    async getConversationMessages(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getConversationMessages(sessionId);
    },

    async markViewed(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.markViewed(sessionId);
    },

    async stop(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.stop(sessionId);
    },

    async getExecutions(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getExecutions(sessionId);
    },

    async getExecutionDiff(sessionId: string, executionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getExecutionDiff(sessionId, executionId);
    },

    async gitCommit(sessionId: string, message: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitCommit(sessionId, message);
    },

    async gitDiff(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitDiff(sessionId);
    },

    async getCombinedDiff(sessionId: string, executionIds?: number[]) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getCombinedDiff(sessionId, executionIds);
    },

    // Main repo session
    async getOrCreateMainRepoSession(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getOrCreateMainRepoSession(projectId);
    },

    // Script operations
    async hasRunScript(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.hasRunScript(sessionId);
    },

    async getRunningSession() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getRunningSession();
    },

    async runScript(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.runScript(sessionId);
    },

    async stopScript(sessionId?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.stopScript(sessionId);
    },

    async runTerminalCommand(sessionId: string, command: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.runTerminalCommand(sessionId, command);
    },

    async sendTerminalInput(sessionId: string, data: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.sendTerminalInput(sessionId, data);
    },

    async preCreateTerminal(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.preCreateTerminal(sessionId);
    },

    async resizeTerminal(sessionId: string, cols: number, rows: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.resizeTerminal(sessionId, cols, rows);
    },

    // Prompt operations
    async getPrompts(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getPrompts(sessionId);
    },

    // Git rebase operations
    async rebaseMainIntoWorktree(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.rebaseMainIntoWorktree(sessionId);
    },

    async abortRebaseAndUseClaude(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.abortRebaseAndUseClaude(sessionId);
    },

    async squashAndRebaseToMain(sessionId: string, commitMessage: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.squashAndRebaseToMain(sessionId, commitMessage);
    },

    async rebaseToMain(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.rebaseToMain(sessionId);
    },

    // Git operation helpers
    async hasChangesToRebase(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.hasChangesToRebase(sessionId);
    },

    async rename(sessionId: string, newName: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.rename(sessionId, newName);
    },

    async toggleFavorite(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.toggleFavorite(sessionId);
    },

    async toggleAutoCommit(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.toggleAutoCommit(sessionId);
    },

    async updateAgentPermissionMode(sessionId: string, mode: PermissionMode) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.updateAgentPermissionMode(sessionId, mode);
    },

    // Per-session MCP DENY list (migration 036). `disabledMcpServers` is the set
    // of server names to disable (the complement of what the McpTogglePill shows
    // checked); read at SDK spawn so it applies on the next turn.
    async updateSessionMcps(sessionId: string, disabledMcpServers: string[]) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.updateSessionMcps(sessionId, disabledMcpServers);
    },

    // Per-session plugin ALLOW list (migration 036). `enabledPlugins` is the set
    // of plugin ids to force-enable; read at SDK spawn (next-turn apply).
    async updateSessionPlugins(sessionId: string, enabledPlugins: string[]) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.updateSessionPlugins(sessionId, enabledPlugins);
    },

    async getGitCommands(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getGitCommands(sessionId);
    },

    // Git pull/push operations
    async gitPull(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitPull(sessionId);
    },

    async gitPush(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.gitPush(sessionId);
    },

    async getRemoteUrl(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getRemoteUrl(sessionId);
    },

    async getGitStatus(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getGitStatus(sessionId);
    },

    async getBranchCommitSubjects(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getBranchCommitSubjects(sessionId);
    },

    async getLastCommits(sessionId: string, count: number = 20) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.getLastCommits(sessionId, count);
    },

    async openIDE(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.openIDE(sessionId);
    },

    async reorder(sessionOrders: Array<{ id: string; displayOrder: number }>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.reorder(sessionOrders);
    },

    async generateCompactedContext(sessionId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.sessions.generateCompactedContext(sessionId);
    },

  };

  // Project management
  static projects = {
    async getAll() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.getAll();
    },

    async getActive() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.getActive();
    },

    async create(projectData: Omit<Project, 'id' | 'created_at' | 'updated_at'>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.create(projectData);
    },

    async activate(projectId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.activate(projectId);
    },

    async update(projectId: string, updates: Partial<Project>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.update(projectId, updates);
    },

    async delete(projectId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.delete(projectId);
    },

    async detectBranch(path: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.detectBranch(path);
    },

    async reorder(projectOrders: Array<{ id: number; displayOrder: number }>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.reorder(projectOrders);
    },

    async listBranches(projectId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.projects.listBranches(projectId);
    },
  };

  // Folders
  static folders = {
    async getByProject(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.getByProject(projectId);
    },

    async create(name: string, projectId: number, parentFolderId?: string | null) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.create(name, projectId, parentFolderId);
    },

    async update(folderId: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.update(folderId, updates);
    },

    async delete(folderId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.delete(folderId);
    },

    async reorder(projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.reorder(projectId, folderOrders);
    },

    async moveSession(sessionId: string, folderId: string | null) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.moveSession(sessionId, folderId);
    },

    async move(folderId: string, parentFolderId: string | null) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.folders.move(folderId, parentFolderId);
    },
  };

  // Demo mode
  static demo = {
    async getInfo() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.demo.getInfo();
    },
  };

  // Configuration
  static config = {
    async get() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.get();
    },

    async update(updates: Record<string, unknown>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.update(updates);
    },

    async getSessionPreferences() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.getSessionPreferences();
    },

    async updateSessionPreferences(preferences: SessionCreationPreferences) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.config.updateSessionPreferences(preferences);
    },
  };

  // Prompts
  static prompts = {
    async getAll() {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.prompts.getAll();
    },
  };

  // Dialog
  static dialog = {
    async openFile(options?: Record<string, unknown>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dialog.openFile(options);
    },

    async openDirectory(options?: Record<string, unknown>) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dialog.openDirectory(options);
    },
  };

  // Version info
  static async getVersionInfo() {
    if (!isElectron()) throw new Error('Electron API not available');
    return window.electronAPI.getVersionInfo();
  }

  // Dashboard
  static dashboard = {
    async getProjectStatus(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.getProjectStatus(projectId);
    },

    async getProjectStatusProgressive(projectId: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.getProjectStatusProgressive(projectId);
    },

    onUpdate(callback: (data: Record<string, unknown>) => void) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.onUpdate(callback);
    },

    onSessionUpdate(callback: (data: { type: string; projectId?: number; sessionId?: string; data: unknown }) => void) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.dashboard.onSessionUpdate(callback);
    },
  };

  // Panels - for Claude panels and other panel types
  static panels = {
    async getOutput(panelId: string, limit?: number) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getOutput(panelId, limit);
    },

    async getConversationMessages(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getConversationMessages(panelId);
    },

    async getJsonMessages(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getJsonMessages(panelId);
    },

    async getPrompts(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.getPrompts(panelId);
    },

    async sendInput(panelId: string, input: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.sendInput(panelId, input);
    },

    async continue(panelId: string, input: string, model?: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.panels.continue(panelId, input, model);
    },
  };

  // Claude Panels - specific API for Claude panels
  static claudePanels = {
    async getModel(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.claudePanels.getModel(panelId);
    },

    async setModel(panelId: string, model: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.claudePanels.setModel(panelId, model);
    },

    async setFastMode(panelId: string, fastMode: boolean) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.claudePanels.setFastMode(panelId, fastMode);
    },

    async getFastMode(panelId: string) {
      if (!isElectron()) throw new Error('Electron API not available');
      return window.electronAPI.claudePanels.getFastMode(panelId);
    },
  };

  static models = {
    /** Snapshot of guarded-model (Fable 5) availability. Empty map = all usable. */
    async getAvailability() {
      // Guard the `models` surface too: a preload version skew (older bridge)
      // should degrade to optimistic, not crash the picker.
      if (!isElectron() || !window.electronAPI.models) throw new Error('Electron API not available');
      return window.electronAPI.models.getAvailability();
    },
    /** Subscribe to live availability flips; returns an unsubscribe fn. No-op off Electron. */
    onAvailabilityChanged(callback: (map: ModelAvailabilityMap) => void): () => void {
      if (!isElectron() || !window.electronAPI.models) return () => {};
      return window.electronAPI.models.onAvailabilityChanged(callback);
    },
    /** Subscribe to mid-call model fallbacks (guarded model pulled → retried on Opus). */
    onModelFallback(callback: (notice: ModelFallbackNotice) => void): () => void {
      if (!isElectron() || !window.electronAPI.models) return () => {};
      return window.electronAPI.models.onModelFallback(callback);
    },
  };

}

// Legacy support - removed as migration is complete
// All HTTP API calls have been migrated to IPC via the API class
