/**
 * adversarialReviewGateBody — what the `approve-design` gate actually SAYS.
 *
 * The gate used to open with the generic "step 'approve-design' requires a human
 * decision" body, which asks someone to approve a design while telling them
 * nothing about it. Meanwhile the adversarial reviewer's critique was written,
 * read by nobody, and discarded with the step's turn. Now the critique is a real
 * artifact (`adversarial-review`, migration 136) and this module turns it into the
 * gate's opening text: how many defects were raised, which ones are blocking, how
 * many revisions this run has already taken, and — the part that is genuinely
 * non-obvious — what each button DOES.
 *
 * That last part matters because the two choices are not "yes" and "no". Approve
 * does not discard the findings: it LOGS every one as a non-blocking accepted-risk
 * finding. Revise does not just re-ask: it re-runs the design steps with these
 * findings as feedback. Neither is discoverable from a button label.
 *
 * Pure functions over an injected DatabaseLike: no singletons, no writes, no
 * throwing. `HumanStepManager.openHumanGate` composes the body inside the
 * gate-open transaction, so anything here that threw would fail the gate open
 * itself — every read is wrapped and degrades to "say less" rather than "say
 * nothing at all".
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * main/src/services/*.
 */
import type { DatabaseLike } from './types';
import {
  parseAdversarialReviewDoc,
  type AdversarialFinding,
  type PriorEntry,
} from '../../../shared/types/adversarialReview';
import { parseGateResolution } from '../../../shared/types/reviews';
// The legacy free-text sniff, borrowed rather than re-implemented so this count can
// never disagree with what the gate readers decided the run actually did (CR-13).
// `gateSideEffects` imports this module back (for `readAdversarialReviewMarkdown`),
// so the two form a cycle — harmless here because both sides export hoisted function
// declarations and neither calls the other at module-evaluation time.
import { gateDecisionFromResolution } from './gateSideEffects';

/** The step id whose gate this module speaks for. */
export const APPROVE_DESIGN_STEP_ID = 'approve-design';

/** Source stamped on a programmatic human-gate decision item for that step. */
const APPROVE_DESIGN_GATE_SOURCE = `gate:human-step:${APPROVE_DESIGN_STEP_ID}`;

/**
 * The markdown of this run's `adversarial-review` artifact, or undefined when the
 * run has none (the step is optional and self-skips when there is no prototype or
 * architecture to review) or its payload is unreadable.
 *
 * Reads the run's CURRENT critique, not one pinned at gate-open: the artifact is
 * one-per-run and a post-Revise re-review ENRICHES it, which is exactly what the
 * re-presented gate should be showing.
 */
