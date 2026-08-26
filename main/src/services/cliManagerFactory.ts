import type Database from 'better-sqlite3';
import type { Logger } from '../utils/logger';
import type { ConfigManager } from './configManager';
import type { SessionManager } from './sessionManager';
import { AbstractCliManager } from './panels/cli/AbstractCliManager';
import { ClaudeCodeManager } from './panels/claude/claudeCodeManager';
import { InteractiveClaudeManager } from './panels/claude/interactiveClaudeManager';
import { CodexPtyManager } from './panels/codex/codexPtyManager';
import { CodexSdkManager } from './panels/codex/codexSdkManager';
import { OmpPtyManager } from './panels/omp/ompPtyManager';
import { OmpSdkManager } from './panels/omp/ompSdkManager';
import { PiPtyManager } from './panels/pi/piPtyManager';
import { PiSdkManager } from './panels/pi/piSdkManager';
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
 * The seams a Codex SDK manager must expose BEYOND AbstractCliManager — the
 * runtime-specific methods boot injects into and the IPC layer calls.
 *
 * Derived with `Pick` from the concrete class rather than hand-written, so the
 * signatures cannot drift from it and a change to (say) what
 * `detectChatGptAccount` returns lands here automatically.
 */
type CodexSdkSeams = Pick<
  CodexSdkManager,
  | 'setCyboflowMcpRuntimeConfig'
  | 'setApprovalRouterProvider'
  | 'setQuestionRouterProvider'
  | 'getCodexModelCatalog'
  | 'detectChatGptAccount'
>;

/**
 * The Codex PTY seams beyond AbstractCliManager: spawning a terminal panel and
 * relaying a turn into a live one.
 *
 * Only what a caller reaches THROUGH `AppServices.codexPtyManager`. The manager
 * also has `relayRawInput`, `resizePanel` and `getPtyBacklog`, but no production
 * caller goes through this bag for them — the dispatch facade feature-detects
 * `resizePanel` off a plain AbstractCliManager, and `getPtyBacklog` is served by
 * the facade's own method — so listing them here would widen the contract past
 * what anything asks of it.
 */
type CodexPtySeams = Pick<CodexPtyManager, 'startPanel' | 'relayUserTurn'>;

/**
 * What the app actually needs of a Codex SDK manager: the CLI base plus the
 * seams above. STRUCTURAL on purpose — boot used to narrow the factory's
 * `AbstractCliManager` return with `instanceof CodexSdkManager`, which forced
 * demo mode to fabricate an object grafted onto the real class prototype just to
 * satisfy the guard. That graft also let every un-stubbed Codex method resolve to
 * the REAL implementation with demo state behind it, which is the opposite of
 * what demo mode promises.
 */
export type CodexSdkManagerLike = AbstractCliManager & CodexSdkSeams;

/** The Codex PTY twin of {@link CodexSdkManagerLike}. */
export type CodexPtyManagerLike = AbstractCliManager & CodexPtySeams;

/** Does this manager expose the Codex SDK seams? */
export function isCodexSdkManagerLike(manager: AbstractCliManager): manager is CodexSdkManagerLike {
  const seams = manager as Partial<CodexSdkSeams>;
  return (
    typeof seams.setCyboflowMcpRuntimeConfig === 'function' &&
    typeof seams.setApprovalRouterProvider === 'function' &&
    typeof seams.setQuestionRouterProvider === 'function' &&
    typeof seams.getCodexModelCatalog === 'function' &&
    typeof seams.detectChatGptAccount === 'function'
  );
}

/** Does this manager expose the Codex PTY seams? */
export function isCodexPtyManagerLike(manager: AbstractCliManager): manager is CodexPtyManagerLike {
  const seams = manager as Partial<CodexPtySeams>;
  return typeof seams.startPanel === 'function' && typeof seams.relayUserTurn === 'function';
}

