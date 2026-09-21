import { describe, it, expect } from 'vitest';
import {
  sortQuickSessionRows,
  overrideRunningForActiveWorkflows,
  overrideRecentIdleAsRunning,
  deriveQuickSessionTriage,
  describeReadyState,
  QUIET_GRACE_MS,
} from '../../utils/quickSessionTriage';
import type { QuickSessionGitSnapshot, QuickSessionRow } from '../../../../shared/types/quickSessions';

function row(o: Partial<QuickSessionRow>): QuickSessionRow {
  return {
    sessionId: o.sessionId ?? 'id',
    name: o.name ?? 'name',
    projectId: 1,
    runId: 'r',
    state: o.state ?? 'idle',
    idleSince: o.idleSince ?? null,
    unviewed: o.unviewed ?? false,
    restedAtIso: o.restedAtIso ?? null,
    rawStatus: o.rawStatus ?? 'completed',
    exitCode: o.exitCode ?? null,
    summary: o.summary ?? null,
    summaryState: o.summaryState ?? null,
    waitingOn: o.waitingOn ?? null,
    summarySupported: o.summarySupported ?? true,
    worktreeName: o.worktreeName ?? null,
    git: o.git ?? null,
  };
}

function gitSnapshot(o: Partial<QuickSessionGitSnapshot>): QuickSessionGitSnapshot {
  return {
    isReadyToMerge: o.isReadyToMerge ?? false,
    hasUncommittedChanges: o.hasUncommittedChanges ?? false,
    hasUntrackedFiles: o.hasUntrackedFiles ?? false,
    ahead: o.ahead ?? 0,
    behind: o.behind ?? 0,
    lastCheckedIso: o.lastCheckedIso ?? '2026-07-06T10:00:00Z',
  };
}

describe('sortQuickSessionRows', () => {
  it('orders blocked → idle-unviewed → idle-viewed → running', () => {
    const rows = [
      row({ sessionId: 'running', state: 'running' }),
      row({ sessionId: 'idle-viewed', state: 'idle', unviewed: false, idleSince: '2026-07-06T10:00:00Z' }),
      row({ sessionId: 'blocked', state: 'blocked' }),
      row({ sessionId: 'idle-unviewed', state: 'idle', unviewed: true, idleSince: '2026-07-06T10:00:00Z' }),
    ];
    expect(sortQuickSessionRows(rows).map((r) => r.sessionId)).toEqual([
      'blocked',
      'idle-unviewed',
      'idle-viewed',
      'running',
    ]);
  });

  it('within idle, longest-quiet (oldest idleSince) first', () => {
    const rows = [
      row({ sessionId: 'newer', state: 'idle', unviewed: true, idleSince: '2026-07-06T10:00:00Z' }),
      row({ sessionId: 'older', state: 'idle', unviewed: true, idleSince: '2026-07-06T08:00:00Z' }),
    ];
    expect(sortQuickSessionRows(rows).map((r) => r.sessionId)).toEqual(['older', 'newer']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ sessionId: 'a', state: 'running' }), row({ sessionId: 'b', state: 'blocked' })];
    const before = rows.map((r) => r.sessionId);
    sortQuickSessionRows(rows);
    expect(rows.map((r) => r.sessionId)).toEqual(before);
  });
});

describe('overrideRunningForActiveWorkflows', () => {
  it('flips an idle row with a live dynamic workflow to running (clears idleSince)', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T10:00:00Z', unviewed: true })];
    const out = overrideRunningForActiveWorkflows(rows, new Set(['s1']));
    expect(out[0].state).toBe('running');
    expect(out[0].idleSince).toBeNull();
  });

  it('leaves an idle row WITHOUT a live workflow untouched', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T10:00:00Z' })];
    const out = overrideRunningForActiveWorkflows(rows, new Set(['other']));
    expect(out[0].state).toBe('idle');
    expect(out[0].idleSince).toBe('2026-07-06T10:00:00Z');
  });

  it('never overrides a blocked row even with a live workflow (question still wins)', () => {
    const rows = [row({ sessionId: 's1', state: 'blocked', idleSince: null })];
    const out = overrideRunningForActiveWorkflows(rows, new Set(['s1']));
    expect(out[0].state).toBe('blocked');
  });

  it('does not mutate the input rows', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T10:00:00Z' })];
    overrideRunningForActiveWorkflows(rows, new Set(['s1']));
    expect(rows[0].state).toBe('idle');
    expect(rows[0].idleSince).toBe('2026-07-06T10:00:00Z');
  });
});

