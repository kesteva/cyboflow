/**
 * learnedRunbook — the ENGINE half of §A5 "learn from success"
 * (docs/proposals/runbook-optional-verification.md §A5): deciding whether a
 * validated explore recipe may be learned, writing it through the store's
 * learned-draft verbs, classifying how a learned-pin promotion ended, and the
 * non-blocking review-surface findings for each.
 *
 * Split out of agentEngine.ts so the engine keeps only the call sites; every
 * collaborator here is injected (the store, the status probe, the finding
 * sink), so this module shares the engine's standalone-typecheck invariant.
 *
 * THE PINNED PROOF IS THE SOLE VALIDATOR OF AN AGENT-AUTHORED RECIPE. Learning
 * stores an UNPROVEN draft; only the lane's next ordinary request — which pins
 * it at enqueue (`resolveLearnedDraft`) and executes it verbatim — can promote
 * it, through the same engine-enforced `markProven` every proof takes.
 */
import type { LoggerLike } from '../types';
import type { VerificationModality, VerificationRequestInput } from '../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry, VerifyRunbookV1 } from '../../../../shared/types/verifyRunbook';
import { LEARNED_RUNBOOK_ORIGIN, type VerifyRunbookStatusDetail, type VerifyRunbookStore } from './runbookStore';
import { learnedRecipeCommands } from './learnedRecipe';
import type { VerificationAgentRunResult } from './verificationAgentRunner';

/** One §A5 review-surface notice — the shape the injected sink files as a non-blocking finding. */
export interface RunbookLearningFinding {
  projectId: number;
  runId: string;
  modality: VerificationModality;
  title: string;
  body: string;
  /** Stable key the sink dedupes on (a restart or a replay never files it twice). */
  dedupeKey: string;
  severity: 'info' | 'warning';
}

/** The sink seam — verdictDelivery's `createRunbookLearningFinding` in production. */
export type RunbookLearningFindingFn = (finding: RunbookLearningFinding) => void | Promise<void>;

/**
 * Whether a validated recipe may be learned, from the store's situation for
 * (project, modality) in the requesting run's tree (§A5 "Eligibility"):
 *
 *   - `'no-record'` → LEARN: nothing was ever derived here.
 *   - `'draft'` of origin `'learned'` whose tree declares no entry → FIRST
 *     WRITER WINS: a learned draft already awaits its promotion; this recipe
 *     does not overwrite it (the promotion's own failure path discards it, and
 *     the next passing explore run learns afresh).
 *   - `'file-only'`, or a `'draft'` whose tree's file declares the modality →
 *     SUGGEST: a committed entry exists (or is on its way), and a learned
 *     record would compete with it. The recipe goes to a human instead.
 *   - anything else (a proven record, a drifted one — A7's reprove owns it — a
 *     human- or bootstrap-derived draft, an unobservable store) → SKIP.
 */
export type LearningDecision =
  | { kind: 'learn' }
  | { kind: 'suggest'; why: string }
  | { kind: 'skip'; why: string };

export function decideLearning(detail: VerifyRunbookStatusDetail, origin: string | null): LearningDecision {
  if (detail.reason === 'no-record') return { kind: 'learn' };
  if (detail.reason === 'file-only') {
    return { kind: 'suggest', why: "this project's committed runbook file declares the modality but was never registered here" };
  }
  if (detail.reason === 'draft') {
    if (detail.fileDeclaresModality === true) {
      return { kind: 'suggest', why: "this project's committed runbook file already declares the modality" };
    }
    if (origin === LEARNED_RUNBOOK_ORIGIN) {
      return { kind: 'skip', why: 'first writer wins: a learned draft is already awaiting its promotion' };
    }
    return { kind: 'skip', why: `a ${origin ?? 'registered'} draft exists for the modality` };
  }
  return { kind: 'skip', why: `the record reads "${detail.reason}"` };
}

