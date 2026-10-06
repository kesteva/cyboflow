import { AbstractCliManager } from '../cli/AbstractCliManager';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { PanelEvent, PanelEventType } from '../../../../../shared/types/panels';
import { AIPanelConfig, StartPanelConfig, ContinuePanelConfig, AIPanelState } from '../../../../../shared/types/aiPanelConfig';
import { panelEventBus } from '../../panelEventBus';

/**
 * Mapping between a panel and its associated session
 */
export interface PanelMapping {
  panelId: string;
  sessionId: string;
  resumeId?: string;
  config?: Partial<AIPanelConfig>;
}

/**
 * Abstract base class for managing AI agent panels (Claude)
 * Uses unified configuration object approach
 */
export abstract class AbstractAIPanelManager {
  protected panelMappings = new Map<string, PanelMapping>();
  protected resumeIdToPanel = new Map<string, string>();

  constructor(
    protected cliManager: AbstractCliManager,
    protected sessionManager: import('../../sessionManager').SessionManager,
    protected logger?: Logger,
    protected configManager?: ConfigManager,
    protected additionalCliManagers: AbstractCliManager[] = [],
  ) {
    this.setupEventHandlers();
  }

  /** Resolve the owner for a panel. Subclasses may route by panel metadata. */
  protected getCliManager(_panelId: string): AbstractCliManager {
    return this.cliManager;
  }

  /**
   * Get the name of the AI agent (e.g., 'Claude')
   */
  protected abstract getAgentName(): string;

  /**
   * Extract agent-specific configuration from the unified config
   * Each subclass implements this to pick out its relevant fields
   */
  protected abstract extractAgentConfig(config: AIPanelConfig, manager?: AbstractCliManager): unknown[];

  /**
   * Generate a resume ID for conversation continuation
   */
  protected generateResumeId(panelId: string): string {
    return `${this.getAgentName().toLowerCase()}-panel-${panelId}`;
  }

  /**
   * Setup event handlers to forward CLI manager events to panel events
   */
  protected setupEventHandlers(): void {
    const managers = [this.cliManager, ...this.additionalCliManagers];
    for (const manager of managers) this.setupEventHandlersForManager(manager);
  }

  private setupEventHandlersForManager(manager: AbstractCliManager): void {
    // Forward output events
    manager.on('output', (data: { panelId: string; sessionId: string; type: string; data: unknown; timestamp: Date }) => {
      const { panelId, sessionId } = data;
      if (panelId && this.panelMappings.has(panelId)) {
        try {
          if (this.sessionManager?.addPanelOutput) {
            this.sessionManager.addPanelOutput(panelId, {
              type: data.type as 'json' | 'stdout' | 'stderr' | 'error',
              data: data.data,
              timestamp: data.timestamp || new Date()
            });
          }
        } catch (error) {
          this.logger?.error(`[${this.getAgentName()}PanelManager] Failed to store panel output: ${error}`);
        }

        manager.emit('panel-output', {
          panelId,
          sessionId,
          type: data.type,
          data: data.data,
          timestamp: data.timestamp
        });
      }
    });

    // Forward spawned events
    manager.on('spawned', (data: { panelId: string; sessionId: string }) => {
      const { panelId, sessionId } = data;
      if (panelId && this.panelMappings.has(panelId)) {
        manager.emit('panel-spawned', {
          panelId,
          sessionId
        });
      }
    });

    // Forward exit events
    manager.on('exit', (data: { panelId: string; sessionId: string; exitCode?: number; signal?: string }) => {
      const { panelId, sessionId, exitCode, signal } = data;
      if (!panelId) {
        this.logger?.warn(`[${this.getAgentName()}PanelManager] Received exit event without panelId`);
        return;
      }

      const mapping = this.panelMappings.get(panelId);
      const resolvedSessionId = mapping?.sessionId ?? sessionId;

      if (!resolvedSessionId) {
        this.logger?.warn(`[${this.getAgentName()}PanelManager] Exit event for panel ${panelId} missing sessionId`);
        return;
      }

      manager.emit('panel-exit', {
        panelId,
        sessionId: resolvedSessionId,
        exitCode,
        signal
      });
    });

    // Forward error events
    manager.on('error', (data: { panelId: string; sessionId: string; error: Error | string }) => {
      const { panelId, sessionId, error } = data;
      if (panelId && this.panelMappings.has(panelId)) {
        manager.emit('panel-error', {
          panelId,
          sessionId,
          error
        });
      }
    });
  }