describe('overrideRecentIdleAsRunning', () => {
  const idleSince = '2026-07-06T10:00:00Z';
  const nowMs = Date.parse(idleSince);

  it('flips an idle row that rested within the grace window to running', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince, unviewed: true })];
    // 30s after the last turn — still inside the 60s grace window.
    const out = overrideRecentIdleAsRunning(rows, nowMs + 30_000);
    expect(out[0].state).toBe('running');
    expect(out[0].idleSince).toBeNull();
  });

  it('leaves an idle row that has been quiet past the grace window as idle', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince })];
    // Exactly at the boundary is no longer "recent" (>= grace).
    const out = overrideRecentIdleAsRunning(rows, nowMs + QUIET_GRACE_MS);
    expect(out[0].state).toBe('idle');
    expect(out[0].idleSince).toBe(idleSince);
  });

  it('never touches a running row (no idleSince to measure)', () => {
    const rows = [row({ sessionId: 's1', state: 'running', idleSince: null })];
    const out = overrideRecentIdleAsRunning(rows, nowMs + 1_000);
    expect(out[0].state).toBe('running');
  });

  it('passes through an idle row with an unparseable idleSince', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: 'not-a-date' })];
    const out = overrideRecentIdleAsRunning(rows, nowMs);
    expect(out[0].state).toBe('idle');
    expect(out[0].idleSince).toBe('not-a-date');
  });

  it('does not mutate the input rows', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince })];
    overrideRecentIdleAsRunning(rows, nowMs + 1_000);
    expect(rows[0].state).toBe('idle');
    expect(rows[0].idleSince).toBe(idleSince);
  });
});

describe('deriveQuickSessionTriage', () => {
  const nowMs = Date.parse('2026-07-06T12:00:00Z');

  it('classifies a blocked row as needsInput', () => {
    const rows = [row({ sessionId: 's1', state: 'blocked' })];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.needsInput.map((r) => r.sessionId)).toEqual(['s1']);
    expect(triage.readyForReview).toEqual([]);
    expect(triage.working).toEqual([]);
  });

  it('classifies an idle+needs_input row as needsInput even when already viewed', () => {
    const rows = [
      row({
        sessionId: 's1',
        state: 'idle',
        unviewed: false,
        summaryState: 'needs_input',
        idleSince: '2026-07-06T11:00:00Z',
      }),
    ];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.needsInput.map((r) => r.sessionId)).toEqual(['s1']);
  });

  it('classifies a clean idle row as readyForReview', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T11:00:00Z' })];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.readyForReview.map((r) => r.sessionId)).toEqual(['s1']);
    expect(triage.needsInput).toEqual([]);
  });

  it('classifies a running row as working', () => {
    const rows = [row({ sessionId: 's1', state: 'running' })];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.working.map((r) => r.sessionId)).toEqual(['s1']);
  });

  it('a recently-idle row (inside the grace window) classifies as working', () => {
    const idleSince = '2026-07-06T11:59:45Z'; // 15s ago
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince })];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.working.map((r) => r.sessionId)).toEqual(['s1']);
    expect(triage.readyForReview).toEqual([]);
  });

  it('the same row classifies as readyForReview once the grace window passes', () => {
    const idleSince = '2026-07-06T11:59:45Z';
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince })];
    const laterNowMs = Date.parse(idleSince) + QUIET_GRACE_MS + 1_000;
    const triage = deriveQuickSessionTriage(rows, new Set(), laterNowMs);
    expect(triage.readyForReview.map((r) => r.sessionId)).toEqual(['s1']);
    expect(triage.working).toEqual([]);
  });

  it('an idle row with a live dynamic workflow classifies as working', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T11:00:00Z' })];
    const triage = deriveQuickSessionTriage(rows, new Set(['s1']), nowMs);
    expect(triage.working.map((r) => r.sessionId)).toEqual(['s1']);
  });

  it('sorts needsInput by restedAtIso, oldest first', () => {
    const rows = [
      row({ sessionId: 'newer', state: 'blocked', restedAtIso: '2026-07-06T11:30:00Z' }),
      row({ sessionId: 'older', state: 'blocked', restedAtIso: '2026-07-06T10:00:00Z' }),
      row({ sessionId: 'no-updated', state: 'blocked', restedAtIso: null, name: 'zzz' }),
    ];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.needsInput.map((r) => r.sessionId)).toEqual(['older', 'newer', 'no-updated']);
  });

  it('sorts working rows by name', () => {
    const rows = [
      row({ sessionId: 's1', state: 'running', name: 'zebra' }),
      row({ sessionId: 's2', state: 'running', name: 'alpha' }),
    ];
    const triage = deriveQuickSessionTriage(rows, new Set(), nowMs);
    expect(triage.working.map((r) => r.name)).toEqual(['alpha', 'zebra']);
  });
});