/**
 * The seams an OMP RPC manager must expose BEYOND AbstractCliManager.
 *
 * Shorter than {@link CodexSdkSeams} because OMP needs less injected: its tool
 * approval dialogs are answered in-process by `OmpApprovalBridge`, while content
 * dialogs use the shared question router. It has no vendor-account probe. What remains
 * is the MCP runtime config and question router boot injects, plus the catalogue accessor — which
 * the model picker does NOT route through (`ipc/models.ts` reads the shared
 * probe directly, because the picker can be opened in Settings before any OMP
 * session exists) but which belongs in the contract anyway: it is the one seam
 * that must reach the vendor binary, so demo mode has to refuse it.
 * Derived with `Pick` for the same anti-drift reason.
 */
type OmpSdkSeams = Pick<
  OmpSdkManager,
  'setCyboflowMcpRuntimeConfig' | 'setQuestionRouterProvider' | 'getOmpModelCatalog'
>;

/** The OMP PTY seams beyond AbstractCliManager — the Codex PTY pair exactly. */
type OmpPtySeams = Pick<OmpPtyManager, 'startPanel' | 'relayUserTurn'>;

/** The Pi PTY seams — identical shape to the OMP/Codex PTY pair. */
type PiPtySeams = Pick<PiPtyManager, 'startPanel' | 'relayUserTurn'>;

/** The Pi SDK seams: the lifecycle is all on AbstractCliManager in v1. */
type PiSdkSeams = Record<string, never>;

/** What the app needs of an OMP RPC manager — the CLI base plus its seams. */
export type OmpSdkManagerLike = AbstractCliManager & OmpSdkSeams;

/** The OMP PTY twin of {@link OmpSdkManagerLike}. */
export type OmpPtyManagerLike = AbstractCliManager & OmpPtySeams;

export type PiPtyManagerLike = AbstractCliManager & PiPtySeams;

export type PiSdkManagerLike = AbstractCliManager & PiSdkSeams;

/** Does this manager expose the Pi PTY seams? */
export function isPiPtyManagerLike(manager: AbstractCliManager): manager is PiPtyManagerLike {
  const seams = manager as Partial<PiPtySeams>;
  return typeof seams.startPanel === 'function' && typeof seams.relayUserTurn === 'function';
}

/**
 * Every AbstractCliManager instance satisfies PiSdkSeams (it is empty), but the
 * guard keeps call sites symmetric with the other lanes and future-proof.
 */
export function isPiSdkManagerLike(manager: AbstractCliManager): manager is PiSdkManagerLike {
  void manager;
  return true;
}
/** Does this manager expose the OMP SDK seams? */
export function isOmpSdkManagerLike(manager: AbstractCliManager): manager is OmpSdkManagerLike {
  const seams = manager as Partial<OmpSdkSeams>;
  return (
    typeof seams.setCyboflowMcpRuntimeConfig === 'function' &&
    typeof seams.setQuestionRouterProvider === 'function' &&
    typeof seams.getOmpModelCatalog === 'function'
  );
}

/** Does this manager expose the OMP PTY seams? */
export function isOmpPtyManagerLike(manager: AbstractCliManager): manager is OmpPtyManagerLike {
  const seams = manager as Partial<OmpPtySeams>;
  return typeof seams.startPanel === 'function' && typeof seams.relayUserTurn === 'function';
}

/**
 * A demo stand-in for an ASYNC seam that can only be answered by a real provider
 * runtime (an account probe, a live model catalogue). Refusing is the point:
 * demo mode must never reach the vendor's binary, and returning a plausible
 * empty answer would hide that it tried.
 *
 * `async`, not a synchronous throw: the real seams return promises, and a caller
 * that hands the promise to `.catch()` instead of awaiting it must see the same
 * failure shape either way.
 */
function demoSeamUnavailable(seam: string): () => Promise<never> {
  return async () => {
    throw new Error(`[CliManagerFactory] ${seam} is unavailable in demo mode`);
  };
}

