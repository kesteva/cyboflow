/**
 * Demo backlog seeding — fired when the user adds a project while demo mode is
 * on (the "add a project" tour step). Writes through TaskChangeRouter (the
 * entity chokepoint) so the board, events log, and subscriptions all behave
 * exactly as for live data:
 *
 *   - one idea, pre-pickable in the planner's idea picker
 *   - three ready tasks, immediately batchable in the sprint task picker
 *     (so the sprint demo works even before running the planner)
 */

import { TaskChangeRouter } from '../../orchestrator/taskChangeRouter';

const DEMO_IDEA = {
  title: 'Add streaks to habits',
  summary: 'Track consecutive-day streaks per habit and surface them to users.',
  body: '## Idea\n\nUsers check habits off but get no sense of momentum — a streak counter is the core motivator of every habit tracker. Cover the calculation, display, and edge rules.',
};

const DEMO_TASKS = [
  {
    title: 'Add streak calculation helpers',
    body: '## AC\n- `computeStreak(completions, today)` counts consecutive calendar days ending today\n- No check-ins → streak 0; a missed day resets the count',
  },
  {
    title: 'Cover streak calculation with tests',
    body: '## AC\n- Unit coverage for `computeStreak` and day bucketing\n- Edge cases: empty completions, multiple check-ins on one day, gap days',
  },
  {
    title: 'Document streak rules',
    body: '## AC\n- `docs/streaks.md` explains day bucketing + reset behavior',
  },
];

/**
 * Seed the demo idea + tasks for a freshly-created demo project.
 * Fail-soft by contract at the call site (a seeding failure must never fail
 * project creation) — this function itself just throws on error.
 */
export async function seedDemoProjectEntities(projectId: number): Promise<void> {
  const router = TaskChangeRouter.getInstance();

  await router.applyChange(projectId, {
    actor: 'user',
    entityType: 'idea',
    title: DEMO_IDEA.title,
    summary: DEMO_IDEA.summary,
    body: DEMO_IDEA.body,
    scope: 'small',
  });

  for (const task of DEMO_TASKS) {
    await router.applyChange(projectId, {
      actor: 'user',
      entityType: 'task',
      title: task.title,
      body: task.body,
    });
  }
}
