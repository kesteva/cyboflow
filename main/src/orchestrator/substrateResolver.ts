/**
 * substrateResolver — the SINGLE resolution point for the dual-substrate
 * choice (IDEA-013 / TASK-806).
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', 'fs', or any concrete service in main/src/services/*.
 * It depends only on the renderer-safe shared substrate types.
 *
 * The resolver walks an override ladder in precedence order and floors to
 * DEFAULT_SUBSTRATE ('sdk'). With no overrides set anywhere, EVERY run resolves
 * 'sdk' and the SDK path is byte-identical — that is the zero-behavior-change
 * invariant this seam guarantees.
 */
import {
  type CliSubstrate,
  DEFAULT_SUBSTRATE,
  isCliSubstrate,
} from '../../../shared/types/substrate';

/**
 * Environment variable consulted as the lowest override level (below the
 * global default, above the hard floor).
 */
export const SUBSTRATE_ENV_VAR = 'CYBOFLOW_SUBSTRATE';

/**
 * Inputs for resolveSubstrate. Every level is optional and untyped at the
 * boundary (string | null | undefined) because the values flow in from
 * frontmatter parsing, config files, and the environment — none of which can
 * be trusted to be a valid CliSubstrate. Each candidate is validated with
 * isCliSubstrate() and an unrecognized value is SKIPPED (fail-soft), letting
 * resolution fall through to the next level rather than throwing.
 */
export interface SubstrateResolverInputs {
  /** Workflow .md frontmatter `substrate:` value. Highest precedence. */
  frontmatterSubstrate?: string | null;
  /** Per-project config override. */
  projectConfigSubstrate?: string | null;
  /** ConfigManager.defaultSubstrate global. */
  globalDefaultSubstrate?: string | null;
  /** Process environment, for CYBOFLOW_SUBSTRATE. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the CLI substrate for a run.
 *
 * Precedence (highest wins):
 *   1. workflow frontmatter `substrate:`
 *   2. per-project config override
 *   3. ConfigManager.defaultSubstrate global
 *   4. env.CYBOFLOW_SUBSTRATE
 *   5. DEFAULT_SUBSTRATE ('sdk') — the hard floor.
 *
 * An unrecognized value at any level is ignored (never throws) and resolution
 * falls through to the next level — mirroring extractPermissionMode's
 * default-on-unknown and resolveSoloFlowPluginRoot's graceful fall-through.
 */
export function resolveSubstrate(inputs: SubstrateResolverInputs): CliSubstrate {
  const env = inputs.env ?? process.env;

  const candidates: Array<string | null | undefined> = [
    inputs.frontmatterSubstrate,
    inputs.projectConfigSubstrate,
    inputs.globalDefaultSubstrate,
    env[SUBSTRATE_ENV_VAR],
  ];

  for (const candidate of candidates) {
    if (isCliSubstrate(candidate)) {
      return candidate;
    }
  }

  return DEFAULT_SUBSTRATE;
}