/** The Codex SDK seams, demo-backed: injection accepted and dropped, probes refused. */
function codexSdkDemoSeams(): CodexSdkSeams {
  return {
    setCyboflowMcpRuntimeConfig: () => {},
    setApprovalRouterProvider: () => {},
    setQuestionRouterProvider: () => {},
    getCodexModelCatalog: demoSeamUnavailable('getCodexModelCatalog'),
    detectChatGptAccount: demoSeamUnavailable('detectChatGptAccount'),
  };
}

/**
 * The Codex PTY seams, demo-backed. `startPanel` is NOT among them: DemoCliManager
 * already implements it (scripted playback), and its narrower signature satisfies
 * the Codex one.
 */
function codexPtyDemoSeams(): Omit<CodexPtySeams, 'startPanel'> {
  return { relayUserTurn: () => {} };
}

/** The OMP SDK seams, demo-backed: injection accepted and dropped, probe refused. */
function ompSdkDemoSeams(): OmpSdkSeams {
  return {
    setCyboflowMcpRuntimeConfig: () => {},
    setQuestionRouterProvider: () => {},
    getOmpModelCatalog: demoSeamUnavailable('getOmpModelCatalog'),
  };
}

/** The OMP PTY seams, demo-backed. `startPanel` comes from DemoCliManager — see {@link codexPtyDemoSeams}. */
function ompPtyDemoSeams(): Omit<OmpPtySeams, 'startPanel'> {
  return { relayUserTurn: () => {} };
}

/**
 * The per-tool demo seam overlays, keyed by tool id. A Record rather than the
 * ternary chain it replaces: each provider adds a row instead of another
 * `: toolId === '…' ?` rung, and a tool with no runtime-specific seams (the
 * Claude tools) is simply absent.
 */
