/**
 * InteractiveClaudeManager — STUB (IDEA-013 / TASK-806, S1 selection seam).
 *
 * This is a throw-on-call stub. Its ONLY purpose this slice is to make the
 * `'claude-interactive'` factory branch CONSTRUCTIBLE and testable before any
 * PTY/interactive code exists:
 *
 *   - getCliToolName() returns a real name so registration/metadata is safe.
 *   - Every other abstract method throws a clear 'not implemented' error.
 *
 * The factory registers this tool with validateOnRegister:false and callers
 * pass skipValidation, so registration NEVER invokes a throwing method. The
 * real interactive substrate body (PTY spawn, transcript tail, completion via
 * the Stop hook) lands in TASK-808 / S3.
 *
 * Constructor shape mirrors ClaudeCodeManager exactly (sessionManager, logger?,
 * configManager?, db) so the factory can call both identically.
 */
import type Database from 'better-sqlite3';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { AbstractCliManager } from '../cli/AbstractCliManager';

/** Thrown by every not-yet-implemented abstract method on this stub. */
const NOT_IMPLEMENTED = 'InteractiveClaudeManager not implemented — see TASK-808';

export class InteractiveClaudeManager extends AbstractCliManager {
  constructor(
    sessionManager: import('../../sessionManager').SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    // Held for parity with ClaudeCodeManager's constructor shape; the real body
    // (TASK-808) will use it for the RawEventsSink. Unused in the stub.
    _db: Database.Database,
  ) {
    super(sessionManager, logger, configManager);
  }

  // ---------------------------------------------------------------------------
  // Required AbstractCliManager abstract-method implementations (stubbed)
  // ---------------------------------------------------------------------------

  /**
   * Returns a real name so the factory/registry can safely reference this tool
   * during registration without tripping a throw. All other methods throw.
   */
  protected getCliToolName(): string {
    return 'Claude Code (Interactive)';
  }

  protected testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected buildCommandArgs(): string[] {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected getCliExecutablePath(): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected parseCliOutput(): never {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected initializeCliEnvironment(): Promise<{ [key: string]: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected cleanupCliResources(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  protected getCliEnvironment(): Promise<{ [key: string]: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async startPanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[],
    ..._args: unknown[]
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async stopPanel(_panelId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async restartPanelWithHistory(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
