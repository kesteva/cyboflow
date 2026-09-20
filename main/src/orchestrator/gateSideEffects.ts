/**
 * GateSideEffects — the ONE place a design/brief gate's approval turns into
 * durable state.
 *
 * WHAT IT REPLACES. Approving a design gate used to change nothing on disk: the
 * review item resolved, the walk advanced, and the prototype the human just
 * approved stayed a run-scoped artifact that the run's cascade delete would take
 * with it. Approving a brief gate likewise established the project's solution
 * thoroughness in prose that no later run could read. And the adversarial
 * reviewer's findings, which the human had just implicitly accepted by
 * approving, were dropped entirely. Each of those is a side effect of "a human
 * said yes at this gate", and each needs the same collaborators, so they live
 * together behind one singleton rather than being re-derived at every call site.
 *
 * WHY A SINGLETON, initialised once at boot (the DesignHandoffService pattern).
 * There are THREE call sites and two of them build their dependency bags by hand
 * in different files — `resolveReviewItemCore`'s deps are constructed both in the
 * tRPC router and, separately, in index.ts for the monitor's steering action. A
 * side effect threaded as an optional dep would compile at both sites and
 * silently do nothing at one of them, which is precisely how a gate resolved from
 * the monitor would bind no design and file no findings with nothing to notice it.
 * Reaching the singleton from inside the handler makes both sites inherit it.
 *
 * THE THREE CALL SITES, and what each one's ordering actually guarantees:
 *   1. PROGRAMMATIC gates — `HumanGateOpener.onGateResolved`, awaited inside
 *      `ReviewQueueHumanGate.settleResumed` BEFORE the gate promise resolves.
 *      That is the one seam the controller genuinely waits on, so the next step's
 *      `cyboflow_get_task` really does see the bound `approved_design`. Anything
 *      hung off `resolveReviewItem`'s RETURN instead would race the resumed walk:
 *      `ReviewItemRouter.emitChange` fires synchronously inside the resolve, which
 *      is what wakes the gate in the first place.
 *   2. ORCHESTRATED-plane gates — decision items the flow minted itself via
 *      `cyboflow_report_finding kind:'decision'`, recognized by their payload
 *      `gate` discriminant. Called from inside `resolveReviewItem`. Ordering here
 *      is BEST-EFFORT and deliberately not claimed otherwise: there is no
 *      controller walk on that plane to order against.
 *   3. SETTLE reconciliation — `runExecutor`'s terminal seam. Re-runs the
 *      idempotent binds and the thoroughness stamp so a run that reached its end
 *      without either call site firing (an orchestrated gate answered inline via
 *      AskUserQuestion, a crash between resolve and side effect) still lands its
 *      durable state. Deliberately files NO findings: a settle is not a human
 *      saying "I accept these risks".
 *
 * FAIL-SOFT, ALWAYS. Every arm catches its own errors and logs. `apply` and
 * `reconcileAtSettle` never throw, because call site 1 is awaited inside the gate
 * resolver — a throw there would hang a run at a gate the human already answered.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * main/src/services/*.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { IdeaComponentRouter } from './ideaComponents/ideaComponentRouter';
import type { ReviewItemRouter } from './reviewItemRouter';
import { listRunOwnedIdeaIds } from './runEntityOwnership';
import { bindApprovedDesignsForRun } from './design/flowDesignBinding';
import { stampSolutionThoroughness, type ProjectSettingsDeps } from './projectSettings';
import { readAdversarialReviewMarkdown } from './adversarialReviewGateBody';
import {
  parseAdversarialReviewDoc,
  adversarialSeverityToReviewSeverity,
  type AdversarialFinding,
} from '../../../shared/types/adversarialReview';
import { parseIdeaVerdictMap, parseDesignVerdictMap } from '../../../shared/types/reviews';
import { parseThoroughnessDeclaration } from '../../../shared/types/thoroughness';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The gate step ids this module reacts to. Anything else is a no-op. */
const APPROVE_IDEAS = 'approve-ideas';
const APPROVE_DESIGN = 'approve-design';
const APPROVE_DESIGNS = 'approve-designs';
const APPROVE_BRIEF = 'approve-brief';

