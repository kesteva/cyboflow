/**
 * VariantResolver — the randomized-rotation seam for workflow A/B testing.
 *
 * Called ONCE per launch inside `RunLauncher.launch` (pre-createRun) so every
 * launch surface (picker, one-click, backlog, restart) inherits rotation from one
 * place. It resolves which variant (if any) a launch runs:
 *   - explicit pin (requestedVariantId) → load that variant regardless of status
 *     (restart + experiment arms pin paused/retired variants; pickers only OFFER
 *     active ones);
 *   - otherwise → weighted random over `status='active' AND weight>0`;
 *   - none / __quick__ → null (a baseline live-spec run, zero behaviour change).
 *
 * Standalone-typecheck invariant: reads through the narrow DatabaseLike surface
 * only — no 'electron' / 'better-sqlite3' import. The rng is injectable so tests
 * pin the weighted pick deterministically.
 */
import type { DatabaseLike } from './types';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { WorkflowVariantRow } from '../../../shared/types/experiments';

/** A random number generator in `[0, 1)`. Defaults to `Math.random`. */
export type Rng = () => number;

/** The variant fields a launch threads into createRun's opts bag. */
export interface ResolvedVariant {
  variantId: string;
  variantLabel: string;
  specJson: string;
  model: string | null;
  executionModel: ExecutionModel | null;
  agentOverridesJson: string | null;
}

export class VariantResolver {
  constructor(
    private readonly db: DatabaseLike,
    private readonly rng: Rng = Math.random,
  ) {}

  /**
   * Resolve the variant for a launch of `workflowId`.
   *
   * @param workflowId        The workflow being launched.
   * @param requestedVariantId Optional explicit pin (restart inherit / experiment
   *   arm / UI selection). When supplied it is loaded regardless of status; it
   *   MUST belong to `workflowId` or this throws (mapped to BAD_REQUEST upstream).
   * @param opts.baseline     When true, PIN the baseline (live-spec) run: return
   *   null WITHOUT consulting rotation. This is how a restart of a baseline
   *   (variant_id NULL) run reproduces its baseline config even after the workflow
   *   has gained active weight>0 variants — honouring the "restart inherits, no
   *   re-roll" contract for the baseline case. Ignored when `requestedVariantId`
   *   is supplied (an explicit pin always wins).
   * @returns The resolved variant, or `null` for a baseline (live-spec) run.
   */
  resolveForLaunch(
    workflowId: string,
    requestedVariantId?: string,
    opts?: { baseline?: boolean },
  ): ResolvedVariant | null {
    // Defense-in-depth: the __quick__ sentinel never rotates. (It is created via a
    // direct createRun in ipc/session.ts and never reaches RunLauncher.launch, so
    // this is belt-and-suspenders.)
    const workflow = this.db
      .prepare('SELECT name AS name FROM workflows WHERE id = ?')
      .get(workflowId) as { name?: unknown } | undefined;
    if (workflow && workflow.name === '__quick__') return null;

    if (requestedVariantId !== undefined) {
      const variant = this.loadVariant(requestedVariantId);
      if (!variant) {
        throw new Error(`VariantResolver: variant ${requestedVariantId} not found`);
      }
      if (variant.workflow_id !== workflowId) {
        throw new Error(
          `VariantResolver: variant ${requestedVariantId} belongs to a different workflow`,
        );
      }
      return this.toResolved(variant);
    }

    // Baseline pin (restart of a variant_id-NULL run): reproduce the baseline
    // deterministically — never fall through to rotation.
    if (opts?.baseline) return null;

    const candidates = this.db
      .prepare(
        `SELECT * FROM workflow_variants
          WHERE workflow_id = ? AND status = 'active' AND weight > 0
          ORDER BY id`,
      )
      .all(workflowId) as WorkflowVariantRow[];
    if (candidates.length === 0) return null;

    const picked = this.weightedPick(candidates);
    return picked ? this.toResolved(picked) : null;
  }

  /** Load a single variant row by id (any status). */
  private loadVariant(variantId: string): WorkflowVariantRow | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_variants WHERE id = ?')
      .get(variantId) as WorkflowVariantRow | undefined;
    return row ?? null;
  }

  /**
   * Weighted random pick over the candidates using the injected rng. `total =
   * Σweight; r = rng()*total`; walk cumulative weight and return the first variant
   * whose running sum is `> r`. With `rng()=0` this deterministically picks the
   * first candidate.
   */
  private weightedPick(candidates: WorkflowVariantRow[]): WorkflowVariantRow | null {
    const total = candidates.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
    if (total <= 0) return null;
    const r = this.rng() * total;
    let acc = 0;
    for (const v of candidates) {
      acc += Math.max(0, v.weight);
      if (acc > r) return v;
    }
    // Floating-point guard: return the last candidate if the walk fell through.
    return candidates[candidates.length - 1] ?? null;
  }

  private toResolved(v: WorkflowVariantRow): ResolvedVariant {
    return {
      variantId: v.id,
      variantLabel: v.label,
      specJson: v.spec_json,
      model: v.model,
      executionModel: v.execution_model,
      agentOverridesJson: v.agent_overrides_json,
    };
  }
}
