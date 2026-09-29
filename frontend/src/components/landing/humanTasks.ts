/**
 * humanTasks — pure selectors + kickoff prompts behind the Queue page's
 * "Human tasks" band.
 *
 * The band is sourced from the BACKLOG, not from review items: a human task
 * (executor 'human', migration 137) is real work nothing in a sprint will ever
 * move, and the only review item that points at one (humanPrerequisites'
 * `human-task:<id>`) is minted solely when a sprint batch depends on it. Reading
 * the backlog directly is what makes every pending human task visible.
 */
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import type { ReviewItem } from '../../../../shared/types/reviews';

/** The source prefix humanPrerequisites mints a human task's review item under. */
export const HUMAN_TASK_REVIEW_SOURCE_PREFIX = 'human-task:';

/**
 * Pending human tasks: executor 'human', type 'task', plan-approved, not
 * archived, and not at a terminal stage (Done or Won't do). Oldest ref first.
 */
export function selectPendingHumanTasks(
  tasks: readonly BacklogTaskItem[],
  boards: readonly Board[],
): BacklogTaskItem[] {
  const terminalStageIds = new Set<string>();
  for (const board of boards) {
    for (const stage of board.stages) if (stage.is_terminal) terminalStageIds.add(stage.id);
  }
  return tasks
    .filter(
      (t) =>
        t.type === 'task' &&
        t.executor === 'human' &&
        t.approved_at !== null &&
        t.archived_at === null &&
        !t.isDone &&
        !terminalStageIds.has(t.stage_id),
    )
    .sort((a, b) => a.project_id - b.project_id || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

/** The board's Done stage (terminal, position 9), or null when it has none. */
export function findDoneStageId(boards: readonly Board[], boardId: string): string | null {
  const board = boards.find((b) => b.id === boardId);
  return board?.stages.find((s) => s.is_terminal && s.position === 9)?.id ?? null;
}

/** True when a review item is a human task's standing item (folded into its task row). */
export function isHumanTaskReviewItem(item: ReviewItem): boolean {
  return item.source?.startsWith(HUMAN_TASK_REVIEW_SOURCE_PREFIX) ?? false;
}

/**
 * Refs of the tasks waiting on each human task, keyed by the human task's REF —
 * read off every task's `waitingOnHuman` overlay. Refs are per-project, so the
 * key is `<projectId>:<ref>`.
 */
export function dependentsByHumanRef(tasks: readonly BacklogTaskItem[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.isDone || task.archived_at !== null) continue;
    for (const humanRef of task.waitingOnHuman ?? []) {
      const key = `${task.project_id}:${humanRef}`;
      const list = out.get(key) ?? [];
      list.push(task.ref);
      out.set(key, list);
    }
  }
  return out;
}

export type HumanTaskSessionMode = 'verify' | 'help';

function describeTask(task: BacklogTaskItem, doneStageId: string | null): string {
  const lines = [`### ${task.ref} — ${task.title}`];
  // cyboflow_set_task_stage takes a stage ID, which the agent has no way to look up.
  lines.push(
    doneStageId !== null
      ? `Task id: \`${task.id}\` · Done stage id: \`${doneStageId}\``
      : `Task id: \`${task.id}\` · (this board has no Done stage — ask me to close it instead)`,
  );
  const body = task.body?.trim() || task.summary?.trim();
  lines.push(body ? body : '_(No description.)_');
  return lines.join('\n\n');
}

/**
 * The first turn of a Verify / Help session over `tasks` (all from one
 * project). The session runs in place in the project checkout, so local-only
 * state (.env files, CLI logins, keychain entries) is visible to it.
 */
export function buildHumanTaskKickoff(
  mode: HumanTaskSessionMode,
  tasks: readonly BacklogTaskItem[],
  boards: readonly Board[],
): string {
  const refs = tasks.map((t) => t.ref).join(', ');
  const plural = tasks.length > 1;
  const intro =
    mode === 'verify'
      ? [
          `I believe I have finished ${plural ? 'these human tasks' : 'this human task'} from the backlog: ${refs}. ` +
            `Verify ${plural ? 'each one is' : 'it is'} actually complete.`,
          '',
          '- Check for concrete evidence only: environment variables, config and .env files, CLI logins, ' +
            'installed tools, repo files — whatever the task describes. Do not change anything while verifying.',
          `- Report a verdict per task (Complete / Incomplete / Can't tell) with the evidence behind it, ` +
            'and for anything incomplete, exactly what is still missing.',
          '- For anything you cannot check yourself (an account, a purchase, a sign-off), ask me to confirm.',
          '- Then ask me before marking the verified tasks Done; once I agree, move them to the Done stage ' +
            'with the cyboflow_set_task_stage tool.',
        ]
      : [
          `Help me complete ${plural ? 'these human tasks' : 'this human task'} from the backlog: ${refs}. ` +
            `${plural ? 'They are' : 'It is'} work an agent could not do on its own.`,
          '',
          `- ${plural ? 'Take them one at a time. ' : ''}Do whatever you can yourself (look things up, ` +
            'prepare config, run commands), and give me clear step-by-step instructions for the parts only I can do.',
          '- Check in with me after each step rather than assuming it worked.',
          '- When a task is finished, confirm it with me, then move it to the Done stage with the ' +
            'cyboflow_set_task_stage tool.',
        ];
  const taskSections = tasks.map((t) => describeTask(t, findDoneStageId(boards, t.board_id)));
  return [...intro, '', '## Tasks', '', taskSections.join('\n\n')].join('\n');
}
