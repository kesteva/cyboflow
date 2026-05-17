/**
 * Returns the Cyboflow commit-message footer when enabled, or an empty
 * string when disabled.
 */
export function buildCommitFooter(enableCyboflowFooter: boolean): string {
  if (!enableCyboflowFooter) return '';
  return `💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)

Co-Authored-By: Cyboflow <hello@cyboflow.com>`;
}
