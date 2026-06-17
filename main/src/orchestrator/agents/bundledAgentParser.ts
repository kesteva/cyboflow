/**
 * bundledAgentParser — split a bundled agent `.md` (YAML frontmatter + body)
 * into its `name` / `description` / `tools` / `body` parts.
 *
 * The frontmatter is the leading `---\n…\n---\n` block; everything after the
 * closing fence is the verbatim system-prompt body. `tools` is the comma list on
 * the `tools:` line, trimmed and filtered through `isCliTool` (anything not a
 * known CLI tool is dropped — the catalogue/validation layers own the policy).
 *
 * Pure: no fs/path, no Node built-ins beyond string work, so it imports cleanly
 * in the main process and in vitest.
 */
import { isCliTool, type CliTool } from '../../../../shared/types/cliTools';

/** The parsed parts of a bundled agent markdown file. */
export interface ParsedBundledAgent {
  /** Frontmatter `name:` value, e.g. `cyboflow-implement`. */
  name: string;
  /** Frontmatter `description:` value (single line). */
  description: string;
  /** Frontmatter `tools:` parsed + filtered to known `CliTool`s. */
  tools: CliTool[];
  /** Everything after the closing `---` fence, verbatim. */
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/**
 * Read one scalar line (`key: value`) out of a frontmatter block. Returns the
 * trimmed value, with one layer of surrounding double-quotes stripped if present.
 */
function readScalar(frontmatter: string, key: string): string {
  const line = frontmatter
    .split('\n')
    .find((l) => l.startsWith(`${key}:`));
  if (line === undefined) return '';
  let value = line.slice(key.length + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

/**
 * Parse a bundled agent markdown string. A string with no leading frontmatter
 * fence yields empty `name`/`description`/`tools` and the whole input as `body`.
 */
export function parseBundledAgent(md: string): ParsedBundledAgent {
  const match = FRONTMATTER_RE.exec(md);
  if (match === null) {
    return { name: '', description: '', tools: [], body: md };
  }
  const [, frontmatter, body] = match;
  const toolsLine = readScalar(frontmatter, 'tools');
  const tools = toolsLine
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is CliTool => isCliTool(t));
  return {
    name: readScalar(frontmatter, 'name'),
    description: readScalar(frontmatter, 'description'),
    tools,
    body,
  };
}
