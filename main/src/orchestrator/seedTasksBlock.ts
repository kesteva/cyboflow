/**
 * buildSeedTasksBlock — render the `# Sprint tasks` block BODY for a sprint run's
 * batch (feat/parallel-sprint, single-run lane model).
 *
 * Extracted so BOTH the orchestrated path (`RunExecutor.getPrompt`, which prepends
 * this block to `sprint.md`) and the programmatic path (`composeStepPrompt`, via the
 * runner's `seedTasksProvider`) render the EXACT same task scope. Before the
 * extraction the programmatic step prompt carried no task list at all, so the
 * analyze-dependencies step agent could not see the sprint's tasks (they live in the
 * DB, not on disk), concluded "No dependencies", and the dependents ran concurrently
 * with their prerequisite and failed (verified 2026-06-22).
 *
 * Returns null (caller falls through to the un-prefixed prompt) when: the lane
 * listing throws or yields no ids, or NO seeded task resolves to usable content.
 * Each task renders as `## <ref ?? id>: <title>` + summary + body (present fields
 * only); an individual task that fails to resolve is skipped fail-soft so one bad id
 * never sinks the whole sprint prompt. Pure apart from the injected readers — no fs /
 * DB / Date / randomness of its own.
 */
import type { IdeaBodyReaderLike, SprintLaneTaskIdsLike } from './runExecutor';
import type { LoggerLike } from './types';

export function buildSeedTasksBlock(
  batchId: string,
  sprintLaneTaskIds: SprintLaneTaskIdsLike,
  ideaBodyReader: IdeaBodyReaderLike,
  logger?: LoggerLike,
): string | null {
  let taskIds: string[];
  try {
    taskIds = sprintLaneTaskIds.listLaneTaskIds(batchId);
  } catch (err) {
    logger?.warn(
      `buildSeedTasksBlock: lane listing failed for batch ${batchId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (taskIds.length === 0) return null;

  const sections: string[] = [];
  for (const taskId of taskIds) {
    try {
      const task = ideaBodyReader.read(taskId);
      if (!task) continue;
      const title = task.title?.trim() ?? '';
      const summary = task.summary?.trim() ?? '';
      const body = task.body?.trim() ?? '';
      if (title === '' && summary === '' && body === '') continue;

      const refOrId = task.ref?.trim() || taskId;
      const parts: string[] = [title !== '' ? `## ${refOrId}: ${title}` : `## ${refOrId}`];
      if (summary !== '') parts.push(summary);
      if (body !== '') parts.push(body);
      sections.push(parts.join('\n\n'));
    } catch (err) {
      // Fail-soft per id — one unresolvable task never sinks the sprint prompt.
      logger?.warn(
        `buildSeedTasksBlock: could not resolve task ${taskId} for batch ${batchId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (sections.length === 0) return null;

  const intro = `This sprint covers ${sections.length} task${sections.length === 1 ? '' : 's'}. Execute ALL of them.`;
  return [intro, ...sections].join('\n\n');
}