  /**
   * Subscribe panel to git events for the same session only
   */
  protected subscribeToGitEvents(panelId: string, sessionId: string): void {
    const gitEventCallback = (event: PanelEvent) => {
      if (event.source.panelId !== panelId && event.type.startsWith('git:')) {
        // Type assertion for git event data
        const gitEventData = event.data as {
          triggeringSessionId?: string;
          triggeringSessionName?: string;
          message?: string;
          operation?: string;
          branch?: string;
          targetBranch?: string;
        };
        
        this.logger?.verbose(`[${this.getAgentName()}] Git event received in panel ${panelId} (session: ${sessionId})`);
        this.logger?.verbose(`[${this.getAgentName()}] Event triggeringSessionId: ${gitEventData.triggeringSessionId}`);
        this.logger?.verbose(`[${this.getAgentName()}] Panel sessionId: ${sessionId}`);
        this.logger?.verbose(`[${this.getAgentName()}] Match: ${gitEventData.triggeringSessionId === sessionId}`);
        
        if (gitEventData.triggeringSessionId === sessionId) {
          this.logger?.info(`[${this.getAgentName()}] Forwarding git event to panel ${panelId} for session ${sessionId}`);
          
          const gitMessage = {
            type: 'system',
            subtype: 'git_operation',
            timestamp: event.timestamp,
            message: gitEventData.message,
            details: {
              operation: gitEventData.operation,
              triggeringSession: gitEventData.triggeringSessionName || gitEventData.triggeringSessionId,
              branch: gitEventData.branch,
              targetBranch: gitEventData.targetBranch
            }
          };

          const outputEvent = {
            panelId,
            sessionId,
            type: 'json' as const,
            data: gitMessage,
            timestamp: event.timestamp
          };

          this.cliManager.emit('output', outputEvent);
        }
      }
    };

    // Subscribe to git events for this panel
    const subscription = {
      panelId,
      eventTypes: ['git:operation_completed', 'git:operation_failed'] as PanelEventType[],  // Listen for git events
      callback: gitEventCallback
    };
    panelEventBus.subscribe(subscription);
  }

  /**
   * Register a panel with optional initial state
   * @param panelId - The panel ID to register
   * @param sessionId - The session ID this panel belongs to
   * @param initialState - Optional initial state for the panel
   * @param _isUserInitiated - Retained for call-site compatibility (default: true). Set to false during app startup/restoration.
   */
  registerPanel(panelId: string, sessionId: string, initialState?: AIPanelState, _isUserInitiated = true): void {
    const resumeId = initialState?.resumeId || this.generateResumeId(panelId);

    const mapping: PanelMapping = {
      panelId,
      sessionId,
      resumeId,
      config: initialState?.config
    };

    this.panelMappings.set(panelId, mapping);
    this.resumeIdToPanel.set(resumeId, panelId);

    this.subscribeToGitEvents(panelId, sessionId);

    this.logger?.info(`[${this.getAgentName()}PanelManager] Registered panel ${panelId} for session ${sessionId}`);
  }

  /**
   * Unregister a panel from the manager
   */
  unregisterPanel(panelId: string): void {
    const mapping = this.panelMappings.get(panelId);
    if (mapping) {
      if (mapping.resumeId) {
        this.resumeIdToPanel.delete(mapping.resumeId);
      }
      this.panelMappings.delete(panelId);
      panelEventBus.unsubscribePanel(panelId);
      this.logger?.info(`[${this.getAgentName()}PanelManager] Unregistered panel ${panelId}`);
    }
  }

