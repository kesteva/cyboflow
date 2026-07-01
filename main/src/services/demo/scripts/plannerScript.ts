/**
 * Demo planner run — walks the built-in planner definition (context → research
 * → approve-idea → epics → tasks → approve-plan) with scripted output and REAL
 * gates: an AskUserQuestion during context, and blocking decision review items
 * at approve-idea / approve-plan. The refine phase creates a real epic + tasks
 * through TaskChangeRouter, so the board fills in as the run progresses.
 */

import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { DemoScriptContext } from '../demoScriptContext';

interface SeedIdea {
  id: string;
  title: string;
}

function resolveSeedIdea(ctx: DemoScriptContext): SeedIdea | null {
  const run = ctx.db
    .prepare('SELECT seed_idea_id AS seedIdeaId FROM workflow_runs WHERE id = ?')
    .get(ctx.runId) as { seedIdeaId?: string | null } | undefined;
  if (!run?.seedIdeaId) return null;
  const idea = ctx.db
    .prepare('SELECT id, title FROM ideas WHERE id = ?')
    .get(run.seedIdeaId) as SeedIdea | undefined;
  return idea ?? null;
}

function resolveProjectId(ctx: DemoScriptContext): number {
  const row = ctx.db
    .prepare(
      `SELECT w.project_id AS projectId
         FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = ?`,
    )
    .get(ctx.runId) as { projectId: number };
  return row.projectId;
}