export function readAdversarialReviewMarkdown(db: DatabaseLike, runId: string): string | undefined {
  try {
    const row = db
      .prepare(
        "SELECT payload_json AS payloadJson FROM artifacts WHERE run_id = ? AND atype = 'adversarial-review' LIMIT 1",
      )
      .get(runId) as { payloadJson?: string | null } | undefined;
    if (typeof row?.payloadJson !== 'string' || row.payloadJson.length === 0) return undefined;
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const markdown = (parsed as { markdown?: unknown }).markdown;
    return typeof markdown === 'string' && markdown.trim().length > 0 ? markdown : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many of this run's resolved `approve-design` gates were a REVISE.
 *
 * NOT simply "how many times the gate was resolved". A resolved gate is not
 * necessarily a revise: a REJECT also resolves it (the run ends rejected, and the
 * monitor's `rewind_to_step` can then bring the walk back to the design steps and
 * re-open the very same gate), and counting one as a revision tells the human they
 * have spent a round they never spent. So the verdict is READ rather than assumed.
 *
 * Verdict reading is the gate readers' own contract: the anchored prefix first
 * ({@link parseGateResolution}, so `revise: only AR-2 matters` is a revise and a
 * note that happens to contain the word 'reject' is not), and only a legacy row —
 * one the grammar does not recognize at all — falls through to
 * {@link gateDecisionFromResolution}'s free-text sniff, which still catches the
 * pre-grammar rows spelled 'please revise'.
 *
 * Fail-soft — an unreadable count yields 0, which understates what the run has
 * done and therefore never shows a scarier number than the truth.
 */
export function countApproveDesignRevisionsUsed(db: DatabaseLike, runId: string): number {
  try {
    const rows = db
      .prepare(
        `SELECT resolution FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND status = 'resolved' AND source = ?`,
      )
      .all(runId, APPROVE_DESIGN_GATE_SOURCE) as { resolution?: string | null }[];
    return rows.filter((row) => {
      const parsed = parseGateResolution(row.resolution);
      return parsed !== null
        ? parsed.verdict === 'revise'
        : gateDecisionFromResolution(row.resolution) === 'revise';
    }).length;
  } catch {
    return 0;
  }
}

function pluralize(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** `**AR-1** — The spend flow has no error state _(blocker · prototype)_` */
function renderBlockingLine(entry: AdversarialFinding): string {
  const qualifiers = entry.area ? `${entry.severity} · ${entry.area}` : entry.severity;
  return `- **${entry.id}** — ${entry.title} _(${qualifiers})_`;
}

/**
 * The CONVERGENCE lines — the part of the body that answers "is this getting
 * better?", which the counts alone cannot.
 *
 * Two rounds of "3 blocking defects" look identical in the counts even when the
 * second round fixed all three and found three unrelated ones. The ledger is the
 * only place that distinction survives, so it is rendered as its own line the
 * moment there is a ledger to read (a first review has none, and says nothing).
 *
 * Deliberately WITHOUT a round number: the only honest sources of one are the
 * controller's walk-scoped counter, which this module cannot see, and the gate's
 * resolved-item count, which undercounts an automatic lap. A wrong round number
 * is worse than none — it would be the one number a reader trusts absolutely.
 *
 * `newBlockers` counts the CURRENT blocking entries the ledger does not mention:
 * an entry the reviewer carried forward is the same defect, whereas an id absent
 * from the ledger is one this round raised for the first time.
 */
function renderConvergence(prior: PriorEntry[], blocking: AdversarialFinding[]): string[] {
  if (prior.length === 0) return [];

  const priorBlockers = prior.filter(
    (p) => p.previousSeverity === 'blocker' || p.previousSeverity === 'major',
  );
  const resolvedBlockers = priorBlockers.filter((p) => p.status === 'resolved').length;
  const regressions = prior.filter((p) => p.status === 'resolved-with-regression').length;
  const setAside = prior.filter((p) => p.status === 'set-aside').length;
  const priorIds = new Set(prior.map((p) => p.id));
  const newBlockers = blocking.filter((entry) => !priorIds.has(entry.id)).length;

  const lines = [
    '',
    `**Convergence:** ${resolvedBlockers} of ${priorBlockers.length} prior ${pluralize(priorBlockers.length, 'blocker', 'blockers')} resolved, ${regressions} ${pluralize(regressions, 'regression', 'regressions')}, ${newBlockers} new ${pluralize(newBlockers, 'blocker', 'blockers')}, ${setAside} set aside.`,
  ];

  const open = prior.filter(
    (p) => p.status === 'unresolved' || p.status === 'resolved-with-regression',
  );
  if (open.length > 0) {
    // Plain text, not a `<details>` block: the review item's body is rendered as a
    // React text child (ReviewItemCard's `whitespace-pre-wrap` <p>), so any HTML
    // here would reach the human as literal `<details>` / `<summary>` tags. Use the
    // same `**Label:**` + list idiom the Blocking section below already uses.
    lines.push(
      '',
      '**Unresolved or regressed:**',
      ...open.map((p) => `- ${p.id} — ${p.status}${p.note !== undefined ? ` — ${p.note}` : ''}`),
    );
  }
  return lines;
}

/**
 * The revisions-so-far sentence, or null when nothing has been revised yet (saying
 * "0 revisions so far" on a first visit is noise that implies a countdown nobody
 * started).
 *
 * A COUNT, NOT A BUDGET, and deliberately without a deadline. This used to render
 * "n of 5 used — this is the last one", which was wrong in both directions. The
 * enforced bound is the controller's per-walk `MAX_STEP_LOOPBACKS`, which lives in
 * memory, is scoped to ONE walk, and RESETS on a rewind; the number here is
 * derived from durable review-item rows that survive every rewind. So the two
 * disagree by construction (live evidence: a gate reading "5 of 5 used" while the
 * controller's counter stood at 4), and this side can only ever OVER-count.
 * Over-counting a fact — "you have revised three times" — is harmless; over-counting
 * a deadline tells a human their next Revise will end the run as `rejected` when it
 * will not. Hence no total, no remaining, no warning.
 */
function renderBudget(used: number): string | null {
  if (used <= 0) return null;
  return `**Revisions so far this run: ${used}.**`;
}

/**
 * Compose the `approve-design` gate body from this run's adversarial review.
 *
 * Returns null when the run has NO adversarial-review artifact, which is the
 * honest answer for a run whose optional review step self-skipped: the caller then
 * keeps whatever body it would otherwise have used. A review that raised nothing
 * still returns a body — "the reviewer found nothing blocking" is information the
 * human is entitled to before approving.
 */
export function composeAdversarialReviewGateBody(db: DatabaseLike, runId: string): string | null {
  const markdown = readAdversarialReviewMarkdown(db, runId);
  if (markdown === undefined) return null;

  const { blocking, findings, prior } = parseAdversarialReviewDoc(markdown);
  const lines: string[] = [];

  if (blocking.length === 0 && findings.length === 0) {
    lines.push('The adversarial reviewer raised nothing — no blocking defects and no advisory findings.');
  } else {
    const parts: string[] = [];
    if (blocking.length > 0) {
      parts.push(`**${blocking.length} blocking ${pluralize(blocking.length, 'defect', 'defects')}**`);
    }
    if (findings.length > 0) {
      parts.push(`${findings.length} advisory ${pluralize(findings.length, 'finding', 'findings')}`);
    }
    lines.push(`The adversarial reviewer raised ${parts.join(' and ')}. Full detail is in the Adversarial review tab.`);
  }

  lines.push(...renderConvergence(prior, blocking));

  if (blocking.length > 0) {
    lines.push('', '**Blocking:**', ...blocking.map(renderBlockingLine));
  }

  const budget = renderBudget(countApproveDesignRevisionsUsed(db, runId));
  if (budget !== null) lines.push('', budget);

  lines.push(
    '',
    '**Your two choices:**',
    '',
    '- **Revise** — rerun planning. The design steps run again with these findings as feedback, and the reviewer re-reviews the result. Use this when a blocking defect has to be fixed before anything is built.',
    '- **Approve** — continue. Every finding above is logged as a non-blocking accepted-risk finding in the review queue, linked to the Adversarial review tab, so nothing is lost — it just stops holding the run up.',
  );

  return lines.join('\n');
}
