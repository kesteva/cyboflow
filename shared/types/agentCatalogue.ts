/**
 * agentCatalogue — the TYPE surface for a built-in agent's parsed metadata.
 *
 * The VALUE (the 15-entry catalogue) is produced at boot by the main process
 * (`loadBuiltInAgents`, P1) by parsing each bundled `cyboflow-<key>.md` — there
 * are intentionally NO hardcoded prompt bodies here. This module exists so both
 * processes can share the meta shape without pulling in Node fs/path.
 */

import type { CliTool } from './cliTools';

export interface BuiltinAgentMeta {
  /** Canonical key == file basename (e.g. `implement`). */
  key: string;
  displayName: string;
  role: 'planner' | 'sprint' | 'compound' | string;
  description: string;
  tools: CliTool[];
  /** The `.md` basename the meta was parsed from (== key). */
  sourceBasename: string;
}
