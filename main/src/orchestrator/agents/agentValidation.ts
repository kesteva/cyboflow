/**
 * agentValidation — the kebab/forbidden/shape checks for an agent draft before a
 * `agent_overrides` write, plus the `## Result` section auto-append helper.
 *
 * Single-writer invariant: an agent must NEVER call a `cyboflow_*` entity-write
 * MCP tool, so any `cyboflow_` token in the description OR system prompt is
 * rejected. Tools must all be known `CliTool`s and non-empty. The agent key must
 * be kebab-case. Reserved-key / duplicate-key are checked by the ROUTER (which
 * knows the project + catalogue) — this module only exposes the project-agnostic
 * checks and the `AgentOverrideError` codes the router reuses.
 *
 * Pure: no fs/path, no DB.
 */
import { isCliTool } from '../../../../shared/types/cliTools';
import type { CliTool } from '../../../../shared/types/cliTools';
import { isAgentModelAlias } from '../../../../shared/types/agents';
import type { AgentModelAlias } from '../../../../shared/types/agents';

/** The discriminated set of validation/conflict failure codes. */
export type AgentOverrideErrorCode =
  | 'forbidden_writer_call'
  | 'forbidden_tool'
  | 'invalid_mcp'
  | 'empty_tools'
  | 'empty_description'
  | 'invalid_key'
  | 'invalid_model'
  | 'reserved_key'
  | 'duplicate_key'
  | 'frontmatter_in_body'
  | 'version_conflict';

/** A typed validation/conflict error carrying a machine-readable `code`. */
export class AgentOverrideError extends Error {
  readonly code: AgentOverrideErrorCode;
  constructor(code: AgentOverrideErrorCode, message: string) {
    super(message);
    this.name = 'AgentOverrideError';
    this.code = code;
  }
}

/** The draft shape submitted to create/update an agent override. */
export interface AgentDraft {
  agentKey: string;
  name: string;
  role: string | null;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
  /** Pinned model alias, or `null`/omitted to inherit the run model. */
  model?: AgentModelAlias | null;
  enabledMcps: string[];
  isCustom: boolean;
}

/** Canonical kebab-case key shape, e.g. `code-review`, `implement`. */
const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Any single-writer entity-write MCP token an agent must never reference. */
const FORBIDDEN_WRITER_RE = /cyboflow_/;

/**
 * A valid MCP server name as it appears in the `mcp__<server>__*` wildcard. Allows
 * the chars Claude Code's MCP namespacing permits (letters/digits/`_`/`-`); the
 * literal `cyboflow` server is rejected separately to preserve single-writer.
 */
const MCP_SERVER_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a draft's project-agnostic shape. Throws `AgentOverrideError` on the
 * first failure; returns `void` when the kebab/forbidden/tool/description checks
 * all pass. The router layers `reserved_key` / `duplicate_key` / `version_conflict`
 * on top using project context.
 */
export function validateAgentDraft(draft: AgentDraft): void {
  if (!KEBAB_RE.test(draft.agentKey)) {
    throw new AgentOverrideError(
      'invalid_key',
      `Agent key "${draft.agentKey}" must be kebab-case (e.g. "code-review").`,
    );
  }

  if (draft.description.trim().length === 0) {
    throw new AgentOverrideError('empty_description', 'Agent description must not be empty.');
  }

  if (FORBIDDEN_WRITER_RE.test(draft.description) || FORBIDDEN_WRITER_RE.test(draft.systemPrompt)) {
    throw new AgentOverrideError(
      'forbidden_writer_call',
      'Agent description/prompt must not reference a cyboflow_* entity-write tool (single-writer invariant).',
    );
  }

  if (draft.systemPrompt.startsWith('---')) {
    throw new AgentOverrideError(
      'frontmatter_in_body',
      'Agent system prompt (body) must not start with a "---" frontmatter fence.',
    );
  }

  if (draft.tools.length === 0) {
    throw new AgentOverrideError('empty_tools', 'Agent must enable at least one tool.');
  }

  for (const tool of draft.tools) {
    if (!isCliTool(tool)) {
      throw new AgentOverrideError('forbidden_tool', `"${tool}" is not a permitted CLI tool.`);
    }
  }

  // model is optional: null/undefined inherits the run model; any other value
  // must be a known alias (defense-in-depth — the tRPC zod already constrains it).
  if (draft.model != null && !isAgentModelAlias(draft.model)) {
    throw new AgentOverrideError(
      'invalid_model',
      `Agent model "${String(draft.model)}" is not a permitted model alias.`,
    );
  }

  for (const server of draft.enabledMcps) {
    if (!MCP_SERVER_RE.test(server)) {
      throw new AgentOverrideError('invalid_mcp', `"${server}" is not a valid MCP server name.`);
    }
    // Single-writer invariant: the cyboflow_* entity-write MCP is never grantable.
    if (server === 'cyboflow' || FORBIDDEN_WRITER_RE.test(server)) {
      throw new AgentOverrideError(
        'invalid_mcp',
        'The cyboflow MCP server may not be granted to an agent (single-writer invariant).',
      );
    }
  }
}

const RESULT_HEADING_RE = /^##\s+Result\b/m;

const RESULT_STUB =
  '\n\n## Result\n<!-- Return a concise summary of what you did/found; the orchestrator records this. -->';

/**
 * Ensure the system prompt ends with a `## Result` section. If one is already
 * present (anywhere) the prompt is returned unchanged; otherwise the stub is
 * appended to a COPY (never mutates the input). Used by the router before persist
 * — it does NOT throw for a missing Result section.
 */
export function ensureResultSection(systemPrompt: string): string {
  if (RESULT_HEADING_RE.test(systemPrompt)) return systemPrompt;
  return `${systemPrompt}${RESULT_STUB}`;
}
