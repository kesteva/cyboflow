/**
 * The lane runbook-bootstrap PREFLIGHT — the decision made at enqueue time,
 * before any request row exists (docs/proposals/lane-runbook-bootstrap.md §12
 * step 1, §13 phase 2).
 *
 * WHAT IT ANSWERS. "This lane is about to enqueue a verification the §3.2
 * degrade gate is going to skip. Should this run derive and prove a runbook
 * first, or is skipping the honest outcome?" That is deliberately ALL it
 * answers: it is a pure decision over (toggle, task shape, runbook situation),
 * with the acting — claim the stamp, spawn the drafting agent, commit, register,
 * prove, re-enqueue — layered on top in phase 3.
 *
 * WHY IT LIVES BEFORE THE ENQUEUE rather than inside the gate. The gate runs
 * after the row is written and the lease taken; by then the lane has a request
 * that is going to be skipped and a `skipped` terminal is the only thing left to
 * write. The bootstrap has to happen while there is still a decision to make —
 * and, critically, before the enqueue key is burned: `findLiveRequestByEnqueueKey`
 * counts a `skipped` terminal as a live dedup hit, so a bootstrap that ran
 * afterwards could not re-fire the lane's own request under the same key.
 *
 * WHY IT IS NOT INSIDE `enqueueTaskVerification`. Two reasons. The decision has
 * to be unit-testable without a scheduler, a database, or a filesystem — it is
 * the piece whose correctness matters most and whose inputs are the easiest to
 * fake. And the enqueue seam has a hard NEVER-THROWS contract; keeping the
 * decision here, injected, means that contract is enforced at one small
 * boundary rather than spread through a longer function.
 *
 * PHASE 2 STATUS: this module is COMPLETE and WIRED, and the caller does not yet
 * act on what it returns. The point of landing it dark is that a user who turns
 * the toggle on can read the backend log and see exactly what the bootstrap
 * would have done on their project — including, on projects where it declines,
 * WHY — before any version of it is allowed to write to their branch.
 */
import type { VerificationModality, VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { LoggerLike } from '../types';
import type { VerifyRunbookStatusDetail } from './runbookStore';
import {
  decideRunbookBootstrap,
  taskDerivesEnvironment,
  type BootstrapDecision,
} from './bootstrapEligibility';

/**
 * What the preflight needs from the world. Injected rather than imported for the
 * reason in the module doc — and because `status` is the SAME thunk the degrade
 * gate consults, so the preflight cannot form a second opinion about a project's
 * runbook by reading it a different way.
 */
export interface RunbookBootstrapPreflightDeps {
  /**
   * The resolved feature switch: the project toggle AND the kill switch, already
   * combined. Combined by the caller on purpose — this module has no business
   * reading `process.env`, and a test should be able to say "on" or "off"
   * without staging an environment.
   */
  enabled: boolean;
  /** The runbook situation for a (project, modality) in a specific tree. */
  status: (
    projectId: number,
    modality: VerificationModality,
    probePath?: string,
  ) => Promise<VerifyRunbookStatusDetail>;
  logger?: LoggerLike;
}

/**
 * Decide whether this about-to-be-enqueued verification should trigger a runbook
 * bootstrap.
 *
 * NEVER THROWS. A status resolver that blows up yields `'unobservable'` — the
 * same answer as a record that could not be read, and for the same reason: the
 * one thing a bootstrap must never do is write on a guess. The caller's fallback
 * is today's behavior, so a failure here costs nothing beyond the feature not
 * firing.
 *
 * `probePath` is the run's worktree — the tree the request would actually
 * execute in, and the one the gate now probes too. Passing the project root
 * instead would be the §3 disagreement all over again, one seam later: the
 * preflight would see a runbook the gate cannot use, decline to bootstrap, and
 * the lane would skip anyway.
 */
export async function runbookBootstrapPreflight(
  args: {
    projectId: number;
    runId: string;
    laneTaskRef: string;
    modality: VerificationModality;
    task: Pick<VerificationTaskV1, 'build' | 'serve'>;
    probePath?: string;
  },
  deps: RunbookBootstrapPreflightDeps,
): Promise<BootstrapDecision> {
  const derivesEnvironment = taskDerivesEnvironment(args.task);

  // Ask about the runbook ONLY when the answer could matter. A disabled feature
  // or a degenerate target-only task decides this on its own, and the status
  // read is a file read plus a project input hash — real work to reach a
  // conclusion already in hand.
  let status: VerifyRunbookStatusDetail = { status: 'absent', reason: 'indeterminate' };
  if (deps.enabled && derivesEnvironment) {
    try {
      status = await deps.status(args.projectId, args.modality, args.probePath);
    } catch (err) {
      deps.logger?.warn('[runbookBootstrapPreflight] runbook status failed (declining)', {
        runId: args.runId,
        projectId: args.projectId,
        modality: args.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      // Leave the seeded 'indeterminate' — decideRunbookBootstrap maps it to
      // 'unobservable', which declines.
    }
  }

  const decision = decideRunbookBootstrap({
    enabled: deps.enabled,
    derivesEnvironment,
    status,
  });

  // Logged at DEBUG for the two non-events (feature off, nothing to derive) and
  // INFO for everything else: a project where the bootstrap would fire, or
  // declines for a reason a human may need to know, is worth finding in a log
  // without turning verbose logging on for every degenerate task in every run.
  const quiet =
    !decision.proceed && (decision.reason === 'disabled' || decision.reason === 'no-environment');
  // The three proceed shapes read very differently to whoever is looking at this
  // log to decide whether the feature did the right thing — deriving a rival
  // runbook and re-proving an existing one are opposite actions (F4 / Codex #2),
  // and a line that called both "would bootstrap" would hide exactly the
  // distinction stage 2 exists to make.
  const line = decision.proceed
    ? `[runbookBootstrapPreflight] would bootstrap (${
        decision.mode === 'reprove'
          ? 're-prove the existing runbook'
          : decision.adopt
            ? 'adopt committed runbook'
            : 'derive a new runbook'
      })`
    : `[runbookBootstrapPreflight] declined: ${decision.reason}`;
  const detail = {
    runId: args.runId,
    projectId: args.projectId,
    laneTaskRef: args.laneTaskRef,
    modality: args.modality,
    probePath: args.probePath ?? null,
    runbookReason: status.reason,
  };
  if (quiet) deps.logger?.debug(line, detail);
  else deps.logger?.info(line, detail);

  return decision;
}
