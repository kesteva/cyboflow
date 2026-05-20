import type { ConfigManager } from '../services/configManager';

/**
 * Returns the Cyboflow commit-message footer when enabled, or an empty
 * string when disabled.
 */
export function buildCommitFooter(enableCyboflowFooter: boolean): string {
  if (!enableCyboflowFooter) return '';
  return `💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)

Co-Authored-By: Cyboflow <hello@cyboflow.com>`;
}

/**
 * Returns true when the Cyboflow commit footer is enabled.
 * Defaults to true when configManager is undefined or enableCyboflowFooter is not set.
 */
export function isCommitFooterEnabled(configManager: ConfigManager | undefined): boolean {
  const config = configManager?.getConfig();
  return config?.enableCyboflowFooter !== false;
}

/**
 * Appends the Cyboflow commit footer to message when enabled.
 * Returns message unchanged when disabled.
 */
export function appendCommitFooter(message: string, configManager: ConfigManager | undefined): string {
  const footer = buildCommitFooter(isCommitFooterEnabled(configManager));
  return footer ? `${message}\n\n${footer}` : message;
}
