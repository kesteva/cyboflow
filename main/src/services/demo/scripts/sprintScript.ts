/**
 * Demo sprint run — drives the swim-lane canvas through a believable batch:
 * dependency analysis, per-task lanes (implement → write-tests → task-verify →
 * integrated) with REAL file changes + commits in the session worktree, and
 * every kind of human approval on the way:
 *
 *   permission  — ApprovalRouter gate before running the test suite
 *   decision    — AskUserQuestion mid-execution (approach choice)
 *   finding     — non-blocking review item from the code-review step
 *   human_task  — blocking follow-up that must be resolved (with the final
 *                 human-review gate) before the run resumes — demonstrating
 *                 aggregate-unblock
 */

import { SprintLaneStore } from '../../../orchestrator/sprintLaneStore';
import { DemoScriptContext } from '../demoScriptContext';

interface LaneWork {
  taskId: string;
  title: string;
  file: string;
  content: string;
  commitMessage: string;
}

/** Per-lane file payloads — cycled when the batch has more tasks than entries. */
const LANE_CHANGES: Array<Omit<LaneWork, 'taskId' | 'title'>> = [
  {
    file: 'src/streaks.ts',
    content: `/** Bucket an ISO timestamp into its calendar day (YYYY-MM-DD). */
export function toDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Count consecutive days with a check-in, ending at \`today\` (YYYY-MM-DD). */
export function computeStreak(completions: string[], today: string): number {
  const days = new Set(completions.map(toDayKey));
  let streak = 0;
  const cursor = new Date(today + 'T00:00:00Z');
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}
`,
    commitMessage: 'feat: streak calculation helpers',
  },
  {
    file: 'src/streaks.test.ts',
    content: `import { computeStreak, toDayKey } from './streaks';

// Demo test file — exercised by the scripted sprint verification step.
export const cases = [
  toDayKey('2026-06-12T08:30:00Z') === '2026-06-12',
  computeStreak(['2026-06-11T21:00:00Z', '2026-06-12T08:30:00Z'], '2026-06-12') === 2,
  computeStreak(['2026-06-10T09:00:00Z'], '2026-06-12') === 0,
  computeStreak([], '2026-06-12') === 0,
];
`,
    commitMessage: 'test: cover streak calculation',
  },
  {
    file: 'docs/streaks.md',
    content: `# Streaks

A habit's streak counts consecutive calendar days with at least one
check-in, ending today. Multiple check-ins on one day count once; a
missed day resets the streak to zero.
`,
    commitMessage: 'docs: streak rules',
  },
];

function resolveBatchId(ctx: DemoScriptContext): string | null {
  const row = ctx.db
    .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
    .get(ctx.runId) as { batchId?: string | null } | undefined;
  return row?.batchId ?? null;
}