/** The flows whose gates carry design/brief semantics. */
const DESIGN_FLOWS = new Set(['launch', 'planner', 'ship']);

/** Provenance stamped on every accepted-risk finding this module files. */
export const ADVERSARIAL_FINDING_SOURCE = 'agent:adversarial-review';

/** Grouping category for the accepted-risk findings in the review queue. */
const ADVERSARIAL_FINDING_CATEGORY = 'design-review';

// The verdict sniff lives in its own leaf module so `adversarialReviewGateBody`
// (which this file imports for the review markdown) can borrow it without a
// module cycle; re-exported here so every existing importer is untouched.
export { gateDecisionFromResolution, type GateDecision } from './gateDecision';
import { gateDecisionFromResolution, type GateDecision } from './gateDecision';

export interface GateSideEffectsDeps {
  db: DatabaseLike;
  /** Snapshot tree the design binds publish into (shared with Design Mode). */
  snapshotBaseDir: string;
  /** Canonical prototype-byte reader (electron-backed; injected at boot). */
  loadPrototypeHtml: (runId: string, atype: string) => Promise<string | null>;
  /** The idea-component ledger chokepoint. */
  ideaComponentRouter?: { applyChange: IdeaComponentRouter['applyChange'] };
  /** The review-item chokepoint — the ONLY way accepted-risk findings are filed. */
  reviewItemRouter?: { applyReviewItem: ReviewItemRouter['applyReviewItem'] };
  /** Renderer notification for a project-settings write (see projectSettings.ts). */
  emitProjectUpdated?: (projectId: number) => void;
  logger?: LoggerLike;
}

export interface GateSideEffectArgs {
  runId: string;
  /** The gate's step id (`approve-design`, `approve-ideas`, …). */
  stepId: string;
  decision: GateDecision;
  /**
   * The resolution note the human's answer was recorded under. For a batch gate
   * it carries the serialized per-idea verdict map, which is how an
   * `approve-ideas` bind learns WHICH ideas were approved.
   */
  resolution?: string | null;
}

