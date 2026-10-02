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
  CliManagerFactory as ManagerFactoryFunction
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
  | 'abortInFlightTurn'
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
    typeof seams.detectChatGptAccount === 'function' &&
    typeof seams.abortInFlightTurn === 'function'
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
    // Demo mode has no live turn to interrupt — accept and no-op, mirroring
    // the other injection seams above rather than `demoSeamUnavailable`
    // (which is reserved for probes a caller AWAITS a real answer from).
    abortInFlightTurn: async () => {},
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
}

/**
 * Factory for creating CLI tool managers
 *
 * Registers the built-in tools (Claude SDK + interactive, Codex, OMP, pi) and
 * constructs their managers, substituting a scripted DemoCliManager in demo
 * mode.
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
        config.additionalOptions
      );

      this.logger?.info(`[CliManagerFactory] Created ${toolId} manager successfully`);
      return manager;
    } catch (error) {
      this.logger?.error(`[CliManagerFactory] Failed to create ${toolId} manager:`, error instanceof Error ? error : undefined);
      throw error;
    }
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
    this.registerInteractiveClaudeTool();

    // Register the Codex SDK + PTY quick-session runtimes.
    this.registerCodexSdkTool();
    this.registerCodexPtyTool();

    // Register the OMP (oh-my-pi) quick-session runtimes.
    this.registerOmpSdkTool();
    this.registerOmpPtyTool();

    // Register the Pi (@earendil-works/pi-coding-agent) quick-session runtimes.
    this.registerPiPtyTool();
    this.registerPiSdkTool();

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

    this.registry.registerTool({
      id: 'claude',
      name: 'Claude Code',
      managerFactory: claudeManagerFactory,
    });
  }

  /**
   * Register the interactive Claude Code CLI tool (IDEA-013 / TASK-806).
   *
   * Mirrors registerClaudeTool's db-guard exactly (same TypeError when
   * additionalOptions.db is missing or lacks .prepare). The managerFactory
   * returns an InteractiveClaudeManager.
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

    this.registry.registerTool({
      id: 'claude-interactive',
      name: 'Claude Code (Interactive)',
      managerFactory: interactiveManagerFactory,
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

    this.registry.registerTool({
      id: 'codex-pty',
      name: 'Codex (PTY)',
      managerFactory: codexPtyManagerFactory,
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

    this.registry.registerTool({
      id: 'codex-sdk',
      name: 'Codex SDK',
      managerFactory: codexSdkManagerFactory,
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

    this.registry.registerTool({
      id: 'omp-pty',
      name: 'OMP (PTY)',
      managerFactory: ompPtyManagerFactory,
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

    this.registry.registerTool({
      id: 'pi-pty',
      name: 'Pi (PTY)',
      managerFactory: piPtyManagerFactory,
    });
  }

  private registerPiSdkTool(): void {
    const piSdkManagerFactory: ManagerFactoryFunction = (
      sessionManager: unknown,
      logger?: Logger,
      configManager?: ConfigManager,
      additionalOptions?: unknown,
    ) => {
      // Optional, unlike codex-sdk/omp-sdk: pi uses the db only to write a
      // workflow run's role files (PiSdkManager.spawnCliProcess), so a call
      // site without one still gets a working manager.
      const options = additionalOptions as Record<string, unknown> | undefined;
      const db = isSqliteDatabase(options?.db) ? options.db : undefined;
      return new PiSdkManager(
        sessionManager as SessionManager,
        logger,
        configManager,
        db,
      );
    };

    this.registry.registerTool({
      id: 'pi-sdk',
      name: 'Pi',
      managerFactory: piSdkManagerFactory,
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

    this.registry.registerTool({
      id: 'omp-sdk',
      name: 'OMP',
      managerFactory: ompSdkManagerFactory,
    });
  }

  /**
   * Validate factory configuration
   */
  private validateConfig(config: CliManagerFactoryConfig): void {
    if (!config.sessionManager) {
      throw new Error('Session manager is required for CLI manager creation');
    }
  }
}
