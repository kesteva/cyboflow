/**
 * Flow-name validation, shared by every door that mints a workflow (the tRPC
 * router, the MCP `mcp-create-workflow` handler, the agent-override router —
 * all of which funnel into WorkflowRegistry.createCustom, which calls this as
 * its backstop).
 *
 * The name is embedded verbatim in git branch names (`cyboflow/<name>/<runId>`)
 * and worktree directories (`.cyboflow/worktrees/<name>/` — see
 * worktreeManager.createWorktreeForRun). Reject at the boundary the names
 * Windows cannot represent as-is.
 */

const WORKFLOW_NAME_FORBIDDEN_CHARS = /[<>:"/\\|?*]/;

const WORKFLOW_NAME_RESERVED_DEVICE_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

// eslint-plugin no-control-regex bans \x00-\x1f in regex literals, so the
// control-character half of the check is a plain codepoint scan.
function hasControlCharacter(name: string): boolean {
  return [...name].some((ch) => {
    const code = ch.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

/** Human-readable reason `name` is unusable as a flow name, or null. */
export function workflowNameIssue(name: string): string | null {
  if (WORKFLOW_NAME_FORBIDDEN_CHARS.test(name) || hasControlCharacter(name)) {
    return 'Flow names cannot contain any of <>:"/\\|?* or control characters — ' +
      'the name is used in git branch names and worktree folder names.';
  }
  // Windows bans a reserved device name bare OR as the stem before an
  // extension ("CON", "con.txt", "LPT1.log" all hit the device namespace).
  if (WORKFLOW_NAME_RESERVED_DEVICE_STEMS.has(name.split('.')[0].toLowerCase())) {
    return `"${name}" is a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) — pick a different flow name.`;
  }
  if (/[. ]$/.test(name)) {
    return 'Flow names cannot end with a dot or a space — Windows strips trailing dots and spaces.';
  }
  return null;
}
