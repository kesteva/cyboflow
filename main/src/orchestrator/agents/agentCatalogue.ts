/**
 * agentCatalogue — the 15-entry built-in agent catalogue, parsed once at boot
 * from the bundled `.md` files under `workflows/<wf>/agents/`.
 *
 * There are intentionally NO hardcoded prompt bodies here: each built-in agent's
 * metadata (name/description/tools) and system-prompt body are parsed from the
 * SAME `.md` the spawn-time overlay copies verbatim. The catalogue is keyed by
 * the agent's file BASENAME (== the canonical agent key == the frontmatter name
 * with `cyboflow-` stripped), and the `role` is the workflow the bundle belongs
 * to (`planner` | `sprint` | `compound`).
 *
 * Path resolution mirrors `builtInWorkflows.ts`: `join(__dirname, '..',
 * 'workflows', '<wf>.md')` resolves the prose `.md`, and `resolveWorkflowBundle`
 * reads the sibling `<wf>/agents/*.md`. `copy:assets` places these under
 * `dist/main/src/orchestrator/workflows/` so the same path works in dev + packaged.
 */
import { join } from 'path';
import { resolveWorkflowBundle } from '../workflows/workflowBundle';
import { CYBOFLOW_WORKFLOW_NAMES } from '../../../../shared/types/workflows';
import { CANONICAL_AGENT_KEYS } from '../../../../shared/types/agentIdentity';
import type { CliTool } from '../../../../shared/types/cliTools';
import { parseBundledAgent } from './bundledAgentParser';

/** A workflow role a built-in agent's bundle belongs to. */
export type BuiltInAgentRole = 'planner' | 'sprint' | 'compound' | 'ship';

/**
 * One fully-parsed built-in agent. `name` is the frontmatter `name:`
 * (`cyboflow-<agentKey>`); `systemPrompt` is the body; `rawContent` is the
 * verbatim `.md` so the overlay can write an unoverridden builtin byte-for-byte.
 */
export interface BuiltInAgent {
  agentKey: string;
  name: string;
  role: BuiltInAgentRole;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
  rawContent: string;
}

let cached: Map<string, BuiltInAgent> | null = null;

/**
 * Parse + memoize the built-in agent catalogue. Walks the three built-in
 * workflows, reads each bundle's `agents/*.md`, parses each, and keys by basename.
 */
export function loadBuiltInAgents(): Map<string, BuiltInAgent> {
  if (cached !== null) return cached;

  const catalogue = new Map<string, BuiltInAgent>();
  for (const wf of CYBOFLOW_WORKFLOW_NAMES) {
    const bundle = resolveWorkflowBundle(join(__dirname, '..', 'workflows', `${wf}.md`));
    for (const file of bundle.agents) {
      // FIRST-WINS: ship's bundle copies planner/sprint agent basenames so its
      // own `workflows/ship/agents/` dir is self-contained, but the canonical
      // catalogue entry (and its `role`) must come from the original owning
      // workflow. Guarding the set keeps planner/sprint roles authoritative and
      // prevents ship's duplicates from overwriting them or inflating the size
      // past CANONICAL_AGENT_KEYS.length. (No-op for today's disjoint set.)
      if (catalogue.has(file.name)) continue;
      const parsed = parseBundledAgent(file.content);
      catalogue.set(file.name, {
        agentKey: file.name,
        name: parsed.name,
        role: wf,
        description: parsed.description,
        systemPrompt: parsed.body,
        tools: parsed.tools,
        rawContent: file.content,
      });
    }
  }

  cached = catalogue;
  return catalogue;
}

/**
 * Test/diagnostic helper: assert the catalogue exactly covers the canonical key
 * set (same count, same membership). Returns `true` when they match.
 */
export function catalogueMatchesCanonical(catalogue: Map<string, BuiltInAgent>): boolean {
  if (catalogue.size !== CANONICAL_AGENT_KEYS.length) return false;
  return CANONICAL_AGENT_KEYS.every((k) => catalogue.has(k));
}

/** Clear the memoized catalogue (test-only, so a re-parse can be forced). */
export function resetBuiltInAgentsCache(): void {
  cached = null;
}
