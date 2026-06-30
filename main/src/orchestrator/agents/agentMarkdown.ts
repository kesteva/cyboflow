/**
 * agentMarkdown — render an effective agent back into the bundled `.md` shape
 * (`cyboflow-<key>.md`) that the spawn-time overlay writes verbatim.
 *
 * The frontmatter `name:` is ALWAYS `cyboflow-<agentKey>` regardless of any
 * stored name — the orchestrator prose dispatches by this name and the SDK
 * auto-discovers by it, so it is never user-editable. Frontmatter key order is
 * pinned: name → description → tools → (optional) model. The body is emitted
 * verbatim.
 *
 * The optional `model` is the CLI subagent `model:` field — a concrete model id
 * the caller has already resolved (see modelContext.bareModelId). It is emitted
 * ONLY when set; an inherit-model agent's `.md` is byte-identical to before the
 * model feature existed. `model` is rendered LAST so a parser that stops at the
 * first three keys still reads name/description/tools.
 *
 * Pure: no fs/path.
 */
import type { CliTool } from '../../../../shared/types/cliTools';

/** The minimal effective-agent shape needed to render its markdown. */
export interface RenderableAgent {
  agentKey: string;
  description: string;
  tools: CliTool[];
  systemPrompt: string;
  /** Concrete model id for the `model:` frontmatter; omit/empty = inherit run model. */
  model?: string;
}

/**
 * YAML-escape a frontmatter scalar value. If it contains a `:` or `#`, or starts
 * with a quote, wrap it in double quotes and escape embedded `"` and `\`.
 */
function escapeYamlScalar(value: string): string {
  const needsQuote =
    value.includes(':') || value.includes('#') || value.startsWith('"') || value.startsWith("'");
  if (!needsQuote) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Render an agent into its `cyboflow-<key>.md` markdown. The frontmatter name is
 * forced to `cyboflow-<agentKey>`; the body is emitted verbatim after a blank
 * line following the closing fence.
 */
export function renderAgentMarkdown(a: RenderableAgent): string {
  const name = `cyboflow-${a.agentKey}`;
  const description = escapeYamlScalar(a.description);
  const tools = a.tools.join(', ');
  // model is appended last and only when pinned — keeps an inherit-model agent's
  // frontmatter byte-identical to the pre-model-feature output.
  const modelLine = a.model ? `\nmodel: ${escapeYamlScalar(a.model)}` : '';
  return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}${modelLine}\n---\n\n${a.systemPrompt}`;
}
