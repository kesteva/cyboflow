/**
 * collapsedProjectActivity — the per-project running/blocked counts behind the
 * sidebar's collapsed-project badges (TASK-223).
 *
 * Pure: no React, no I/O. It mirrors the landing page's Working-section
 * derivation (LandingHome.tsx `workingRows`) so the badge and the review home
 * can never disagree on what "running" means for a project:
 *
 *   - a flow run counts by `classifyRun` (homeClassify) — active → running,
 *     blocked → blocked, terminal → nothing;
 *   - a session hosting a NON-terminal flow run is spoken for by that run and
 *     is never double-counted off its own status (Landing's `runSessionIds`);
 *   - a live dynamic workflow (the in-session Workflow tool, tracked by
 *     dynamicWorkflowStore) counts as running for its project — its session
 *     usually reads `completed`/idle while the workflow runs DETACHED, so
 *     without this a detached workflow shows in Working while the collapsed
 *     project shows no badge. A session already spoken for by a flow run keeps
 *     the run (Landing's run > dynamic > quick precedence);
 *   - otherwise a session counts by its own raw status: `running` → running,
 *     `waiting` → blocked.
 *
 * NOT mirrored (documented gap): Landing's quick-session triage also promotes
 * a session that rested less than `QUIET_GRACE_MS` (60s) ago to Working. That
 * overlay is time-based and reads the quick-sessions POLL (a 3s IPC interval
 * that only runs while the review home is mounted); reproducing it here would
 * make the always-mounted sidebar own that poll plus a clock — a deliberate
 * scope decision, not an oversight.
 */
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';
import { classifyRun } from './homeClassify';

export interface CollapsedProjectActivity {
  /** Things actively working — the pulsing green badge. */
  running: number;
  /** Things waiting on the human — the amber badge. */
  blocked: number;
}

export function deriveCollapsedProjectActivity(input: {
  projectId: number;
  /** The project's visible flow-run rows (the same rows the expanded tree renders). */
  runs: ReadonlyArray<{ status: WorkflowRunStatus; session_id?: string | null }>;
  /** The project's visible (non-archived, non-main-repo) session rows. */
  sessions: ReadonlyArray<{ id: string; status: string }>;
  /** Every RUNNING dynamic workflow across all projects (`useActiveDynamicWorkflows`). */
  activeDynamicWorkflows: ReadonlyArray<{ sessionId: string; projectId: number }>;
}): CollapsedProjectActivity {
  const { projectId, runs, sessions, activeDynamicWorkflows } = input;

  // A session hosting a non-terminal flow run is spoken for by that run.
  const runSessionIds = new Set<string>();
  let running = 0;
  let blocked = 0;
  for (const run of runs) {
    const activity = classifyRun(run.status);
    if (activity === 'active') running += 1;
    else if (activity === 'blocked') blocked += 1;
    if (activity !== 'terminal' && run.session_id != null && run.session_id !== '') {
      runSessionIds.add(run.session_id);
    }
  }

  // A live dynamic workflow REPLACES its session's own row (Landing's
  // `dynamics`), unless a flow run already speaks for that session.
  const dynamicSessionIds = new Set<string>();
  for (const workflow of activeDynamicWorkflows) {
    if (workflow.projectId !== projectId) continue;
    if (runSessionIds.has(workflow.sessionId)) continue;
    if (dynamicSessionIds.has(workflow.sessionId)) continue; // one row per session, however many workflows
    dynamicSessionIds.add(workflow.sessionId);
    running += 1;
  }

  for (const session of sessions) {
    if (runSessionIds.has(session.id)) continue;
    if (session.status === 'running') {
      if (!dynamicSessionIds.has(session.id)) running += 1;
    } else if (session.status === 'waiting') {
      // Landing keeps a blocked session in "Needs your input" even while a
      // dynamic workflow row stands in for it under Working — both surface.
      blocked += 1;
    }
  }

  return { running, blocked };
}
