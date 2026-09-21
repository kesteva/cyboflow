/**
 * quickSessionTriage — pure derivation for the review home's quick-session
 * triage groups (Needs your input / Ready for review / Working), plus the
 * overlay + sort helpers they build on.
 *
 * Moved from QuickSessionsTable.tsx (now replaced by SessionTriageGroups) —
 * `overrideRunningForActiveWorkflows`, `overrideRecentIdleAsRunning`, and
 * `sortQuickSessionRows` keep their original semantics verbatim.
 */
import type { QuickSessionRow } from '../../../shared/types/quickSessions';

/** Board sort weight — lower sorts first. Attention descends, running last. */
function sortWeight(row: QuickSessionRow): number {
  if (row.state === 'blocked') return 0;
  if (row.state === 'idle') return row.unviewed ? 1 : 2;
  return 3; // running
}

/**
 * Override `idle` → `running` for sessions with a live dynamic workflow.
 *
 * A quick session that launches a Claude Code dynamic workflow (the Workflow
 * tool) parks its PTY turn while the workflow runs DETACHED in the background —
 * so `sessions.status` reads `completed` and the row derives to `idle`, even
 * though the session is actively working (and the Active-agents panel shows it
 * running). This reconciles the triage with that panel: any idle row whose
 * sessionId has an active dynamic workflow is shown `running` (idleSince
 * cleared so no "quiet for N" label). `blocked` is never overridden — a
 * pending question still wins.
 */
export function overrideRunningForActiveWorkflows(
  rows: QuickSessionRow[],
  activeWorkflowSessionIds: ReadonlySet<string>,
): QuickSessionRow[] {
  return rows.map((row) =>
    row.state === 'idle' && activeWorkflowSessionIds.has(row.sessionId)
      ? { ...row, state: 'running', idleSince: null }
      : row,
  );
}

/**
 * Grace window before a rested session is labeled `idle` / "quiet".
 *
 * A turn ending stamps `sessions.updated_at`, so a session that JUST finished
 * derives to `idle` with "quiet 0s" — noisy, since a follow-up turn often lands
 * within a few seconds. Within this window after its last turn the row is shown
 * `running` instead, and only flips to `idle` once it has actually been quiet
 * for the full window. At the boundary the label reads "quiet 1m", never
 * resetting a counter (idleSince is preserved, so elapsed keeps climbing from
 * the real rest time).
 */
export const QUIET_GRACE_MS = 60_000;

/**
 * Override `idle` → `running` for sessions that rested less than {@link QUIET_GRACE_MS}
 * ago (see the grace-window rationale above). Time-based, so it must be recomputed
 * against the live clock (`nowMs`). `blocked`/`running` rows and rows with an
 * unparseable `idleSince` pass through untouched.
 */
export function overrideRecentIdleAsRunning(
  rows: QuickSessionRow[],
  nowMs: number,
  graceMs: number = QUIET_GRACE_MS,
): QuickSessionRow[] {
  return rows.map((row) => {
    if (row.state !== 'idle' || row.idleSince === null) return row;
    const idleMs = Date.parse(row.idleSince);
    if (Number.isNaN(idleMs)) return row;
    return nowMs - idleMs < graceMs ? { ...row, state: 'running', idleSince: null } : row;
  });
}

/** Stable board order: attention first, then longest-quiet idle first. */
export function sortQuickSessionRows(rows: QuickSessionRow[]): QuickSessionRow[] {
  return [...rows].sort((a, b) => {
    const wa = sortWeight(a);
    const wb = sortWeight(b);
    if (wa !== wb) return wa - wb;
    // Within idle, oldest idleSince (longest quiet) first.
    if (a.idleSince !== null && b.idleSince !== null) return a.idleSince.localeCompare(b.idleSince);
    return a.name.localeCompare(b.name);
  });
}

/** The three triage buckets rendered by {@link SessionTriageGroups}. */
export interface QuickSessionTriage {
  /** Blocked, or idle with a `needs_input` summarizer verdict — waiting on YOUR answer. */
  needsInput: QuickSessionRow[];
  /** Rested and not waiting on an answer — finished work to review/merge/wrap up. */
  readyForReview: QuickSessionRow[];
  /** Actively working (post-overlay) — nothing needed from you. */
  working: QuickSessionRow[];
}

