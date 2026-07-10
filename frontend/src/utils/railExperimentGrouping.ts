/**
 * Pure grouping logic for the sidebar experiment group row (A/B testing, rail
 * treatment). An experiment's two arm sessions otherwise render as two unrelated
 * rail rows named `ab-<rand8>-a` / `-b`; this collapses the pair (running/grading)
 * — or the surviving winner (decided) — under ONE parent group row.
 *
 * Kept OUT of DraggableProjectTreeView so the ~1600-line tree component stays thin
 * and this branchy claim/visibility logic is unit-testable in isolation.
 *
 * Grouping rules (unit-tested in ./__tests__/railExperimentGrouping.test.ts):
 *  - running | grading  → group visible; BOTH arm sessions move into it, each arm
 *    present iff its session is in the visible list. A group with neither arm
 *    session visible is dropped (nothing to show / claim).
 *  - decided            → group visible IFF the WINNER arm's session is still in
 *    the visible list; the group then contains ONLY that winner arm. Once the
 *    winner session is merged/dismissed (archived → absent) the group is GONE.
 *    A discard-both decision (winner_arm null) never renders a group.
 *  - abandoned          → never a group.
 * Sessions claimed by a visible group are removed from `ungroupedSessions`;
 * everything else passes through untouched.
 */
import type { Session } from '../types/session';
import type { ExperimentArm, ExperimentRow, ExperimentSummary } from '../../../shared/types/experiments';
import { armDisplayLabel } from './experimentDisplay';

/** One arm row inside a rail experiment group. */
export interface RailExperimentArm {
  arm: ExperimentArm;
  /** The arm's visible session (its rail identity). */
  session: Session;
  /** armDisplayLabel result: 'baseline' | variant label | the 'A'/'B' fallback. */
  label: string;
  /**
   * experiments.variant_a_id / variant_b_id for this arm (may be the baseline
   * sentinel; nullable since migration 058 relaxed the columns).
   */
  variantId: string | null;
  /** experiments.run_a_id / run_b_id — the arm's workflow run, or null pre-launch. */
  runId: string | null;
}

/** A grouped experiment: its row, dashboard summary (may be absent), and arm rows. */
export interface RailExperimentGroup {
  experiment: ExperimentRow;
  /** listForDashboard summary joined by id; undefined when not yet loaded / hidden. */
  summary: ExperimentSummary | undefined;
  /** Arm rows, A before B for running/grading; a single winner arm for decided. */
  arms: RailExperimentArm[];
}

/** Output of {@link groupRailExperiments}: the group blocks + the leftover flat sessions. */
export interface RailGroupingResult {
  groups: RailExperimentGroup[];
  ungroupedSessions: Session[];
}

/** Status-pill tone for the parent group row. */
export type RailExperimentPillTone = 'running' | 'grading' | 'ready' | 'won';

/** Parent-row status pill text + tone (tone → color mapped in the component). */
export interface RailExperimentPill {
  text: string;
  tone: RailExperimentPillTone;
}

/** Build one arm row from the experiment row + (optional) dashboard summary. */
function buildArm(
  arm: ExperimentArm,
  session: Session,
  experiment: ExperimentRow,
  summary: ExperimentSummary | undefined,
): RailExperimentArm {
  const variantId = arm === 'A' ? experiment.variant_a_id : experiment.variant_b_id;
  const summaryLabel = arm === 'A' ? summary?.armALabel : summary?.armBLabel;
  const runId = arm === 'A' ? experiment.run_a_id : experiment.run_b_id;
  return {
    arm,
    session,
    // Fall back to the arm key ('A'/'B') when no dashboard summary is loaded; a
    // baseline arm still resolves to 'baseline' via its variant id inside armDisplayLabel.
    label: armDisplayLabel({ variantId, label: summaryLabel ?? arm }),
    variantId,
    runId,
  };
}

/**
 * Collapse an experiment's arm sessions into group rows and return the sessions
 * left over (untouched, non-experiment or unclaimed).
 *
 * @param sessions       The project's VISIBLE sessions (already archived-filtered).
 * @param experiments    The project's ExperimentRow[] (experiments.listForProject).
 * @param summariesById  ExperimentSummary keyed by experimentId (listForDashboard).
 */
export function groupRailExperiments(
  sessions: Session[],
  experiments: ExperimentRow[],
  summariesById: Record<string, ExperimentSummary>,
): RailGroupingResult {
  const sessionById = new Map<string, Session>();
  for (const s of sessions) sessionById.set(s.id, s);

  const groups: RailExperimentGroup[] = [];
  const claimed = new Set<string>();

  for (const experiment of experiments) {
    const summary = summariesById[experiment.id];

    // abandoned → never a group.
    if (experiment.status === 'abandoned') continue;

    if (experiment.status === 'decided') {
      // Winner-only group, visible only while the winner session is still open.
      const winnerArm = experiment.winner_arm;
      if (winnerArm === null) continue; // discard-both — no winner to show
      const winnerSessionId = winnerArm === 'A' ? experiment.session_a_id : experiment.session_b_id;
      const winnerSession = winnerSessionId ? sessionById.get(winnerSessionId) : undefined;
      if (!winnerSession) continue; // merged/dismissed → group gone
      groups.push({
        experiment,
        summary,
        arms: [buildArm(winnerArm, winnerSession, experiment, summary)],
      });
      claimed.add(winnerSession.id);
      continue;
    }

    // running | grading — both arm rows, each present iff its session is visible.
    const arms: RailExperimentArm[] = [];
    const aSession = experiment.session_a_id ? sessionById.get(experiment.session_a_id) : undefined;
    const bSession = experiment.session_b_id ? sessionById.get(experiment.session_b_id) : undefined;
    if (aSession) arms.push(buildArm('A', aSession, experiment, summary));
    if (bSession) arms.push(buildArm('B', bSession, experiment, summary));
    if (arms.length === 0) continue; // neither arm visible → nothing to group
    for (const a of arms) claimed.add(a.session.id);
    groups.push({ experiment, summary, arms });
  }

  const ungroupedSessions = sessions.filter((s) => !claimed.has(s.id));
  return { groups, ungroupedSessions };
}

/**
 * Parent-row status pill. 'verdict ready' is derived statically from a completed
 * pairwise verdict (summary.verdictPreference set) while the experiment is still
 * grading — the live onComparisonReady stream just triggers a refetch that flips
 * this the same way. abandoned never reaches here (it renders no group).
 */
export function railExperimentPill(
  experiment: ExperimentRow,
  summary: ExperimentSummary | undefined,
): RailExperimentPill {
  switch (experiment.status) {
    case 'running':
      return { text: 'running', tone: 'running' };
    case 'grading':
      return summary?.verdictPreference != null
        ? { text: 'verdict ready', tone: 'ready' }
        : { text: 'grading…', tone: 'grading' };
    case 'decided': {
      const arm = experiment.winner_arm;
      return { text: arm ? `${arm} won` : 'decided', tone: 'won' };
    }
    default:
      // Unreachable for a rendered group (abandoned is filtered out); total for safety.
      return { text: experiment.status, tone: 'grading' };
  }
}