  /**
   * Start a panel with unified configuration
   */
  async startPanel(config: StartPanelConfig): Promise<void> {
    const { panelId, sessionId, worktreePath, prompt } = config;

    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    // Store config for future reference
    mapping.config = config;

    const resolvedSessionId = sessionId || mapping.sessionId;
    this.logger?.info(`[${this.getAgentName()}PanelManager] Starting panel ${panelId} (session: ${resolvedSessionId})`);

    // Extract agent-specific parameters using the subclass implementation
    const manager = this.getCliManager(panelId);
    const agentParams = this.extractAgentConfig(config, manager);

    return manager.startPanel(
      panelId,
      resolvedSessionId,
      worktreePath,
      prompt,
      ...agentParams
    );
  }

  /**
   * Continue a panel conversation with unified configuration
   */
  async continuePanel(config: ContinuePanelConfig): Promise<void> {
    const { panelId, worktreePath, prompt, conversationHistory } = config;

    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    // Merge with stored config
    mapping.config = { ...mapping.config, ...config };

    this.logger?.info(`[${this.getAgentName()}PanelManager] Continuing panel ${panelId} (session: ${mapping.sessionId})`);

    // Convert conversation history to database format first
    const dbConversationHistory: ConversationMessage[] = conversationHistory.map((msg, index): ConversationMessage => ({
      id: msg.id ?? (index + 1),
      session_id: msg.session_id ?? mapping.sessionId,
      message_type: msg.message_type,
      content: msg.content,
      timestamp: msg.timestamp ?? new Date().toISOString()
    }));

    // Extract agent-specific parameters
    const manager = this.getCliManager(panelId);
    const agentParams = this.extractAgentConfig(config, manager);

    return manager.continuePanel(
      panelId,
      mapping.sessionId,
      worktreePath,
      prompt,
      dbConversationHistory,
      ...agentParams
    );
  }

  /**
   * Stop a panel
   */
  async stopPanel(panelId: string): Promise<void> {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    this.logger?.info(`[${this.getAgentName()}PanelManager] Stopping panel ${panelId}`);
    return this.getCliManager(panelId).stopPanel(panelId);
  }

  /**
   * Send input to a panel
   */
  sendInputToPanel(panelId: string, input: string): void {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      throw new Error(`Panel ${panelId} not registered`);
    }

    this.logger?.verbose(`[${this.getAgentName()}PanelManager] Sending input to panel ${panelId}`);
    this.getCliManager(panelId).sendInput(panelId, input);
  }

  /**
   * Check if panel is running
   */
  isPanelRunning(panelId: string): boolean {
    const mapping = this.panelMappings.get(panelId);
    return mapping ? this.getCliManager(panelId).isPanelRunning(panelId) : false;
  }

  /**
   * Get panel process
   */
  getPanelProcess(panelId: string): unknown {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) {
      return undefined;
    }

    return this.getCliManager(panelId).getProcess(panelId);
  }

  /**
   * Get panel state
   */
  getPanelState(panelId: string): AIPanelState | undefined {
    const mapping = this.panelMappings.get(panelId);
    if (!mapping) return undefined;

    return {
      isInitialized: this.isPanelRunning(panelId),
      resumeId: mapping.resumeId,
      lastActivityTime: new Date().toISOString(),
      config: mapping.config
    };
  }

  /**
   * Get panel ID from resume ID
   */
  getPanelIdFromResumeId(resumeId: string): string | undefined {
    return this.resumeIdToPanel.get(resumeId);
  }

  /**
   * Get all registered panels
   */
  getAllPanels(): string[] {
    return Array.from(this.panelMappings.keys());
  }

}
