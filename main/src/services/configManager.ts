import { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import { type CliSubstrate, DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getCyboflowDirectory } from '../utils/cyboflowDirectory';
import { clearShellPathCache } from '../utils/shellPath';

export class ConfigManager extends EventEmitter {
  private config: AppConfig;
  private configPath: string;
  private configDir: string;

  constructor(defaultGitPath?: string) {
    super();
    this.configDir = getCyboflowDirectory();
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = {
      gitRepoPath: defaultGitPath || os.homedir(),
      verbose: false,
      systemPromptAppend: undefined,
      runScript: undefined,
      defaultPermissionMode: 'approve',
      defaultModel: 'sonnet',
      notifications: {
        enabled: true,
        playSound: true,
        notifyOnStatusChange: true,
        notifyOnWaiting: true,
        notifyOnComplete: true
      },
      sessionCreationPreferences: {
        sessionCount: 1,
        toolType: 'none',
        selectedTools: {
          claude: false
        },
        claudeConfig: {
          model: 'auto',
          permissionMode: 'approve',
          ultrathink: false
        },
        showAdvanced: false,
        commitModeSettings: {
          mode: 'checkpoint',
          checkpointPrefix: 'checkpoint: '
        }
      }
    };
  }

  async initialize(): Promise<void> {
    // Ensure the config directory exists
    await fs.mkdir(this.configDir, { recursive: true });
    
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const loadedConfig = JSON.parse(data);
      
      // Merge loaded config with defaults, ensuring nested settings exist
      this.config = {
        ...this.config,
        ...loadedConfig,
        notifications: {
          ...this.config.notifications,
          ...loadedConfig.notifications
        },
        sessionCreationPreferences: {
          ...this.config.sessionCreationPreferences,
          ...loadedConfig.sessionCreationPreferences,
          selectedTools: {
            ...this.config.sessionCreationPreferences?.selectedTools,
            ...loadedConfig.sessionCreationPreferences?.selectedTools
          },
          claudeConfig: {
            ...this.config.sessionCreationPreferences?.claudeConfig,
            ...loadedConfig.sessionCreationPreferences?.claudeConfig
          },
          commitModeSettings: {
            ...this.config.sessionCreationPreferences?.commitModeSettings,
            ...loadedConfig.sessionCreationPreferences?.commitModeSettings
          }
        }
      };

      // One-time migration: enableCrystalFooter → enableCyboflowFooter (see TASK-561).
      // We mutate `loadedConfig` so the existing merge above has already set
      // `this.config.enableCyboflowFooter` if both keys were present; here we just
      // ensure the legacy key never persists back to disk.
      const legacy = (loadedConfig as Record<string, unknown>).enableCrystalFooter;
      if (typeof legacy === 'boolean') {
        // Only fill the new key if it's not already set (new wins on conflict).
        if (this.config.enableCyboflowFooter === undefined) {
          this.config.enableCyboflowFooter = legacy;
        }
        // Remove the legacy key from in-memory config and force a save.
        delete (this.config as Record<string, unknown>).enableCrystalFooter;
        await this.saveConfig();
      }
    } catch (error) {
      // Config file doesn't exist, use defaults
      await this.saveConfig();
    }
  }

  private async saveConfig(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
    this.config = { ...this.config, ...updates };
    await this.saveConfig();

    // Clear PATH cache if additional paths were updated
    if ('additionalPaths' in updates) {
      clearShellPathCache();
      console.log('[ConfigManager] Additional paths updated, cleared PATH cache');
    }
    
    this.emit('config-updated', this.config);
    return this.getConfig();
  }

  getGitRepoPath(): string {
    return this.config.gitRepoPath || '';
  }

  isVerbose(): boolean {
    return this.config.verbose || false;
  }

  /**
   * Demo mode (read ONCE at startup by initializeServices / CliManagerFactory).
   * When true the app boots against the throwaway demo database + sandbox repo
   * and all CLI managers are replaced by the scripted DemoCliManager. Toggling
   * the flag at runtime has no effect until the app relaunches.
   */
  isDemoMode(): boolean {
    return this.config.demoMode || false;
  }

  getDatabasePath(): string {
    return path.join(this.configDir, 'sessions.db');
  }

  getSystemPromptAppend(): string | undefined {
    return this.config.systemPromptAppend;
  }

  getRunScript(): string[] | undefined {
    return this.config.runScript;
  }

  getDefaultModel(): string {
    return this.config.defaultModel || 'sonnet';
  }

  /**
   * The global default CLI substrate for new workflow runs (IDEA-013 / TASK-806).
   *
   * Floors to DEFAULT_SUBSTRATE ('sdk') when unset. `defaultSubstrate` is
   * intentionally NOT seeded into the constructor defaults, so existing
   * config.json files are not rewritten on launch — preserving byte-identical
   * behavior for users who never opt into the interactive substrate.
   */
  getDefaultSubstrate(): CliSubstrate {
    return this.config.defaultSubstrate ?? DEFAULT_SUBSTRATE;
  }

  /**
   * Global hard lock that forces the interactive PTY substrate and disables the
   * SDK. Floors to false (allow SDK) when unset. Like `defaultSubstrate`, it is
   * intentionally NOT seeded into the constructor defaults, so existing
   * config.json files stay byte-identical for users who never opt in.
   */
  isInteractivePtyOnly(): boolean {
    return this.config.interactivePtyOnly ?? false;
  }

  /**
   * Boot-profile substrate pin consumed by WorkflowRegistry.createRun (the
   * WorkflowConfigProvider seam). A non-null result outranks the entire
   * resolution ladder — including the explicit per-run UI choice.
   *
   * Precedence (demo MUST win first):
   *   1. Demo mode pins EVERY run/session to 'sdk' so the scripted DemoCliManager
   *      handles all spawns and the real interactive (PTY) manager — which is
   *      constructed-but-never-engaged in demo — is never spawned.
   *   2. The global `interactivePtyOnly` lock pins to 'interactive', forcing the
   *      PTY substrate for every run/session and disabling the SDK.
   *   3. null = no pin (normal resolution ladder runs).
   */
  getForcedSubstrate(): CliSubstrate | null {
    if (this.isDemoMode()) return 'sdk';
    if (this.isInteractivePtyOnly()) return 'interactive';
    return null;
  }

  /**
   * The global default agent permission mode for new workflow runs, applied on
   * both CLI substrates (SDK + interactive).
   *
   * Floors to 'default' ('ask before edits') when unset. Like
   * `defaultSubstrate`, `defaultAgentPermissionMode` is intentionally NOT seeded
   * into the constructor defaults, so existing config.json files are not
   * rewritten on launch — preserving byte-identical behavior for users who
   * never opt into a different permission mode.
   */
  getDefaultAgentPermissionMode(): PermissionMode {
    return this.config.defaultAgentPermissionMode ?? 'default';
  }

  /**
   * The global default execution model for new SDK workflow runs — the
   * global-default rung of resolveExecutionModel (the WorkflowConfigProvider
   * seam consumed by WorkflowRegistry.createRun). Returns null when unset so the
   * resolver falls through to its env / hard-floor rungs rather than forcing a
   * value; an explicit 'programmatic' here is honored only on the SDK substrate
   * (the interactive substrate hard-pins 'orchestrated'). Like the other
   * defaults, `defaultExecutionModel` is NOT seeded into the constructor defaults,
   * so existing config.json files stay byte-identical.
   */
  getDefaultExecutionModel(): ExecutionModel | null {
    return this.config.defaultExecutionModel ?? null;
  }

  /**
   * Whether a PROGRAMMATIC run wires the ON-DEMAND monitor (the monitor-unify
   * refactor; supersedes the old Stage 3 supervisor + supervisor-chat planes — the
   * key/value are kept unchanged so existing config.json files stay byte-identical).
   * Floors to 'review-queue' (no monitor: exhausted required failures escalate to the
   * human review queue, the Chat composer stays disabled — no live SDK call) when
   * unset; 'sdk' opts into the on-demand monitor (triage + chat in the run's Chat
   * pane). NOT seeded into the constructor defaults.
   */
  getProgrammaticSupervisor(): 'review-queue' | 'sdk' {
    return this.config.programmaticSupervisor ?? 'review-queue';
  }

  getSessionCreationPreferences() {
    return this.config.sessionCreationPreferences || {
      sessionCount: 1,
      toolType: 'none',
      selectedTools: {
        claude: false
      },
      claudeConfig: {
        model: 'auto',
        permissionMode: 'approve',
        ultrathink: false
      },
      showAdvanced: false,
      commitModeSettings: {
        mode: 'checkpoint',
        checkpointPrefix: 'checkpoint: '
      }
    };
  }

}