interface RunMetaRow {
  workflowName?: unknown;
  projectId?: unknown;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export class GateSideEffects {
  private static instance: GateSideEffects | null = null;

  constructor(private readonly deps: GateSideEffectsDeps) {}

  static initialize(deps: GateSideEffectsDeps): GateSideEffects {
    GateSideEffects.instance = new GateSideEffects(deps);
    return GateSideEffects.instance;
  }

  static getInstance(): GateSideEffects {
    if (!GateSideEffects.instance) {
      throw new Error(
        'GateSideEffects has not been initialized. Call GateSideEffects.initialize() from main/src/index.ts.',
      );
    }
    return GateSideEffects.instance;
  }

  /**
   * The singleton, or null when boot has not wired it.
   *
   * Call sites inside shared, independently-unit-tested handlers
   * (`resolveReviewItem`) use THIS rather than `getInstance()`: those handlers run
   * in dozens of tests that construct their own dep bags and never boot the app,
   * and a throwing accessor would turn "this feature is not wired" into "every
   * gate resolution fails".
   */
  static tryGetInstance(): GateSideEffects | null {
    return GateSideEffects.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    GateSideEffects.instance = null;
  }

  /**
   * Run the side effects a gate resolution earns. Idempotent and fail-soft;
   * never throws.
   *
   * Only an APPROVE does anything: a revise loops the walk back and a
   * reject/abort ends the run, and neither is a human accepting the design.
   */
  async apply(args: GateSideEffectArgs): Promise<void> {
    try {
      if (args.decision !== 'approve') return;
      const meta = this.resolveRunMeta(args.runId);
      if (!meta || !DESIGN_FLOWS.has(meta.workflowName)) return;

      switch (args.stepId) {
        case APPROVE_IDEAS:
          // Launch's concept prototype IS the design every builder of these ideas
          // will ever have, so it binds to each APPROVED idea. Denied ideas are
          // excluded: they stay on the backlog untouched, and binding a design to
          // one would assert a decision the human declined to make.
          if (meta.workflowName === 'launch') {
            await this.bind(args.runId, meta.projectId, this.approvedIdeaIds(args.runId, args.resolution));
          }
          return;

        case APPROVE_DESIGN:
        case APPROVE_DESIGNS:
          // Every idea the run OWNS, not its seed columns: a prompt-started
          // Planner/Ship run has `seed_idea_id IS NULL` and its idea is created by
          // the run's own context step — binding by seeds alone would bind nothing
          // on exactly the flow this exists to serve, and silently (there would be
          // no idea ids to report as skipped either).
          await this.bind(args.runId, meta.projectId, listRunOwnedIdeaIds(this.deps.db, args.runId));
          // The human approved with the critique in front of them, so every
          // remaining entry is an ACCEPTED risk — recorded, not discarded.
          await this.fileAcceptedRiskFindings(args.runId, meta.projectId);
          return;

        case APPROVE_BRIEF:
          if (meta.workflowName === 'launch') this.stampThoroughness(args.runId, meta.projectId);
          return;

        default:
          return;
      }
    } catch (err) {
      this.deps.logger?.warn('[gateSideEffects] apply failed (fail-soft)', {
        runId: args.runId,
        stepId: args.stepId,
        decision: args.decision,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Terminal-seam reconciliation for a launch/planner/ship run.
   *
   * Re-runs the DURABLE writes — the design bind and the thoroughness stamp —
   * both of which are idempotent, so a run whose gates already fired their side
   * effects converges on the same state. This is the safety net for the paths
   * neither call site covers: an orchestrated flow that answered its design gate
   * inline with AskUserQuestion (which never reaches a review item at all), or a
   * crash between the resolve and the side effect.
   *
   * Files NO findings, on purpose. A finding filed here would claim a human
   * accepted a risk they were never shown; the settle is a machine noticing the
   * run ended, not a person answering a gate.
   */
  async reconcileAtSettle(runId: string): Promise<void> {
    try {
      const meta = this.resolveRunMeta(runId);
      if (!meta || !DESIGN_FLOWS.has(meta.workflowName)) return;
      // A gate the human answered with anything but an approve is NOT converged
      // on by the settle: the 2026-09-15 smoke bound a design the human had just
      // sent back for rework because the settle re-ran the bind unconditionally.
      // Only a gate that was never minted (the orchestrated inline-question path
      // this reconciliation exists for) or one resolved 'approve' reaches the writes.
      const designGate = this.latestGateResolution(runId, APPROVE_DESIGN);
      if (designGate === null || gateDecisionFromResolution(designGate) === 'approve') {
        await this.bind(runId, meta.projectId, listRunOwnedIdeaIds(this.deps.db, runId));
      }
      const briefGate = this.latestGateResolution(runId, APPROVE_BRIEF);
      if (meta.workflowName === 'launch' && (briefGate === null || gateDecisionFromResolution(briefGate) === 'approve')) {
        this.stampThoroughness(runId, meta.projectId);
      }
    } catch (err) {
      this.deps.logger?.warn('[gateSideEffects] settle reconciliation failed (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Arms
  // -------------------------------------------------------------------------

  /** Bind the run's prototype to `ideaIds`, logging the outcome. */
  private async bind(runId: string, projectId: number, ideaIds: readonly string[]): Promise<void> {
    if (ideaIds.length === 0) return;
    const result = await bindApprovedDesignsForRun(
      {
        db: this.deps.db,
        snapshotBaseDir: this.deps.snapshotBaseDir,
        loadPrototypeHtml: this.deps.loadPrototypeHtml,
        ...(this.deps.ideaComponentRouter ? { ideaComponentRouter: this.deps.ideaComponentRouter } : {}),
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      },
      { runId, projectId, ideaIds },
    );
    if (result.bound.length > 0) {
      this.deps.logger?.info('[gateSideEffects] approved designs bound', {
        runId,
        bound: result.bound.length,
        skipped: result.skipped.length,
      });
    }
  }

  /**
   * The run-owned idea ids the gate's verdict map APPROVED.
   *
   * The map is keyed by display ref, so each approved ref is resolved back to an
   * idea id and intersected with what the run owns — a stray ref cannot bind a
   * design to an idea this run has nothing to do with. A resolution with NO
   * parseable map (a scalar approve on a legacy gate) falls back to every owned
   * idea: the human approved the gate as a whole, so the batch is the answer.
   */
  private approvedIdeaIds(runId: string, resolution: string | null | undefined): string[] {
    const owned = listRunOwnedIdeaIds(this.deps.db, runId);
    const verdicts = parseIdeaVerdictMap(resolution) ?? parseDesignVerdictMap(resolution);
    if (verdicts === null) return owned;

    const ownedSet = new Set(owned);
    const approved: string[] = [];
    for (const [ref, verdict] of Object.entries(verdicts)) {
      if (verdict !== 'approve') continue;
      const id = this.ideaIdForRef(ref);
      if (id !== null && ownedSet.has(id)) approved.push(id);
    }
    return approved;
  }

  /** Resolve an idea display ref (IDEA-014) to its opaque id, or null. */
  private ideaIdForRef(ref: string): string | null {
    try {
      const row = this.deps.db.prepare('SELECT id FROM ideas WHERE ref = ?').get(ref) as
        | { id?: unknown }
        | undefined;
      return typeof row?.id === 'string' ? row.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Parse the run's project brief for its `THOROUGHNESS:` flag and stamp the
   * project. A brief with no flag stamps nothing — see parseThoroughnessFlag on
   * why null is never guessed past.
   */
  private stampThoroughness(runId: string, projectId: number): void {
    const brief = this.readArtifactMarkdown(runId, 'project-brief');
    const level = parseThoroughnessDeclaration(brief);
    if (level === null) {
      this.deps.logger?.warn('[gateSideEffects] brief declares no solution thoroughness; project not stamped', { runId, projectId });
      return;
    }
    this.deps.logger?.info('[gateSideEffects] solution thoroughness stamped', { runId, projectId, level });
    const settingsDeps: ProjectSettingsDeps = {
      db: this.deps.db,
      ...(this.deps.emitProjectUpdated ? { emitProjectUpdated: this.deps.emitProjectUpdated } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    };
    stampSolutionThoroughness(settingsDeps, { projectId, level });
  }

  /**
   * File one non-blocking finding per adversarial-review entry — the accepted
   * risks of approving this design.
   *
   * IDEMPOTENT by `AR-n` prefix within the run: the gate can be resolved more than
   * once across a rewind, and the settle path could in principle reach the same
   * artifact, so an entry already filed is skipped rather than duplicated. The
   * prefix (not the full title) is the key on purpose — a post-Revise re-review
   * may reword AR-3 while it stays the same defect.
   *
   * Every write goes through the ReviewItemRouter chokepoint. Without the router
   * wired this arm is a no-op, which is the right failure: findings are entity
   * state, and there is no sanctioned path around the chokepoint.
   */
  private async fileAcceptedRiskFindings(runId: string, projectId: number): Promise<void> {
    const router = this.deps.reviewItemRouter;
    if (!router) return;
    const markdown = readAdversarialReviewMarkdown(this.deps.db, runId);
    if (markdown === undefined) return;

    const { blocking, findings } = parseAdversarialReviewDoc(markdown);
    const entries = [...blocking, ...findings];
    if (entries.length === 0) return;

    const alreadyFiled = this.filedAdversarialIds(runId);
    let filed = 0;
    for (const entry of entries) {
      if (alreadyFiled.has(entry.id)) continue;
      try {
        await router.applyReviewItem(projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'finding',
          title: `${entry.id} — ${entry.title}`,
          body: renderAcceptedRiskBody(entry),
          blocking: false,
          severity: adversarialSeverityToReviewSeverity(entry.severity),
          source: ADVERSARIAL_FINDING_SOURCE,
          runId,
          payload: {
            kind: 'finding',
            category: ADVERSARIAL_FINDING_CATEGORY,
            ...(entry.fix !== undefined ? { suggestedFix: entry.fix } : {}),
            proposedTarget: 'backlog',
          },
        });
        filed += 1;
      } catch (err) {
        // One bad entry must not cost the rest — this is the only record these
        // risks will ever have.
        this.deps.logger?.warn('[gateSideEffects] accepted-risk finding not filed', {
          runId,
          arId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (filed > 0) {
      this.deps.logger?.info('[gateSideEffects] adversarial findings accepted at the design gate', {
        runId,
        filed,
        total: entries.length,
      });
    }
  }

  /**
   * The `AR-n` ids this run has already filed, read off the finding TITLES.
   *
   * The title prefix is the idempotence key rather than a payload field because
   * `FindingPayload` has no slot for one, and inventing an untyped key on the
   * payload would be invisible to every reader. The prefix is stable, visible in
   * the queue, and the same thing the review doc calls the entry.
   */
  private filedAdversarialIds(runId: string): Set<string> {
    const ids = new Set<string>();
    try {
      const rows = this.deps.db
        .prepare(
          `SELECT title FROM review_items
            WHERE run_id = ? AND kind = 'finding' AND source = ?`,
        )
        .all(runId, ADVERSARIAL_FINDING_SOURCE) as Array<{ title?: unknown }>;
      for (const row of rows) {
        if (typeof row.title !== 'string') continue;
        const m = /^(AR-\d+)\b/.exec(row.title);
        if (m) ids.add(m[1]);
      }
    } catch {
      // An unreadable history is treated as "nothing filed": a duplicate finding
      // is recoverable by a human, a dropped one is not.
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The run's workflow name + project id, or null when the run row is gone. */
  /**
   * The stored resolution of the run's most recent `gate:human-step:<stepId>`
   * decision item, or null when no such item was ever minted (the orchestrated
   * inline-question path) or the read fails. A pending item reads as null too —
   * a settle that arrives while a gate is still open has nothing to converge on.
   */
  private latestGateResolution(runId: string, stepId: string): string | null {
    try {
      const row = this.deps.db
        .prepare(
          `SELECT resolution FROM review_items
            WHERE run_id = ? AND kind = 'decision' AND source = ? AND status <> 'pending'
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(runId, `gate:human-step:${stepId}`) as { resolution?: string | null } | undefined;
      if (!row) return null;
      return typeof row.resolution === 'string' ? row.resolution : '';
    } catch {
      return null;
    }
  }

  private resolveRunMeta(runId: string): { workflowName: string; projectId: number } | null {
    try {
      const row = this.deps.db
        .prepare(
          `SELECT w.name AS workflowName, r.project_id AS projectId
             FROM workflow_runs r
             JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(runId) as RunMetaRow | undefined;
      if (!row) return null;
      const workflowName = typeof row.workflowName === 'string' ? row.workflowName : null;
      const projectId = typeof row.projectId === 'number' ? row.projectId : null;
      if (workflowName === null || projectId === null) return null;
      return { workflowName, projectId };
    } catch {
      return null;
    }
  }

  /** A run artifact's `payload_json.markdown`, or undefined. */
  private readArtifactMarkdown(runId: string, atype: string): string | undefined {
    try {
      const row = this.deps.db
        .prepare('SELECT payload_json AS payloadJson FROM artifacts WHERE run_id = ? AND atype = ? LIMIT 1')
        .get(runId, atype) as { payloadJson?: string | null } | undefined;
      if (typeof row?.payloadJson !== 'string' || row.payloadJson.length === 0) return undefined;
      const parsed: unknown = JSON.parse(row.payloadJson);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const markdown = (parsed as { markdown?: unknown }).markdown;
      return typeof markdown === 'string' && markdown.trim().length > 0 ? markdown : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * The body of an accepted-risk finding: the reviewer's own what/why/fix, then the
 * line that says how this finding came to exist. Without that line the finding
 * reads as a fresh defect report rather than as a risk somebody already weighed
 * and chose to carry.
 */
function renderAcceptedRiskBody(entry: AdversarialFinding): string {
  const lines: string[] = [];
  if (entry.what !== undefined) lines.push(entry.what);
  if (entry.why !== undefined) lines.push('', `**Why it matters:** ${entry.why}`);
  if (entry.fix !== undefined) lines.push('', `**Fix:** ${entry.fix}`);
  const qualifiers = entry.area !== undefined ? `${entry.severity}, ${entry.area}` : entry.severity;
  lines.push(
    '',
    `Raised by the adversarial reviewer (${qualifiers}). Accepted at the approve-design gate; see the Adversarial review tab for the full critique.`,
  );
  return lines.join('\n').trim();
}