/**
 * Split live quick-session rows into the three triage groups.
 *
 * Applies the running-overlays FIRST (in the same order the old compact board
 * did) so a grace-window-recent or actively-workflowing row classifies as
 * `working` rather than `readyForReview`/`needsInput`. Then:
 *   - `needsInput`  — `blocked`, or `idle` with `summaryState === 'needs_input'`
 *     (regardless of `unviewed` — a question stays a question after you look).
 *   - `working`     — `running` (post-overlay).
 *   - `readyForReview` — everything else (idle, not needs-input).
 *
 * `needsInput` sorts oldest `restedAtIso` first (nulls last, then name);
 * `readyForReview` reuses {@link sortQuickSessionRows}'s weights (unviewed idle
 * first, longest-quiet first — every row in this bucket is idle, so the
 * blocked/running weight tiers never apply); `working` sorts by name.
 */
export function deriveQuickSessionTriage(
  rows: QuickSessionRow[],
  activeWorkflowSessionIds: ReadonlySet<string>,
  nowMs: number,
): QuickSessionTriage {
  const overridden = overrideRecentIdleAsRunning(
    overrideRunningForActiveWorkflows(rows, activeWorkflowSessionIds),
    nowMs,
  );

  const needsInput: QuickSessionRow[] = [];
  const readyForReview: QuickSessionRow[] = [];
  const working: QuickSessionRow[] = [];

  for (const row of overridden) {
    if (row.state === 'blocked' || (row.state === 'idle' && row.summaryState === 'needs_input')) {
      needsInput.push(row);
    } else if (row.state === 'running') {
      working.push(row);
    } else {
      readyForReview.push(row);
    }
  }

  needsInput.sort((a, b) => {
    if (a.restedAtIso === null && b.restedAtIso === null) return a.name.localeCompare(b.name);
    if (a.restedAtIso === null) return 1;
    if (b.restedAtIso === null) return -1;
    return a.restedAtIso.localeCompare(b.restedAtIso);
  });

  return {
    needsInput,
    readyForReview: sortQuickSessionRows(readyForReview),
    working: [...working].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Presentation for a Ready-for-review row's right-side status label. */
export interface ReadyStateDescription {
  label: string;
  tone: 'error' | 'neutral' | 'success';
}

/**
 * Describe a Ready-for-review row's finish state for its right-aligned label.
 *
 * Order matters: a failed/nonzero-exit run is flagged first regardless of git
 * state; a user-stopped run is next; only then does the git snapshot (cache-only
 * — see {@link QuickSessionRow.git}) decide ready-to-merge / behind / uncommitted
 * / clean. A row with no git cache entry renders nothing (empty label).
 *
 * `terminalFlowRun` (TASK-226): when the session's most significant run is a
 * FLOW run that has since finished, that run — not the `__quick__` chat the
 * flow interrupted when it launched — is what the row is about, so its status
 * decides the stop/fail wording: `failed` → "stopped early", `canceled` →
 * "stopped by you", `completed` → nothing stopped, fall through to git facts.
 * Only `status` is read, so callers can pass any row-shaped run.
 */
export function describeReadyState(
  row: QuickSessionRow,
  terminalFlowRun?: { status: string } | null,
): ReadyStateDescription {
  if (terminalFlowRun) {
    if (terminalFlowRun.status === 'failed') return { label: 'stopped early', tone: 'error' };
    if (terminalFlowRun.status === 'canceled') return { label: 'stopped by you', tone: 'neutral' };
  } else {
    if (row.rawStatus === 'failed' || (row.exitCode !== null && row.exitCode !== 0)) {
      return { label: 'stopped early', tone: 'error' };
    }
    if (row.rawStatus === 'stopped') {
      return { label: 'stopped by you', tone: 'neutral' };
    }
  }
  if (row.git !== null) {
    if (row.git.isReadyToMerge) {
      return { label: `ready to merge ↑${row.git.ahead} · clean`, tone: 'success' };
    }
    if (row.git.behind > 0) {
      return { label: 'behind base', tone: 'neutral' };
    }
    if (row.git.hasUncommittedChanges || row.git.hasUntrackedFiles) {
      return { label: 'uncommitted changes', tone: 'neutral' };
    }
    return { label: 'clean', tone: 'neutral' };
  }
  return { label: '', tone: 'neutral' };
}
