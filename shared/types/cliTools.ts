/**
 * cliTools — the single source of truth for the agent tool vocabulary.
 *
 * These are the Claude CLI tools an agent's frontmatter `tools:` line may list.
 * Distinct from a workflow STEP's `mcps[]` (MCP/tool ids surfaced in the blueprint
 * editor) — the two are never conflated. This list deliberately EXCLUDES every
 * `cyboflow_*` MCP tool and `Task`: the single-writer invariant means agents must
 * never call the entity-write MCP tools, and the editor never offers them.
 */

export const CLI_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
] as const;

export type CliTool = (typeof CLI_TOOLS)[number];

export function isCliTool(s: string): s is CliTool {
  return (CLI_TOOLS as readonly string[]).includes(s);
}
