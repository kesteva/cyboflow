import type { Logger } from '../utils/logger';
import type { ConfigManager } from './configManager';
import { AbstractCliManager } from './panels/cli/AbstractCliManager';
import type { SessionManager } from './sessionManager';

/**
 * A registered CLI tool: its id, a display name, and the factory that builds
 * its manager.
 */
export interface CliToolDefinition {
  /** Unique identifier for the CLI tool (e.g. 'claude', 'codex-sdk') */
  id: string;

  /** Display name for the tool */
  name: string;

  /** Factory function to create the CLI manager instance */
  managerFactory: CliManagerFactory;
}

/**
 * Factory function type for creating CLI managers
 */
export type CliManagerFactory = (
  sessionManager: SessionManager | null,
  logger?: Logger,
  configManager?: ConfigManager,
  additionalOptions?: Record<string, unknown>
) => AbstractCliManager;

/**
 * Options for tool registration
 */
export interface ToolRegistrationOptions {
  /** Whether to override existing registration */
  override?: boolean;
}

/**
 * Central registry of the built-in CLI tools.
 *
 * Singleton: holds each tool's definition and caches one manager instance per
 * tool id. `shutdown()` kills every manager's processes and drops the manager
 * cache but keeps the tool definitions.
 */
export class CliToolRegistry {
  private static instance: CliToolRegistry | null = null;
  private readonly tools: Map<string, CliToolDefinition> = new Map();
  private readonly managers: Map<string, AbstractCliManager> = new Map();

  private constructor(
    private logger?: Logger,
    private configManager?: ConfigManager
  ) {
    this.logger?.info('[CliToolRegistry] Initialized CLI tool registry');
  }

  /**
   * Get the singleton instance of the CLI tool registry
   */
  public static getInstance(logger?: Logger, configManager?: ConfigManager): CliToolRegistry {
    if (!CliToolRegistry.instance) {
      CliToolRegistry.instance = new CliToolRegistry(logger, configManager);
    }
    return CliToolRegistry.instance;
  }

  /**
   * Register a CLI tool with the registry
   */
  public registerTool(definition: CliToolDefinition, options: ToolRegistrationOptions = {}): void {
    const { override = false } = options;

    if (this.tools.has(definition.id) && !override) {
      throw new Error(`CLI tool '${definition.id}' is already registered. Use override: true to replace.`);
    }

    this.validateToolDefinition(definition);
    this.tools.set(definition.id, definition);

    this.logger?.info(`[CliToolRegistry] Registered CLI tool: ${definition.name} (${definition.id})`);
  }

  /**
   * Create (or reuse) the CLI manager instance for a specific tool
   */
  public async createManager(
    toolId: string,
    sessionManager: SessionManager,
    additionalOptions?: Record<string, unknown>
  ): Promise<AbstractCliManager> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`CLI tool '${toolId}' is not registered`);
    }

    // Check if we already have a manager instance
    const existingManager = this.managers.get(toolId);
    if (existingManager) {
      this.logger?.verbose(`[CliToolRegistry] Reusing existing manager for tool '${toolId}'`);
      return existingManager;
    }

    // Create new manager instance
    try {
      const manager = tool.managerFactory(
        sessionManager,
        this.logger,
        this.configManager,
        additionalOptions
      );

      // Store manager instance
      this.managers.set(toolId, manager);

      this.logger?.info(`[CliToolRegistry] Created manager for CLI tool: ${tool.name} (${toolId})`);

      return manager;
    } catch (error) {
      this.logger?.error(`[CliToolRegistry] Failed to create manager for tool '${toolId}':`, error instanceof Error ? error : undefined);
      throw new Error(`Failed to create manager for CLI tool '${toolId}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Shutdown all managers and clean up resources
   */
  public async shutdown(): Promise<void> {
    this.logger?.info(`[CliToolRegistry] Shutting down ${this.managers.size} CLI tool managers`);

    const shutdownPromises = Array.from(this.managers.entries()).map(async ([toolId, manager]) => {
      try {
        await manager.killAllProcesses();
        this.logger?.verbose(`[CliToolRegistry] Shut down manager for tool '${toolId}'`);
      } catch (error) {
        this.logger?.error(`[CliToolRegistry] Error shutting down manager for tool '${toolId}':`, error instanceof Error ? error : undefined);
      }
    });

    await Promise.all(shutdownPromises);
    this.managers.clear();

    this.logger?.info(`[CliToolRegistry] Registry shutdown complete`);
  }

  /**
   * Validate a tool definition for completeness
   */
  private validateToolDefinition(definition: CliToolDefinition): void {
    if (!definition.id || !definition.name) {
      throw new Error(`CLI tool definition requires an id and a name`);
    }

    if (typeof definition.managerFactory !== 'function') {
      throw new Error(`CLI tool definition managerFactory must be a function`);
    }
  }
}