export async function plannerScript(ctx: DemoScriptContext): Promise<void> {
  const idea = resolveSeedIdea(ctx);
  const ideaTitle = idea?.title ?? 'Add streaks to habits';
  const projectId = resolveProjectId(ctx);
  const router = TaskChangeRouter.getInstance();

  // ── Plan phase · context ──────────────────────────────────────────────────
  ctx.reportStep('context', 'running');
  ctx.think(`Selected idea: "${ideaTitle}". I should scan the codebase to ground the spec before asking the user about scope.`);
  await ctx.sleep(1200);
  ctx.say(`Working on the idea **${ideaTitle}**. Let me get oriented in the codebase first.`);
  await ctx.sleep(1000);
  ctx.tool('Glob', { pattern: 'src/**/*.ts' }, 'src/server.ts\nsrc/habits.ts\nsrc/format.ts');
  await ctx.sleep(1000);
  ctx.tool('Read', { file_path: 'src/habits.ts' }, ctx.readFile('src/habits.ts') || '(empty)');
  await ctx.sleep(1400);

  // AskUserQuestion gate — pauses the run (awaiting_input) until answered.
  const answer = await ctx.askQuestion([
    {
      question: 'How should a streak be counted?',
      header: 'Streaks',
      multiSelect: false,
      options: [
        { label: 'Calendar days', description: 'A day counts if it has at least one check-in; simple and predictable.' },
        { label: 'Rolling 24h windows', description: 'Each check-in must land within 24h of the previous one.' },
      ],
    },
    {
      question: 'Should a missed-day grace rule land in this iteration?',
      header: 'Scope',
      multiSelect: false,
      options: [
        { label: 'No grace for now', description: 'A missed day resets the streak; grace becomes a follow-up idea.' },
        { label: 'One grace day', description: 'Allow a single missed day before the streak resets.' },
      ],
    },
  ]);
  const streakStyle = answer.answers['How should a streak be counted?'] ?? 'Calendar days';
  const graceChoice = answer.answers['Should a missed-day grace rule land in this iteration?'] ?? 'No grace for now';
  ctx.say(`Got it — **${streakStyle}** it is. I've captured the idea spec with that decision baked in.`);
  await ctx.sleep(800);

  // ── Plan phase · research (optional step) ─────────────────────────────────
  ctx.reportStep('research', 'running');
  ctx.tool(
    'WebSearch',
    { query: 'habit tracker streak calculation edge cases' },
    'Common pitfalls: timezone boundaries and DST shifts; most trackers bucket check-ins by calendar day.',
  );
  await ctx.sleep(1400);
  ctx.say('Research done — bucketing check-ins by calendar day sidesteps the DST traps; no scheduler needed.');
  await ctx.sleep(800);

  // ── Plan phase · approve-idea (inline human gate) ─────────────────────────
  // Production planner gates are agent-driven AskUserQuestion gates: the spec
  // renders inline in chat and the approval is the question card right below
  // it (QuestionRouter pauses the run + folds a blocking decision review item,
  // so the gate also shows in the Human review queue while pending).
  ctx.reportStep('approve-idea', 'running');
  const specBody = [
    '## Idea spec',
    '',
    '### Problem',
    'Users check habits off but get no sense of momentum — nothing rewards consistency.',
    '',
    '### Approach',
    `- **Streak counting:** ${streakStyle} (per the planning decision)`,
    '- `computeStreak(completions, today)` derives the current streak from a habit\'s check-in timestamps',
    '- Formatted output renders the streak so it shows up everywhere habits are listed',
    `- **Missed-day grace:** ${graceChoice === 'One grace day' ? 'one grace day before the streak resets' : 'none — a missed day resets the streak (grace is a follow-up idea)'}`,
    '',
    '### Out of scope',
    '- Reminders / notifications',
    '- Weekly or custom-cadence goals',
  ].join('\n');
  // Also persist the spec onto the seeded idea so the board card matches what
  // is approved here.
  if (idea) {
    await router.applyChange(projectId, {
      actor: 'agent:demo',
      entityType: 'idea',
      taskId: idea.id,
      fields: {
        summary: `Streaks per habit — ${streakStyle.toLowerCase()}, ${graceChoice === 'One grace day' ? 'one grace day' : 'no grace rule'}.`,
        body: specBody,
      },
      runId: ctx.runId,
    });
  }
  ctx.say(`Here is the idea spec — review it right here, then approve below to continue.\n\n---\n\n${specBody}`);
  const ideaApproval = await ctx.askQuestion([
    {
      question: 'Approve the idea spec?',
      header: 'Approval',
      multiSelect: false,
      options: [
        { label: 'Approve', description: 'Lock the spec and move on to decomposition.' },
        { label: 'Request changes', description: 'Have the agent tighten the spec before continuing.' },
      ],
    },
  ]);
  if ((ideaApproval.answers['Approve the idea spec?'] ?? 'Approve').startsWith('Request')) {
    ctx.say('Tightening the spec — pulling the grace rule out into its own follow-up idea and trimming the approach to the calculation + display.');
    await ctx.sleep(1100);
    ctx.say('Spec revised — proceeding to decomposition with the slimmer scope.');
  } else {
    ctx.say('Idea approved — moving on to decomposition.');
  }
  await ctx.sleep(800);

  // ── Refine phase · epics ──────────────────────────────────────────────────
  ctx.reportStep('epics', 'running');
  const epic = await router.applyChange(projectId, {
    actor: 'agent:demo',
    entityType: 'epic',
    title: 'Habit streaks',
    summary: `Streak tracking across the habits service (${streakStyle.toLowerCase()}).`,
    body: `## Goal\n\nDerive each habit's current streak from its check-ins and surface it in formatted output.\n\n**Counting:** ${streakStyle}.`,
    originatingIdeaId: idea?.id ?? undefined,
    runId: ctx.runId,
  });
  // Q1 deferred materialization: a plan-gated run's creates land PENDING
  // (approved_at NULL) — invisible on the board until the plan is approved.
  ctx.say('Drafted the epic **Habit streaks** — it stays hidden until you approve the plan.');
  await ctx.sleep(1200);

  // ── Refine phase · tasks ──────────────────────────────────────────────────
  ctx.reportStep('tasks', 'running');
  const taskSpecs = [
    {
      title: 'Add streak calculation to the habit model',
      body: '## AC\n- `computeStreak(completions, today)` counts consecutive days ending today\n- Empty completions → 0; multiple check-ins on one day count once\n- Existing call sites compile unchanged',
    },
    {
      title: 'Show streaks in formatted output',
      body: '## AC\n- `formatHabit` renders a `(N-day streak)` suffix when the streak is ≥ 2\n- No suffix for habits without an active streak',
    },
    {
      title: 'Track the longest streak per habit',
      body: '## AC\n- `longestStreak(completions)` scans the full check-in history\n- GET responses include the personal best alongside the current streak',
    },
  ];
  for (const spec of taskSpecs) {
    await router.applyChange(projectId, {
      actor: 'agent:demo',
      entityType: 'task',
      title: spec.title,
      body: spec.body,
      parentEpicId: epic.taskId,
      originatingIdeaId: idea?.id ?? undefined,
      runId: ctx.runId,
    });
    ctx.say(`Drafted task: **${spec.title}**`);
    await ctx.sleep(900);
  }

  // ── Refine phase · approve-plan (inline human gate) ───────────────────────
  ctx.reportStep('approve-plan', 'running');
  const planSummary = [
    '## Task plan',
    '',
    '**Epic: Habit streaks**',
    '',
    ...taskSpecs.map((spec, i) => `${i + 1}. **${spec.title}**\n${spec.body.replace('## AC', '   AC:').replace(/\n- /g, '\n   - ')}`),
  ].join('\n');
  ctx.say(`The plan is laid out — review it here, then approve below to seal it.\n\n---\n\n${planSummary}`);
  // 'Approve' on the approve-plan step triggers the real backend reveal:
  // QuestionRouter.promoteTasksOnPlanApproval stamps plan_approved_at, flips the
  // drafts' approved_at (they appear on the board), and promotes the tasks to
  // Ready-for-development. A non-approve answer keeps the drafts PENDING
  // (reject-only deletion — 'Request changes' never destroys them).
  const PLAN_QUESTION = 'Approve the task plan?';
  const planApproval = await ctx.askQuestion([
    {
      question: PLAN_QUESTION,
      header: 'Approval',
      multiSelect: false,
      options: [
        { label: 'Approve', description: 'Seal the plan — the epic + tasks appear on the board, Ready for development.' },
        { label: 'Request changes', description: 'Have the agent rework the decomposition first.' },
      ],
    },
  ]);
  let approved = !(planApproval.answers[PLAN_QUESTION] ?? 'Approve').startsWith('Request');
  if (!approved) {
    // The drafts survive a non-approve answer (reject-only deletion); rework and
    // re-present once — only a real Approve reveals them on the board.
    ctx.say('Noted — reworked the decomposition with your feedback folded in. Here is the revised plan; approve to put it on the board.');
    await ctx.sleep(900);
    const revised = await ctx.askQuestion([
      {
        question: PLAN_QUESTION,
        header: 'Approval',
        multiSelect: false,
        options: [
          { label: 'Approve', description: 'Seal the revised plan — the epic + tasks appear on the board.' },
          { label: 'Reject', description: 'Discard the plan — the draft epic + tasks are deleted and the run ends.' },
        ],
      },
    ]);
    // Reject is the ONLY option that tears the drafts down (exact reject-option
    // match in QuestionRouter.deletePendingDraftsOnPlanDecline). Selecting it here
    // hard-deletes the run's PENDING epic + tasks via the REAL backend.
    approved = !(revised.answers[PLAN_QUESTION] ?? 'Approve').startsWith('Reject');
  }
  ctx.reportStep('approve-plan', 'done');
  if (approved) {
    ctx.say(
      'Plan approved. The epic and its tasks just appeared on the board, Ready for development — start a sprint ' +
        'from this session, pick the streak tasks, and watch the lanes go.',
    );
  } else {
    ctx.say('Plan rejected — the draft epic and tasks were discarded. Re-run the planner to decompose the idea again.');
  }
}