describe('describeReadyState', () => {
  it('flags a failed run as stopped early, regardless of git state', () => {
    const state = describeReadyState(
      row({ rawStatus: 'failed', git: gitSnapshot({ isReadyToMerge: true }) }),
    );
    expect(state).toEqual({ label: 'stopped early', tone: 'error' });
  });

  it('flags a nonzero exit code as stopped early', () => {
    const state = describeReadyState(row({ rawStatus: 'completed', exitCode: 1 }));
    expect(state).toEqual({ label: 'stopped early', tone: 'error' });
  });

  it('does not flag an explicit zero exit code as stopped early', () => {
    const state = describeReadyState(row({ rawStatus: 'completed', exitCode: 0, git: null }));
    expect(state).toEqual({ label: '', tone: 'neutral' });
  });

  it('flags a user-stopped run', () => {
    const state = describeReadyState(row({ rawStatus: 'stopped' }));
    expect(state).toEqual({ label: 'stopped by you', tone: 'neutral' });
  });

  describe('with a finished flow run (TASK-226)', () => {
    it('a COMPLETED flow run is not "stopped by you" even though the parked quick chat reads stopped', () => {
      const state = describeReadyState(
        row({ rawStatus: 'stopped', git: gitSnapshot({ isReadyToMerge: true, ahead: 2 }) }),
        { status: 'completed' },
      );
      expect(state).toEqual({ label: 'ready to merge ↑2 · clean', tone: 'success' });
    });

    it('a CANCELED flow run reads "stopped by you"', () => {
      const state = describeReadyState(row({ rawStatus: 'completed' }), { status: 'canceled' });
      expect(state).toEqual({ label: 'stopped by you', tone: 'neutral' });
    });

    it('a FAILED flow run reads "stopped early"', () => {
      const state = describeReadyState(
        row({ rawStatus: 'completed', git: gitSnapshot({ isReadyToMerge: true }) }),
        { status: 'failed' },
      );
      expect(state).toEqual({ label: 'stopped early', tone: 'error' });
    });

    it('null/undefined flow run falls back to the quick row itself', () => {
      expect(describeReadyState(row({ rawStatus: 'stopped' }), null)).toEqual({
        label: 'stopped by you',
        tone: 'neutral',
      });
    });
  });

  it('shows ready-to-merge for a clean ahead branch', () => {
    const state = describeReadyState(
      row({ rawStatus: 'completed', git: gitSnapshot({ isReadyToMerge: true, ahead: 3 }) }),
    );
    expect(state).toEqual({ label: 'ready to merge ↑3 · clean', tone: 'success' });
  });

  it('shows behind base when the branch trails the base', () => {
    const state = describeReadyState(
      row({ rawStatus: 'completed', git: gitSnapshot({ behind: 2 }) }),
    );
    expect(state).toEqual({ label: 'behind base', tone: 'neutral' });
  });

  it('shows uncommitted changes', () => {
    const state = describeReadyState(
      row({ rawStatus: 'completed', git: gitSnapshot({ hasUncommittedChanges: true }) }),
    );
    expect(state).toEqual({ label: 'uncommitted changes', tone: 'neutral' });
  });

  it('shows uncommitted changes for untracked files too', () => {
    const state = describeReadyState(
      row({ rawStatus: 'completed', git: gitSnapshot({ hasUntrackedFiles: true }) }),
    );
    expect(state).toEqual({ label: 'uncommitted changes', tone: 'neutral' });
  });

  it('shows clean when the git snapshot has nothing to report', () => {
    const state = describeReadyState(row({ rawStatus: 'completed', git: gitSnapshot({}) }));
    expect(state).toEqual({ label: 'clean', tone: 'neutral' });
  });

  it('renders nothing when there is no git cache entry', () => {
    const state = describeReadyState(row({ rawStatus: 'completed', git: null }));
    expect(state).toEqual({ label: '', tone: 'neutral' });
  });
});
