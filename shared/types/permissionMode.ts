/**
 * Single source of truth for the Cyboflow permissionMode contract.
 * See docs/CODE-PATTERNS.md § "permissionMode contract".
 * 'ignore' remains a typed escape hatch consumed by claudeCodeManager.ts:389
 * (omits PreToolUse hook) and test fixtures. NO user-facing UI surface may
 * expose it as selectable; NO default/fallback may resolve to it.
 */
export type PermissionMode = 'approve' | 'ignore';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'approve';
