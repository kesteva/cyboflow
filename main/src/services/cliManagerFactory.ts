import type Database from 'better-sqlite3';
import type { Logger } from '../utils/logger';
import type { ConfigManager } from './configManager';
import type { SessionManager } from './sessionManager';
import { AbstractCliManager } from './panels/cli/AbstractCliManager';
import { ClaudeCodeManager } from './panels/claude/claudeCodeManager';
import { InteractiveClaudeManager } from './panels/claude/interactiveClaudeManager';
import { CodexPtyManager } from './panels/codex/codexPtyManager';
import { CodexSdkManager } from './panels/codex/codexSdkManager';
import {
  CliToolRegistry,
  CliToolDefinition,
  CliManagerFactory as ManagerFactoryFunction,
  CLI_OUTPUT_FORMATS
} from './cliToolRegistry';
import { DemoCliManager } from './demo/demoCliManager';

/** Structural guard for the better-sqlite3 handle passed via additionalOptions.db. */
function isSqliteDatabase(value: unknown): value is Database.Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function' &&
    typeof (value as { transaction?: unknown }).transaction === 'function'
  );
}

/**
 * Preserve startup's concrete Codex instanceof guards without invoking either
 * Codex constructor. The returned object owns DemoCliManager's state and
 * overrides, while the compatibility prototype supplies only the expected
 * nominal identity and inherited AbstractCliManager surface.
 */