const DEMO_SEAM_OVERLAYS: Readonly<Record<string, () => object>> = {
  'codex-sdk': codexSdkDemoSeams,
  'codex-pty': codexPtyDemoSeams,
  'omp-sdk': ompSdkDemoSeams,
  'omp-pty': ompPtyDemoSeams,
};

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

        // Boot narrows these startup services STRUCTURALLY (isCodexSdkManagerLike
        // / isOmpSdkManagerLike / the PTY twins) and calls their runtime-specific
        // seams, so demo mode only has to supply those seams — no prototype graft,
        // and nothing un-stubbed can resolve to a real vendor implementation.
        const demoSeams = DEMO_SEAM_OVERLAYS[toolId];
        const manager: AbstractCliManager = demoSeams
          ? Object.assign(demoManager, demoSeams())
          : demoManager;

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

    // Register the OMP (oh-my-pi) quick-session runtimes, priorities below
    // Codex's so getDefaultTool() ordering is unchanged by their arrival.
    this.registerOmpSdkTool();
    this.registerOmpPtyTool();

    // Register the Pi (@earendil-works/pi-coding-agent) quick-session runtime.
    // Priority below OMP's so getDefaultTool() ordering is unchanged by its
    // arrival; the provider toggle gates reachability anyway.
    this.registerPiPtyTool();
    this.registerPiSdkTool();

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
      const appVersion = typeof options?.appVersion === 'string'
        ? options.appVersion
        : 'development';
      return new CodexSdkManager(
        sessionManager as SessionManager,
        logger,
        configManager,
        db,
        undefined,
        undefined,
        appVersion,
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

  private registerOmpPtyTool(): void {
    const ompPtyManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
    ) => {
      return new OmpPtyManager(
        sessionManager as SessionManager,
        logger,
        configManager,
      );
    };

    const ompPtyDefinition: CliToolDefinition = {
      id: 'omp-pty',
      name: 'OMP (PTY)',
      description: 'oh-my-pi running as an interactive PTY quick-session runtime',
      version: '1.0.0',
      capabilities: {
        // `--continue` is a REAL per-cwd session resume (unlike codex-pty, which
        // restarts blank), so this lane genuinely supports resume.
        supportsResume: true,
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
        defaultExecutable: 'omp',
        alternativeExecutables: ['omp'],
        minimumVersion: undefined,
      },
      managerFactory: ompPtyManagerFactory,
    };

    this.registry.registerTool(ompPtyDefinition, {
      priority: 30,
      validateOnRegister: false,
    });
  }

  private registerPiPtyTool(): void {
    const piPtyManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
    ) => {
      return new PiPtyManager(
        sessionManager as SessionManager,
        logger,
        configManager,
      );
    };

    const piPtyDefinition: CliToolDefinition = {
      id: 'pi-pty',
      name: 'Pi (PTY)',
      description: 'pi (@earendil-works/pi-coding-agent) running as an interactive PTY quick-session runtime',
      version: '1.0.0',
      capabilities: {
        // `--continue` is a REAL per-project session resume, like OMP's.
        supportsResume: true,
        supportsMultipleModels: true,
        supportsPermissions: false,
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
        defaultExecutable: 'pi',
        alternativeExecutables: ['pi'],
        minimumVersion: undefined,
      },
      managerFactory: piPtyManagerFactory,
    };

    this.registry.registerTool(piPtyDefinition, {
      priority: 25,
      validateOnRegister: false,
    });
  }


  private registerPiSdkTool(): void {
    const piSdkManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
    ) => {
      return new PiSdkManager(
        sessionManager as SessionManager,
        logger,
        configManager,
      );
    };

    const piSdkDefinition: CliToolDefinition = {
      id: 'pi-sdk',
      name: 'Pi',
      description: 'pi (@earendil-works/pi-coding-agent) structured json-events runtime (turn-spawn, --session-id resume)',
      version: '1.0.0',
      capabilities: {
        // Resume is deterministic (--session-id), so this lane genuinely
        // supports picking a conversation back up.
        supportsResume: true,
        supportsMultipleModels: true,
        supportsPermissions: false,
        supportsFileOperations: true,
        supportsGitIntegration: true,
        supportsSystemPrompts: false,
        supportsStructuredOutput: true,
        outputFormats: [
          CLI_OUTPUT_FORMATS.JSON,
          CLI_OUTPUT_FORMATS.TEXT,
        ],
        supportedPanelTypes: ['claude'],
      },
      config: {
        requiredEnvVars: [],
        optionalEnvVars: [],
        requiredConfigKeys: [],
        optionalConfigKeys: [],
        defaultExecutable: 'pi',
        alternativeExecutables: ['pi'],
        minimumVersion: undefined,
      },
      managerFactory: piSdkManagerFactory,
    };

    this.registry.registerTool(piSdkDefinition, {
      priority: 26,
      validateOnRegister: false,
    });
  }

  private registerOmpSdkTool(): void {
    const ompSdkManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
      additionalOptions?: unknown,
    ) => {
      const options = additionalOptions as Record<string, unknown> | undefined;
      const dbCandidate = options?.db;
      if (!dbCandidate) {
        throw new TypeError('[CliManagerFactory] omp-sdk tool requires `db` in additionalOptions');
      }
      if (
        typeof dbCandidate !== 'object' ||
        typeof (dbCandidate as { prepare?: unknown }).prepare !== 'function'
      ) {
        throw new TypeError(
          '[CliManagerFactory] omp-sdk tool: additionalOptions.db must be a better-sqlite3 Database instance (received a value lacking a .prepare() method)',
        );
      }
      const db = dbCandidate as Database.Database;
      return new OmpSdkManager(
        sessionManager as SessionManager,
        logger,
        configManager,
        db,
      );
    };

    const ompSdkDefinition: CliToolDefinition = {
      id: 'omp-sdk',
      name: 'OMP',
      description: 'oh-my-pi running as a persistent `omp --mode rpc-ui` child over NDJSON',
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
        defaultExecutable: 'omp',
        alternativeExecutables: ['omp'],
        minimumVersion: undefined,
      },
      managerFactory: ompSdkManagerFactory,
    };

    this.registry.registerTool(ompSdkDefinition, {
      priority: 35,
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
