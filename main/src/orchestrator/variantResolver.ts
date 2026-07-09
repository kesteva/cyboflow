/**
 * VariantResolver — the randomized-rotation seam for workflow A/B testing.
 *
 * Called ONCE per launch inside `RunLauncher.launch` (pre-createRun) so every
 * launch surface (picker, one-click, backlog, restart) inherits rotation from one
 * place. It resolves which variant (if any) a launch runs:
 *   - explicit pin (requestedVariantId) → load that variant regardless of status
 *     (restart + experiment arms pin paused/retired variants; pickers only OFFER
 *     active ones);
 *   - otherwise → weighted random over `status='active' AND weight>0` variants PLUS
 *     the live BASELINE when the workflow opted it in (`baseline_in_rotation=1 AND
 *     baseline_rotation_weight>0`, migration 054) — the baseline competes on equal
 *     footing so "baseline vs variant" rotation works; a baseline win → null;
 *   - none / __quick__ → null (a baseline live-spec run, zero behaviour change).
 *
 * Standalone-typecheck invariant: reads through the narrow DatabaseLike surface
 * only — no 'electron' / 'better-sqlite3' import. The rng is injectable so tests
 * pin the weighted pick deterministically.
 */
import type { DatabaseLike } from './types';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { WorkflowVariantRow } from '../../../shared/types/experiments';
import { getRunningRotationExperiment } from './experimentStore';

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

/**
 * The launch's resolved variant assignment WITH provenance (phase 2). `source`
 * disambiguates the four outcomes a bare `ResolvedVariant | null` could not:
 *   - `pin`          — explicit variant pin (restart inherit / experiment arm / UI).
 *   - `baseline-pin` — a baseline (live-spec) run pinned via opts.baseline (restart).
 *   - `rotation`     — a genuine weighted rotation pick; `variant` may be null when
 *                      the BASELINE arm won. ONLY this source attributes the run to a
 *                      rotation experiment (rotationExperimentId set when one is open).
 *   - `none`         — no rotation applied (__quick__, empty pool).
 * `rotationExperimentId` is populated ONLY for `source==='rotation'`; null otherwise.
 */
export interface VariantAssignment {
  variant: ResolvedVariant | null;
  source: 'pin' | 'baseline-pin' | 'rotation' | 'none';
  rotationExperimentId: string | null;
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
   * @returns A {@link VariantAssignment} carrying the resolved variant (or null for
   *   a baseline / no-rotation run) plus its provenance + any rotation attribution.
   */
  resolveForLaunch(
    workflowId: string,
    requestedVariantId?: string,
    opts?: { baseline?: boolean },
  ): VariantAssignment {
    // Defense-in-depth: the __quick__ sentinel never rotates. (It is created via a
    // direct createRun in ipc/session.ts and never reaches RunLauncher.launch, so
    // this is belt-and-suspenders.)
    const workflow = this.db
      .prepare(
        'SELECT name AS name, baseline_in_rotation AS baselineInRotation, baseline_rotation_weight AS baselineWeight FROM workflows WHERE id = ?',
      )
      .get(workflowId) as
      | { name?: unknown; baselineInRotation?: unknown; baselineWeight?: unknown }
      | undefined;
    if (workflow && workflow.name === '__quick__') {
      return { variant: null, source: 'none', rotationExperimentId: null };
    }

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
      return { variant: this.toResolved(variant), source: 'pin', rotationExperimentId: null };
    }

    // Baseline pin (restart of a variant_id-NULL run): reproduce the baseline
    // deterministically — never fall through to rotation.
    if (opts?.baseline) return { variant: null, source: 'baseline-pin', rotationExperimentId: null };

    // ⚠️ LOCKSTEP with experimentStore.computeRotationArmSet's pool predicate — the
    // two MUST admit exactly the same members (active + weight>0 variants, plus the
    // opted-in baseline). If you change this predicate, change computeRotationArmSet's
    // in the same edit, or a run could be attributed to a rotation whose arm snapshot
    // omits the picked arm.
    const variants = this.db
      .prepare(
        `SELECT * FROM workflow_variants
          WHERE workflow_id = ? AND status = 'active' AND weight > 0
          ORDER BY id`,
      )
      .all(workflowId) as WorkflowVariantRow[];

    // A `variant: null` candidate represents the live baseline (variant_id NULL run).
    const pool: Array<{ weight: number; variant: WorkflowVariantRow | null }> = variants.map((v) => ({
      weight: Math.max(0, v.weight),
      variant: v,
    }));

    // The baseline joins rotation only when the workflow opted it in (migration 054).
    const baselineInRotation = Number(workflow?.baselineInRotation ?? 0) === 1;
    const baselineWeight = Math.max(0, Math.trunc(Number(workflow?.baselineWeight ?? 0)) || 0);
    if (baselineInRotation && baselineWeight > 0) {
      pool.push({ weight: baselineWeight, variant: null });
    }

    if (pool.length === 0) return { variant: null, source: 'none', rotationExperimentId: null };

    // A genuine weighted rotation pick — attribute it to the open rotation experiment
    // (phase 2). The baseline arm winning yields a null variant, but it is STILL a
    // rotation pick (source='rotation'): a baseline-vs-variant rotation's baseline
    // draws must be attributed too, so the experiment's arm stats are complete.
    const picked = this.weightedPick(pool);
    const rotationExperimentId = getRunningRotationExperiment(this.db, workflowId)?.id ?? null;
    return {
      variant: picked && picked.variant ? this.toResolved(picked.variant) : null,
      source: 'rotation',
      rotationExperimentId,
    };
  }

  /** Load a single variant row by id (any status). */
  private loadVariant(variantId: string): WorkflowVariantRow | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_variants WHERE id = ?')
      .get(variantId) as WorkflowVariantRow | undefined;
    return row ?? null;
  }

  /**
   * Weighted random pick over `{ weight }`-bearing candidates using the injected
   * rng. `total = Σweight; r = rng()*total`; walk cumulative weight and return the
   * first candidate whose running sum is `> r`. With `rng()=0` this deterministically
   * picks the first candidate. Generic over the candidate shape so both variant rows
   * and the synthetic baseline candidate flow through the same pick.
   */
  private weightedPick<T extends { weight: number }>(candidates: T[]): T | null {
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
