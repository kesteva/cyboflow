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
  title: 'Add tagging to notes',
  summary: 'Let users attach tags to notes and filter by them.',
  body: '## Idea\n\nNotes are piling up — users want lightweight tags to group and find them. Cover the data model, display, and filtering.',
};

const DEMO_TASKS = [
  {
    title: 'Add tag normalization helpers',
    body: '## AC\n- `normalizeTag` trims + lower-cases labels\n- `uniqueTags` de-duplicates case-insensitively',
  },
  {
    title: 'Cover tag normalization with tests',
    body: '## AC\n- Unit coverage for `normalizeTag` and `uniqueTags`\n- Edge cases: whitespace-only and duplicate labels',
  },
  {
    title: 'Document tagging behavior',
    body: '## AC\n- `docs/tags.md` explains normalization + de-duplication',
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
