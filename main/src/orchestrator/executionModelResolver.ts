/**
 * executionModelResolver — the SINGLE resolution point for the workflow
 * EXECUTION MODEL choice (the orchestrated-vs-programmatic axis). Sibling to
 * substrateResolver.ts; the two are resolved together in
 * WorkflowRegistry.createRun and stamped immutably onto the workflow_runs row.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', 'fs', or any concrete service in main/src/services/*. It
 * depends only on the renderer-safe shared execution-model + substrate types.
 *
 * The resolver enforces ONE hard binding rule and otherwise walks an override
 * ladder flooring to DEFAULT_EXECUTION_MODEL ('orchestrated'):
 *
 *   HARD RULE — substrate === 'interactive' ⇒ ALWAYS 'orchestrated'.
 *     The PTY substrate has no in-process control channel for a host loop to
 *     drive (substrateResolver's sibling fact), so 'programmatic' is structurally
 *     unavailable there and the rule outranks EVERY override level, including an
 *     explicit per-run request. This is the architectural invariant that keeps
 *     "PTY stays orchestrator-driven" true by construction.
 *
 * With no override at any level, an SDK run resolves 'orchestrated' (the floor)
 * and an interactive run is pinned 'orchestrated' — so EVERY run resolves
 * 'orchestrated' and behavior is byte-identical. That is the zero-behavior-change
 * invariant this seam guarantees until a programmatic consumer (the host-side
 * WorkflowController) lands; the column is stamped-but-dormant exactly as
 * `substrate` was when migration 013 first introduced it.
 */
import {
  type ExecutionModel,
  DEFAULT_EXECUTION_MODEL,
  isExecutionModel,
} from '../../../shared/types/executionModel';
import type { CliSubstrate } from '../../../shared/types/substrate';

/**
 * Environment variable consulted as the lowest override level (below the global
 * default, above the hard floor). Mirrors SUBSTRATE_ENV_VAR.
 */
export const EXECUTION_MODEL_ENV_VAR = 'CYBOFLOW_EXECUTION_MODEL';

/**
 * Inputs for resolveExecutionModel. `substrate` is REQUIRED (it gates the hard
 * binding rule); every override level is optional and untyped at the boundary
 * (string | null | undefined) because the values flow in from frontmatter
 * parsing, config files, and the environment — none of which can be trusted to
 * be a valid ExecutionModel. Each candidate is validated with isExecutionModel()
 * and an unrecognized value is SKIPPED (fail-soft), letting resolution fall
 * through to the next level rather than throwing — mirroring resolveSubstrate.
 */
export interface ExecutionModelResolverInputs {
  /**
   * The already-resolved CLI substrate for this run. The interactive substrate
   * hard-pins 'orchestrated' regardless of any other input.
   */
  substrate: CliSubstrate;
  /**
   * Explicit per-run choice from the run-launch UI. HIGHEST precedence among the
   * override levels (but still below the interactive hard-pin). Wired from the
   * launch wizard's Advanced "Orchestration" tri-state via runs.start
   * ({ executionModel }) → RunLauncher.launch → createRun.
   */
  requestedExecutionModel?: string | null;
  /** Workflow .md frontmatter `execution_model:` value. */
  frontmatterExecutionModel?: string | null;
  /** Per-project config override. */
  projectConfigExecutionModel?: string | null;
  /** ConfigManager.defaultExecutionModel global. */
  globalDefaultExecutionModel?: string | null;
  /** Process environment, for CYBOFLOW_EXECUTION_MODEL. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the execution model for a run.
 *
 * Precedence (highest wins), AFTER the interactive hard-pin short-circuit:
 *   0. substrate === 'interactive'  → 'orchestrated' (hard rule, outranks all)
 *   1. explicit per-run UI choice (requestedExecutionModel)
 *   2. workflow frontmatter `execution_model:`
 *   3. per-project config override
 *   4. ConfigManager.defaultExecutionModel global
 *   5. env.CYBOFLOW_EXECUTION_MODEL
 *   6. DEFAULT_EXECUTION_MODEL ('orchestrated') — the hard floor.
 *
 * A 'programmatic' value selected at any level on an SDK run is honored; the
 * same value can never be reached on an interactive run because the hard rule
 * short-circuits first. An unrecognized value at any level is ignored (never
 * throws) and resolution falls through to the next level.
 */
export function resolveExecutionModel(inputs: ExecutionModelResolverInputs): ExecutionModel {
  // HARD RULE: the interactive substrate can only ever run orchestrated. This
  // outranks every override level, including an explicit per-run request.
  if (inputs.substrate === 'interactive') {
    return 'orchestrated';
  }

  const env = inputs.env ?? process.env;

  const candidates: Array<string | null | undefined> = [
    inputs.requestedExecutionModel,
    inputs.frontmatterExecutionModel,
    inputs.projectConfigExecutionModel,
    inputs.globalDefaultExecutionModel,
    env[EXECUTION_MODEL_ENV_VAR],
  ];

  for (const candidate of candidates) {
    if (isExecutionModel(candidate)) {
      return candidate;
    }
  }

  return DEFAULT_EXECUTION_MODEL;
}
