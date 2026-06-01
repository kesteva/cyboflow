import { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
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