export async function sprintScript(ctx: DemoScriptContext): Promise<void> {
  const batchId = resolveBatchId(ctx);
  if (!batchId) {
    ctx.say('No task batch is attached to this sprint — pick tasks in the launch dialog to see the lanes in action.');
    return;
  }

  const lanes = SprintLaneStore.getInstance().listLanes(batchId);
  const work: LaneWork[] = lanes.map((lane, i) => ({
    taskId: lane.taskId,
    title: lane.title ?? `Task ${i + 1}`,
    ...LANE_CHANGES[i % LANE_CHANGES.length],
  }));

  // ── Plan · analyze-dependencies ───────────────────────────────────────────
  ctx.reportStep('analyze-dependencies', 'running');
  ctx.think('Map blocking edges across the batch to derive the fan-out order.');
  await ctx.sleep(1200);
  ctx.tool(
    'cyboflow_list_tasks',
    { batch: batchId },
    work.map((w, i) => `${i + 1}. ${w.title}`).join('\n'),
  );
  await ctx.sleep(1200);
  ctx.say(
    `Analyzed ${work.length} task${work.length === 1 ? '' : 's'} — no blocking edges between them, so they can run as parallel lanes.`,
  );
  await ctx.sleep(900);

  // ── Execute · per-task lanes ──────────────────────────────────────────────
  ctx.reportStep('execute-tasks', 'running');

  for (let i = 0; i < work.length; i++) {
    const lane = work[i];
    ctx.updateLane({ batchId, taskId: lane.taskId, status: 'running', currentStepId: 'implement', attempt: 1 });
    ctx.say(`**Lane ${i + 1} — ${lane.title}**: implementing.`);
    await ctx.sleep(1100);

    // Mid-execution decision gate on the second lane (AskUserQuestion).
    if (i === 1) {
      const answer = await ctx.askQuestion([
        {
          question: `Two ways to verify "${lane.title}" — which do you prefer?`,
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Focused unit test', description: 'Fast, covers the helper in isolation.' },
            { label: 'End-to-end check', description: 'Slower, exercises the full request path.' },
          ],
        },
      ]);
      const choice = answer.answers[`Two ways to verify "${lane.title}" — which do you prefer?`] ?? 'Focused unit test';
      ctx.say(`Going with **${choice}**.`);
      await ctx.sleep(700);
    }

    ctx.writeFile(lane.file, lane.content);
    ctx.tool('Write', { file_path: lane.file }, `Wrote ${lane.file}`);
    await ctx.sleep(1000);

    ctx.updateLane({ batchId, taskId: lane.taskId, currentStepId: 'write-tests' });
    await ctx.sleep(900);

    ctx.updateLane({ batchId, taskId: lane.taskId, currentStepId: 'task-verify' });

    // Permission gate on the first lane — pauses the run until approved.
    if (i === 0) {
      ctx.say('I need to run the test suite to verify this lane — requesting permission.');
      const allowed = await ctx.requestPermission('Bash', {
        command: 'pnpm test',
        description: 'Run the project test suite to verify the implemented task',
      });
      if (allowed) {
        ctx.tool('Bash', { command: 'pnpm test' }, 'Test suite: 12 passed, 0 failed');
        ctx.say('Tests pass.');
      } else {
        ctx.say('Skipping the test run for this lane — verification will rely on the sprint-wide pass.');
      }
      await ctx.sleep(700);
    }

    ctx.commit(lane.commitMessage);
    ctx.updateLane({ batchId, taskId: lane.taskId, status: 'integrated', currentStepId: null });
    ctx.say(`Lane ${i + 1} integrated: \`${lane.commitMessage}\``);
    await ctx.sleep(900);
  }

  // ── Verify · sprint-verify ────────────────────────────────────────────────
  ctx.reportStep('sprint-verify', 'running');
  ctx.tool('Bash', { command: 'pnpm test' }, `Full suite across ${work.length} integrated lanes: 12 passed, 0 failed`);
  await ctx.sleep(1300);
  ctx.say('Sprint verification passed — the combined diff holds up.');
  await ctx.sleep(800);

  // ── Verify · sprint-review (finding + human task) ─────────────────────────
  ctx.reportStep('sprint-review', 'running');
  await ctx.sleep(1100);
  await ctx.createReviewItem({
    kind: 'finding',
    title: 'computeStreak buckets days in UTC, not local time',
    body: 'Check-ins near midnight can land on the wrong calendar day for users far from UTC — consider bucketing by the user\'s local day. Low severity; not blocking the sprint.',
    severity: 'info',
    source: 'agent:demo-code-review',
    blocking: false,
    payload: { kind: 'finding', category: 'correctness', suggestedFix: 'Bucket completions by the user\'s local calendar day.' },
  });
  ctx.say('Code review done — filed one **finding** (non-blocking) in the review queue.');
  await ctx.sleep(900);

  await ctx.createReviewItem({
    kind: 'human_task',
    title: 'Decide the streak badge style',
    body: 'Streaks need a display treatment. Pick one — a flame emoji with the count, or a plain `(N-day streak)` suffix — and resolve this item once decided.',
    source: 'agent:demo-orchestrator',
    blocking: true,
    payload: { kind: 'human_task' },
  });
  ctx.say('Also left you a blocking **human task** — the run will stay paused until BOTH it and the final review are resolved.');
  await ctx.sleep(700);

  // ── Verify · human-review (final gate; aggregate-unblock with the task) ───
  ctx.reportStep('human-review', 'running');
  await ctx.humanGate('human-review', 'Human review');
  ctx.reportStep('human-review', 'done');
  ctx.say(
    'Sprint sealed. All lanes are integrated in this session\'s worktree — **Merge** the session to move the tasks to Done, or open a **PR** to ship the branch.',
  );
}