function createDemoCompatibilityAdapter<T extends AbstractCliManager>(
  demoManager: DemoCliManager,
  compatibilityPrototype: object,
): T {
  const adapter = Object.create(compatibilityPrototype) as T;
  Object.defineProperties(adapter, Object.getOwnPropertyDescriptors(demoManager));

  for (const propertyName of Object.getOwnPropertyNames(DemoCliManager.prototype)) {
    if (propertyName === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(DemoCliManager.prototype, propertyName);
    if (descriptor) Object.defineProperty(adapter, propertyName, descriptor);
  }

  return adapter;
}

/**
 * Factory configuration for CLI manager creation
 */
export interface CliManagerFactoryConfig {
  /** Session manager instance */
  sessionManager: unknown;

  /** Logger instance */
  logger?: Logger;

  /** Configuration manager instance */
  configManager?: ConfigManager;

  /** Additional tool-specific options */
  additionalOptions?: Record<string, unknown>;

  /** Skip tool availability validation (useful for startup) */
  skipValidation?: boolean;
}

/**
 * Factory for creating CLI tool managers
 * 
 * This factory provides a centralized way to create and configure
 * CLI tool managers (Claude, Aider, Continue, etc.) with proper
 * dependency injection and configuration validation.
 */
export class CliManagerFactory {
  private static instance: CliManagerFactory | null = null;
  private readonly registry: CliToolRegistry;
  /** Demo-mode manager cache — one DemoCliManager per toolId (see createManager). */
  private readonly demoManagers = new Map<string, AbstractCliManager>();
  /** Captured from the first demo manager request; later boot calls may omit db. */
  private demoDatabase: Database.Database | undefined;

  private constructor(
    private logger?: Logger,
    private configManager?: ConfigManager
  ) {
    this.registry = CliToolRegistry.getInstance(logger, configManager);
    this.registerBuiltInTools();
  }

  /**
   * Get the singleton instance of the CLI manager factory
   */
  public static getInstance(logger?: Logger, configManager?: ConfigManager): CliManagerFactory {
    if (!CliManagerFactory.instance) {
      CliManagerFactory.instance = new CliManagerFactory(logger, configManager);
    }
    return CliManagerFactory.instance;
  }

  /**
   * Create a CLI manager for the specified tool
   */
  public async createManager(
    toolId: string,
    config: CliManagerFactoryConfig
  ): Promise<AbstractCliManager> {
    try {
      this.validateConfig(config);

      // Demo mode (read once at boot): tool ids resolve to a scripted
      // DemoCliManager, so both the orchestrator spawn path and panel chat play
      // canned runs instead of spawning Claude. One instance per toolId — the
      // SubstrateDispatchFacade subscribes to its two managers separately, and
      // sharing one instance would double-emit every event.
      //
      // EXCEPTION: 'claude-interactive' stays REAL even in demo. The boot
      // wiring narrows it to the concrete InteractiveClaudeManager (index.ts
      // AppServices + the sessions:input PTY relay seam) and would throw on a
      // demo stand-in. Safe because demo never routes a spawn to it:
      // WorkflowRegistry.createRun pins demo workflow runs to 'sdk', and the
      // quick-session input seam short-circuits interactive relay in demo, so
      // this manager is constructed but never engaged while demo mode is on.
      if (this.configManager?.isDemoMode() && toolId !== 'claude-interactive') {
        const existing = this.demoManagers.get(toolId);
        if (existing) return existing;

        const requestedDb = config.additionalOptions?.db;
        if (requestedDb !== undefined && !isSqliteDatabase(requestedDb)) {
          throw new Error('[CliManagerFactory] demo mode requires additionalOptions.db');
        }
        const db = requestedDb ?? this.demoDatabase;
        if (!isSqliteDatabase(db)) {
          throw new Error('[CliManagerFactory] demo mode requires additionalOptions.db');
        }
        this.demoDatabase = db;
        const demoManager = new DemoCliManager(
          config.sessionManager as SessionManager,
          this.logger,
          this.configManager,
          db,
        );

        // index.ts currently narrows these startup services with instanceof and
        // calls their runtime-specific setup methods. Supply demo-backed
        // compatibility objects so those guards remain true while no real Codex
        // manager constructor or runtime can be reached.
        const manager: AbstractCliManager = toolId === 'codex-sdk'
          ? createDemoCompatibilityAdapter<CodexSdkManager>(
              demoManager,
              CodexSdkManager.prototype,
            )
          : toolId === 'codex-pty'
            ? createDemoCompatibilityAdapter<CodexPtyManager>(
                demoManager,
                CodexPtyManager.prototype,
              )
            : demoManager;

        if (toolId === 'codex-sdk') {
          Object.defineProperties(manager, {
            setCyboflowMcpRuntimeConfig: {
              configurable: true,
              value: () => {},
            },
            setApprovalRouterProvider: {
              configurable: true,
              value: () => {},
            },
          });
        } else if (toolId === 'codex-pty') {
          Object.defineProperties(manager, {
            relayUserTurn: { configurable: true, value: () => {} },
            relayRawInput: { configurable: true, value: () => {} },
            resizePanel: { configurable: true, value: () => {} },
            getPtyBacklog: { configurable: true, value: () => '' },
          });
        }

        this.demoManagers.set(toolId, manager);
        this.logger?.info(`[CliManagerFactory] Demo mode — created DemoCliManager for tool '${toolId}'`);
        return manager;
      }

      const manager = await this.registry.createManager(
        toolId,
        config.sessionManager as SessionManager,
        config.additionalOptions,
        config.skipValidation
      );

      this.logger?.info(`[CliManagerFactory] Created ${toolId} manager successfully`);
      return manager;
    } catch (error) {
      this.logger?.error(`[CliManagerFactory] Failed to create ${toolId} manager:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get an existing manager instance
   */
  public getManager(toolId: string): AbstractCliManager | undefined {
    return this.registry.getManager(toolId);
  }

  /**
   * Get the default CLI manager (first available tool)
   */
  public async getDefaultManager(config: CliManagerFactoryConfig): Promise<AbstractCliManager> {
    const defaultTool = await this.registry.getDefaultTool();
    
    if (!defaultTool) {
      throw new Error('No CLI tools are available on this system');
    }

    return this.createManager(defaultTool.id, config);
  }

  /**
   * Get all available CLI tools
   */
  public async getAvailableTools(): Promise<CliToolDefinition[]> {
    return this.registry.getAvailableTools();
  }

  /**
   * Check if a specific tool is available
   */
  public async isToolAvailable(toolId: string): Promise<boolean> {
    const result = await this.registry.checkToolAvailability(toolId);
    return result.available;
  }

  /**
   * Discover all available CLI tools on the system
   */
  public async discoverTools() {
    return this.registry.discoverTools();
  }

  /**
   * Register a custom CLI tool
   */
  public registerTool(definition: CliToolDefinition): void {
    this.registry.registerTool(definition);
  }

  /**
   * Clear availability cache
   */
  public clearCache(toolId?: string): void {
    this.registry.clearAvailabilityCache(toolId);
  }

  /**
   * Shutdown all managers
   */
  public async shutdown(): Promise<void> {
    await this.registry.shutdown();
    CliManagerFactory.instance = null;
  }

  /**
   * Register built-in CLI tools
   */
  private registerBuiltInTools(): void {
    // Register Claude Code (SDK substrate — the default).
    this.registerClaudeTool();

    // Register Claude Code (Interactive PTY substrate — IDEA-013 / TASK-806).
    // Registered with a LOWER priority than 'claude' (100) so getDefaultTool()
    // still prefers the SDK path; the manager body is a stub until TASK-808/S3.
    this.registerInteractiveClaudeTool();

    // Register Codex PTY quick-session runtime.
    this.registerCodexSdkTool();
    this.registerCodexPtyTool();

    // Future tools can be registered here:
    // this.registerAiderTool();
    // this.registerContinueTool();
    // this.registerCursorTool();

    this.logger?.info('[CliManagerFactory] Registered built-in CLI tools');
  }

  /**
   * Register Claude Code CLI tool
   */
  private registerClaudeTool(): void {
    const claudeManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
      additionalOptions?: unknown,
    ) => {
      const options = additionalOptions as Record<string, unknown> | undefined;
      const dbCandidate = options?.db;
      if (!dbCandidate) {
        throw new TypeError('[CliManagerFactory] claude tool requires `db` in additionalOptions');
      }
      if (
        typeof dbCandidate !== 'object' ||
        typeof (dbCandidate as { prepare?: unknown }).prepare !== 'function'
      ) {
        throw new TypeError(
          '[CliManagerFactory] claude tool: additionalOptions.db must be a better-sqlite3 Database instance (received a value lacking a .prepare() method)',
        );
      }
      const db = dbCandidate as Database.Database;
      return new ClaudeCodeManager(
        sessionManager as SessionManager,
        logger,
        configManager,
        db,
      );
    };

    const claudeDefinition: CliToolDefinition = {
      id: 'claude',
      name: 'Claude Code',
      description: 'Anthropic\'s Claude AI coding assistant with advanced tool calling capabilities',
      version: '1.0.0',
      capabilities: {
        supportsResume: true,
        supportsMultipleModels: true,
        supportsPermissions: true,
        supportsFileOperations: true,
        supportsGitIntegration: true,
        supportsSystemPrompts: true,
        supportsStructuredOutput: true,
        outputFormats: [
          CLI_OUTPUT_FORMATS.TEXT,
          CLI_OUTPUT_FORMATS.JSON,
          CLI_OUTPUT_FORMATS.STREAM_JSON
        ],
        supportedPanelTypes: ['claude']
      },
      config: {
        requiredEnvVars: [],
        optionalEnvVars: [
          'ANTHROPIC_API_KEY',
          'MCP_DEBUG'
        ],
        requiredConfigKeys: [],
        optionalConfigKeys: [
          'claudeExecutablePath',
          'defaultPermissionMode',
          'systemPromptAppend',
          'verbose'
        ],
        defaultExecutable: 'claude',
        alternativeExecutables: ['claude-code', 'claude.exe'],
        minimumVersion: undefined // Claude doesn't expose version in a standard way
      },
      managerFactory: claudeManagerFactory
    };

    this.registry.registerTool(claudeDefinition, {
      priority: 100, // Highest priority as it's the primary tool
      validateOnRegister: false // Skip validation on startup for performance
    });
  }

  /**
   * Register the interactive Claude Code CLI tool (IDEA-013 / TASK-806).
   *
   * Mirrors registerClaudeTool's db-guard exactly (same TypeError when
   * additionalOptions.db is missing or lacks .prepare). The managerFactory
   * returns an InteractiveClaudeManager — a throw-on-call STUB this slice; the
   * real PTY body lands in TASK-808/S3. Registered with priority < 100 so
   * getDefaultTool() continues to prefer the SDK 'claude' tool.
   */
  private registerInteractiveClaudeTool(): void {
    const interactiveManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
      additionalOptions?: unknown,
    ) => {
      const options = additionalOptions as Record<string, unknown> | undefined;
      const dbCandidate = options?.db;
      if (!dbCandidate) {
        throw new TypeError('[CliManagerFactory] claude-interactive tool requires `db` in additionalOptions');
      }
      if (
        typeof dbCandidate !== 'object' ||
        typeof (dbCandidate as { prepare?: unknown }).prepare !== 'function'
      ) {
        throw new TypeError(
          '[CliManagerFactory] claude-interactive tool: additionalOptions.db must be a better-sqlite3 Database instance (received a value lacking a .prepare() method)',
        );
      }
      const db = dbCandidate as Database.Database;
      return new InteractiveClaudeManager(
        sessionManager as SessionManager,
        logger,
        configManager,
        db,
      );
    };

    const interactiveDefinition: CliToolDefinition = {
      id: 'claude-interactive',
      name: 'Claude Code (Interactive)',
      description: 'Claude Code running under the interactive PTY substrate (IDEA-013)',
      version: '1.0.0',
      capabilities: {
        supportsResume: true,
        supportsMultipleModels: true,
        supportsPermissions: true,
        supportsFileOperations: true,
        supportsGitIntegration: true,
        supportsSystemPrompts: true,
        supportsStructuredOutput: true,
        outputFormats: [
          CLI_OUTPUT_FORMATS.TEXT,
          CLI_OUTPUT_FORMATS.JSON,
          CLI_OUTPUT_FORMATS.STREAM_JSON
        ],
        supportedPanelTypes: ['claude']
      },
      config: {
        requiredEnvVars: [],
        optionalEnvVars: [
          'ANTHROPIC_API_KEY',
          'MCP_DEBUG'
        ],
        requiredConfigKeys: [],
        optionalConfigKeys: [
          'claudeExecutablePath',
          'defaultPermissionMode',
          'systemPromptAppend',
          'verbose'
        ],
        defaultExecutable: 'claude',
        alternativeExecutables: ['claude-code', 'claude.exe'],
        minimumVersion: undefined
      },
      managerFactory: interactiveManagerFactory
    };

    this.registry.registerTool(interactiveDefinition, {
      priority: 50, // Below 'claude' (100) so getDefaultTool() prefers the SDK path
      validateOnRegister: false // Stub body — never probe availability this slice
    });
  }

  private registerCodexPtyTool(): void {
    const codexPtyManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
    ) => {
      return new CodexPtyManager(
        sessionManager as SessionManager,
        logger,
        configManager,
      );
    };

    const codexPtyDefinition: CliToolDefinition = {
      id: 'codex-pty',
      name: 'Codex (PTY)',
      description: 'OpenAI Codex running as an interactive PTY quick-session runtime',
      version: '1.0.0',
      capabilities: {
        supportsResume: false,
        supportsMultipleModels: true,
        supportsPermissions: true,
        supportsFileOperations: true,
        supportsGitIntegration: true,
        supportsSystemPrompts: false,
        supportsStructuredOutput: false,
        outputFormats: [
          CLI_OUTPUT_FORMATS.TEXT,
        ],
        supportedPanelTypes: ['claude'],
      },
      config: {
        requiredEnvVars: [],
        optionalEnvVars: [],
        requiredConfigKeys: [],
        optionalConfigKeys: [],
        defaultExecutable: 'codex',
        alternativeExecutables: ['codex'],
        minimumVersion: undefined,
      },
      managerFactory: codexPtyManagerFactory,
    };

    this.registry.registerTool(codexPtyDefinition, {
      priority: 40,
      validateOnRegister: false,
    });
  }

  private registerCodexSdkTool(): void {
    const codexSdkManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
      additionalOptions?: unknown,
    ) => {
      const options = additionalOptions as Record<string, unknown> | undefined;
      const dbCandidate = options?.db;
      if (!dbCandidate) {
        throw new TypeError('[CliManagerFactory] codex-sdk tool requires `db` in additionalOptions');
      }
      if (
        typeof dbCandidate !== 'object' ||
        typeof (dbCandidate as { prepare?: unknown }).prepare !== 'function'
      ) {
        throw new TypeError(
          '[CliManagerFactory] codex-sdk tool: additionalOptions.db must be a better-sqlite3 Database instance (received a value lacking a .prepare() method)',
        );
      }
      const db = dbCandidate as Database.Database;
      return new CodexSdkManager(
        sessionManager as SessionManager,
        logger,
        configManager,
        db,
      );
    };

    const codexSdkDefinition: CliToolDefinition = {
      id: 'codex-sdk',
      name: 'Codex SDK',
      description: 'OpenAI Codex running through the embedded SDK workflow runtime',
      version: '1.0.0',
      capabilities: {
        supportsResume: true,
        supportsMultipleModels: true,
        supportsPermissions: true,
        supportsFileOperations: true,
        supportsGitIntegration: true,
        supportsSystemPrompts: false,
        supportsStructuredOutput: true,
        outputFormats: [
          CLI_OUTPUT_FORMATS.JSON,
          CLI_OUTPUT_FORMATS.STREAM_JSON,
        ],
        supportedPanelTypes: ['claude'],
      },
      config: {
        requiredEnvVars: [],
        optionalEnvVars: [],
        requiredConfigKeys: [],
        optionalConfigKeys: [],
        defaultExecutable: '@openai/codex-sdk',
        alternativeExecutables: [],
        minimumVersion: undefined,
      },
      managerFactory: codexSdkManagerFactory,
    };

    this.registry.registerTool(codexSdkDefinition, {
      priority: 45,
      validateOnRegister: false,
    });
  }

  /**
   * Future: Register Aider CLI tool
   * 
   * Example of how other tools would be registered:
   */
  private registerAiderTool(): void {
    // Implementation would be similar to Claude but with Aider-specific capabilities
    // const aiderDefinition: CliToolDefinition = { ... };
    // this.registry.registerTool(aiderDefinition);
  }

  /**
   * Validate factory configuration
   */
  private validateConfig(config: CliManagerFactoryConfig): void {
    if (!config.sessionManager) {
      throw new Error('Session manager is required for CLI manager creation');
    }

    // Additional validation can be added here
  }
}

/**
 * Convenience function to get the factory instance
 */
export const getCliManagerFactory = (logger?: Logger, configManager?: ConfigManager) => 
  CliManagerFactory.getInstance(logger, configManager);

/**
 * Convenience function to create a Claude manager (backward compatibility)
 */
export const createClaudeManager = async (config: CliManagerFactoryConfig): Promise<AbstractCliManager> => {
  const factory = CliManagerFactory.getInstance(config.logger, config.configManager);
  return factory.createManager('claude', config);
};

/**
 * Example of how future tools would be created:
 */
export const createAiderManager = async (config: CliManagerFactoryConfig): Promise<AbstractCliManager> => {
  const factory = CliManagerFactory.getInstance(config.logger, config.configManager);
  return factory.createManager('aider', config);
};

export const createContinueManager = async (config: CliManagerFactoryConfig): Promise<AbstractCliManager> => {
  const factory = CliManagerFactory.getInstance(config.logger, config.configManager);
  return factory.createManager('continue', config);
};