/** Render commands as a fenced block for a finding body. */
function commandBlock(entry: VerifyRunbookModalityEntry): string {
  return ['```sh', ...learnedRecipeCommands(entry), '```'].join('\n');
}

/** The provenance note stamped into a learned entry — read back by the promotion finding. */
export function learnedFromNote(requestId: string, runId: string): string {
  return `Learned by cyboflow from verification request ${requestId} (run ${runId}).`;
}

/**
 * Learn from ONE passing explore request whose recipe the runner validated.
 * Never throws and never touches the verdict (already written): every failure
 * is logged and ends in "nothing learned".
 */
export async function learnFromExploreSuccess(args: {
  store: VerifyRunbookStore;
  status: (projectId: number, modality: VerificationModality, probePath?: string) => Promise<VerifyRunbookStatusDetail>;
  /** The tree the gate probes for this run (its worktree), else `null` → the project root below. */
  worktreePath: string | null;
  /** Where the draft's drift baseline is stamped from: the worktree, else the project root. */
  probePath: string | null;
  row: { id: string; run_id: string; project_id: number };
  modality: VerificationModality;
  recipe: { entry: VerifyRunbookModalityEntry; levers?: VerifyRunbookV1['levers'] };
  finding?: RunbookLearningFindingFn;
  logger?: LoggerLike;
}): Promise<'learned' | 'suggested' | 'skipped'> {
  const { store, row, modality, logger } = args;
  try {
    const detail = await args.status(row.project_id, modality, args.worktreePath ?? undefined);
    const decision = decideLearning(detail, store.getCurrent(row.project_id, modality)?.origin ?? null);
    const entry: VerifyRunbookModalityEntry = {
      ...args.recipe.entry,
      notes: [args.recipe.entry.notes, learnedFromNote(row.id, row.run_id)].filter((n) => n !== undefined).join('\n'),
    };
    if (decision.kind === 'suggest') {
      await args.finding?.({
        projectId: row.project_id,
        runId: row.run_id,
        modality,
        severity: 'info',
        dedupeKey: `visual-verify:runbook-suggested:${row.run_id}:${modality}`,
        title: `Suggested ${modality} verification runbook entry (from a passing verification)`,
        body: [
          `Verification request \`${row.id}\` stood this project's \`${modality}\` deliverable up on its own and PASSED. Its recipe was not learned because ${decision.why}; a committed entry supersedes a learned one.`,
          'If the committed entry differs, consider this suggested entry for `.cyboflow/verify-runbook.json` — it is exactly what stood the deliverable up, validated by the harness but never proven:',
          ['```json', JSON.stringify({ [modality]: args.recipe.entry, ...(args.recipe.levers ? { levers: args.recipe.levers } : {}) }, null, 2), '```'].join('\n'),
        ].join('\n\n'),
      });
      logger?.info('[learnedRunbook] recipe not learned; filed as a suggested runbook entry (§A5)', {
        requestId: row.id,
        modality,
        why: decision.why,
      });
      return 'suggested';
    }
    if (decision.kind === 'skip' || args.probePath === null) {
      logger?.debug('[learnedRunbook] recipe not learned (§A5)', {
        requestId: row.id,
        modality,
        why: decision.kind === 'skip' ? decision.why : 'no tree to stamp the draft from',
      });
      return 'skipped';
    }
    const written = await store.registerLearnedDraft(row.project_id, modality, entry, args.recipe.levers, args.probePath, null);
    if ('error' in written) {
      logger?.info('[learnedRunbook] learned draft not written (§A5)', { requestId: row.id, modality, error: written.error });
      return 'skipped';
    }
    logger?.info('[learnedRunbook] learned a verification recipe as an unproven draft (§A5)', {
      requestId: row.id,
      modality,
      runbookHash: written.hash,
      runbookLocalVersion: written.version,
    });
    await args.finding?.({
      projectId: row.project_id,
      runId: row.run_id,
      modality,
      severity: 'info',
      dedupeKey: `visual-verify:runbook-learned:${row.project_id}:${modality}:${written.hash}`,
      title: `Verification recipe learned for ${modality} (unproven)`,
      body: [
        `Verification request \`${row.id}\` stood this project's \`${modality}\` deliverable up with no runbook and PASSED, so cyboflow recorded the commands it used as an UNPROVEN ${modality} runbook draft:`,
        commandBlock(entry),
        "The lane's next verification will execute exactly these commands; if it passes, the recipe is promoted to proven and later verifications run it instead of exploring. If it fails to stand the deliverable up, the draft is discarded and that verification explores again. The proof is the only validation an agent-authored recipe gets — review it if the commands look wrong.",
      ].join('\n\n'),
    });
    return 'learned';
  } catch (err) {
    logger?.warn('[learnedRunbook] learning threw (fail-soft; verdict unaffected)', {
      requestId: row.id,
      modality,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'skipped';
  }
}

/**
 * How a LEARNED-PIN request ended (§A5 "Exits"):
 *   - `'promote'` — `passed`: the engine flips the draft proven, then delivers.
 *   - `'keep'` — the surface stood up and ≥1 behaviour genuinely FAILED: the
 *     recipe worked and the change did not; deliver normally, keep the draft.
 *   - `'deliver'` — a PRE-DEPLOY harness skip (preflight, provisioning, no
 *     resolvable agent): the recipe never ran, so it proved nothing either
 *     way; deliver normally and keep the draft.
 *   - `'discard'` — anything else: `build_failed`, `launch_failed`, an identity
 *     failure, a timeout, `low_confidence`, `unverifiable`, a runbook mismatch,
 *     `wrong_environment`. The recipe could not be shown to stand the
 *     deliverable up, so the draft is CAS-discarded and the row re-dispatched
 *     once in explore (the lane gets THAT verdict).
 */
export type LearnedPinExit = 'promote' | 'keep' | 'deliver' | 'discard';

export function classifyLearnedPinExit(result: VerificationAgentRunResult): LearnedPinExit {
  if (result.redispatch !== undefined) return 'discard';
  if (result.status === 'passed') return 'promote';
  if (
    result.status === 'failed' &&
    result.foreignSurface !== true &&
    result.report?.outcome === 'fail' &&
    result.report.behaviors.some((b) => b.result === 'fail')
  ) {
    return 'keep';
  }
  if (result.status === 'skipped' && !result.deployed && result.runbookMismatch !== true) return 'deliver';
  return 'discard';
}

/** The non-blocking "learned recipe promoted" notice (§A5 review surface). */
export function learnedPromotionFinding(args: {
  row: { id: string; run_id: string; project_id: number };
  modality: VerificationModality;
  hash: string;
  entry: VerifyRunbookModalityEntry | undefined;
  input?: VerificationRequestInput;
}): RunbookLearningFinding {
  const { row, modality, entry } = args;
  return {
    projectId: row.project_id,
    runId: row.run_id,
    modality,
    severity: 'info',
    dedupeKey: `visual-verify:runbook-promoted:${row.project_id}:${modality}:${args.hash}`,
    title: `Learned ${modality} verification recipe promoted to proven`,
    body: [
      `Verification request \`${row.id}\` executed the learned ${modality} recipe verbatim and PASSED, so it is now this project's PROVEN ${modality} runbook (origin: learned). Later verifications pin it instead of exploring.`,
      ...(entry !== undefined ? [commandBlock(entry)] : []),
      ...(entry?.notes !== undefined ? [`Provenance: ${entry.notes}`] : []),
      'No human or drafting agent reviewed these commands — the passing proof is their only validation. Commit them to `.cyboflow/verify-runbook.json` (or run Verify Setup) to replace this with a reviewed runbook.',
    ].join('\n\n'),
  };
}
