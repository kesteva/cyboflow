import { AbstractAIPanelManager } from '../ai/AbstractAIPanelManager';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { AIPanelConfig, StartPanelConfig, ContinuePanelConfig } from '../../../../../shared/types/aiPanelConfig';
import { ClaudePanelState } from '../../../../../shared/types/panels';
import type { ReasoningEffort } from '../../../../../shared/types/reasoningEffort';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import { resolveSubstrate } from '../../../orchestrator/substrateResolver';

export type PanelSubstrateLookup = (panelId: string) => CliSubstrate | null | undefined;

/**
 * Manager for Claude Code panels
 * Uses unified configuration object approach
 */
export class ClaudePanelManager extends AbstractAIPanelManager {
  
  constructor(
    claudeCodeManager: AbstractCliManager,
    sessionManager: import('../../sessionManager').SessionManager,
    logger?: Logger,
    configManager?: ConfigManager,
    interactiveCliManager?: AbstractCliManager,
    panelSubstrateLookup?: PanelSubstrateLookup,
  ) {
    super(claudeCodeManager, sessionManager, logger, configManager, interactiveCliManager ? [interactiveCliManager] : []);
    this.interactiveCliManager = interactiveCliManager;
    this.panelSubstrateLookup = panelSubstrateLookup;
  }

  private readonly interactiveCliManager?: AbstractCliManager;
  private readonly panelSubstrateLookup?: PanelSubstrateLookup;

  protected getCliManager(panelId: string): AbstractCliManager {
    const sessionId = this.panelMappings.get(panelId)?.sessionId;
    const session = sessionId && typeof this.sessionManager.getDbSession === 'function'
      ? this.sessionManager.getDbSession(sessionId)
      : undefined;
    const substrate = resolveSubstrate({
      panelOverrideSubstrate: this.panelSubstrateLookup?.(panelId),
      requestedSubstrate: session?.substrate,
      // Panel routing inherits only the session value. Do not consult the
      // process environment here: doing so would change legacy session-level
      // routing for panels without an override.
      env: {},
    });
    if (substrate === 'interactive' && this.interactiveCliManager) {
      return this.interactiveCliManager;
    }
    return this.cliManager;
  }

  /**
   * Get the agent name for logging and identification
   */
  protected getAgentName(): string {
    return 'Claude';
  }

  /**
   * Extract Claude-specific configuration parameters
   * Claude uses: permissionMode, model, fastMode, reasoningEffort
   */
  protected extractAgentConfig(config: AIPanelConfig, manager?: AbstractCliManager): unknown[] {
    if (manager && manager !== this.cliManager) {
      // InteractiveClaudeManager accepts permission + model for a panel turn;
      // fast-mode/reasoning are SDK-only spawn options and must not shift the
      // interactive manager's positional arguments.
      return [config.permissionMode, config.model];
    }
    return [
      config.permissionMode, // 'approve' | 'ignore' | undefined
      config.model,          // model string
      config.fastMode,       // Opus fast-mode opt-in (persisted per-panel)
      config.reasoningEffort // per-agent reasoning-effort selection (IDEA-029)
    ];
  }

  /**
   * Claude-specific panel start method for backward compatibility
   * Delegates to the base class startPanel with unified config
   */
  async startPanel(panelId: string, worktreePath: string, prompt: string, permissionMode?: 'approve' | 'ignore', model?: string, fastMode?: boolean, reasoningEffort?: ReasoningEffort): Promise<void>;
  async startPanel(config: StartPanelConfig): Promise<void>;
  async startPanel(
    panelIdOrConfig: string | StartPanelConfig,
    worktreePath?: string,
    prompt?: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    fastMode?: boolean,
    reasoningEffort?: ReasoningEffort
  ): Promise<void> {
    // Handle both signatures for backward compatibility
    if (typeof panelIdOrConfig === 'string') {
      const config: StartPanelConfig = {
        panelId: panelIdOrConfig,
        worktreePath: worktreePath!,
        prompt: prompt!,
        permissionMode,
        model,
        fastMode,
        reasoningEffort
      };
      return super.startPanel(config);
    } else {
      return super.startPanel(panelIdOrConfig);
    }
  }

  /**
   * Claude-specific panel continue method for backward compatibility
   * Delegates to the base class continuePanel with unified config
   */
  async continuePanel(panelId: string, worktreePath: string, prompt: string, conversationHistory: ConversationMessage[], model?: string, fastMode?: boolean, reasoningEffort?: ReasoningEffort): Promise<void>;
  async continuePanel(config: ContinuePanelConfig): Promise<void>;
  async continuePanel(
    panelIdOrConfig: string | ContinuePanelConfig,
    worktreePath?: string,
    prompt?: string,
    conversationHistory?: ConversationMessage[],
    model?: string,
    fastMode?: boolean,
    reasoningEffort?: ReasoningEffort
  ): Promise<void> {
    // Handle both signatures for backward compatibility
    if (typeof panelIdOrConfig === 'string') {
      const config: ContinuePanelConfig = {
        panelId: panelIdOrConfig,
        worktreePath: worktreePath!,
        prompt: prompt!,
        conversationHistory: conversationHistory!,
        model,
        fastMode,
        reasoningEffort
      };
      return super.continuePanel(config);
    } else {
      return super.continuePanel(panelIdOrConfig);
    }
  }

  /**
   * Get Claude-specific panel state
   * Returns ClaudePanelState with claudeResumeId instead of generic resumeId
   */
  getPanelState(panelId: string): ClaudePanelState | undefined {
    const baseState = super.getPanelState(panelId);
    if (!baseState) {
      return undefined;
    }

    // Transform base state to Claude-specific state
    return {
      isInitialized: baseState.isInitialized,
      claudeResumeId: baseState.resumeId, // Map resumeId to claudeResumeId for Claude
      lastActivityTime: baseState.lastActivityTime
    };
  }

  /**
   * Register panel with Claude-specific state handling
   * @param panelId - The panel ID to register
   * @param sessionId - The session ID this panel belongs to
   * @param initialState - Optional Claude-specific initial state
   * @param isUserInitiated - Whether the panel was created by a user action (default: true). Set to false during app startup/restoration.
   */
  registerPanel(panelId: string, sessionId: string, initialState?: ClaudePanelState, isUserInitiated = true): void {
    // Transform Claude-specific state to base state if needed
    const baseInitialState = initialState ? {
      ...initialState,
      resumeId: initialState.claudeResumeId // Map claudeResumeId to resumeId for base class
    } : undefined;

    super.registerPanel(panelId, sessionId, baseInitialState, isUserInitiated);
  }
}
