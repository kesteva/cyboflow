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
  const ideaTitle = idea?.title ?? 'Add tagging to notes';
  const projectId = resolveProjectId(ctx);
  const router = TaskChangeRouter.getInstance();

  // ── Plan phase · context ──────────────────────────────────────────────────
  ctx.reportStep('context', 'running');
  ctx.think(`Selected idea: "${ideaTitle}". I should scan the codebase to ground the spec before asking the user about scope.`);
  await ctx.sleep(1200);
  ctx.say(`Working on the idea **${ideaTitle}**. Let me get oriented in the codebase first.`);
  await ctx.sleep(1000);
  ctx.tool('Glob', { pattern: 'src/**/*.ts' }, 'src/server.ts\nsrc/notes.ts\nsrc/format.ts');
  await ctx.sleep(1000);
  ctx.tool('Read', { file_path: 'src/notes.ts' }, ctx.readFile('src/notes.ts') || '(empty)');
  await ctx.sleep(1400);

  // AskUserQuestion gate — pauses the run (awaiting_input) until answered.
  const answer = await ctx.askQuestion([
    {
      question: 'How should tags be assigned to notes?',
      header: 'Tagging',
      multiSelect: false,
      options: [
        { label: 'Free-form labels', description: 'Users type any tag; tags are created on first use.' },
        { label: 'Fixed set', description: 'A curated list of tags configured up front.' },
      ],
    },
    {
      question: 'Should filtering by tag land in this iteration?',
      header: 'Scope',
      multiSelect: false,
      options: [
        { label: 'Yes, include filtering', description: 'Tag model + filter endpoint in one pass.' },
        { label: 'Tags only for now', description: 'Filtering becomes a follow-up idea.' },
      ],
    },
  ]);
  const tagStyle = answer.answers['How should tags be assigned to notes?'] ?? 'Free-form labels';
  ctx.say(`Got it — **${tagStyle}** it is. I've captured the idea spec with that decision baked in.`);
  await ctx.sleep(800);

  // ── Plan phase · research (optional step) ─────────────────────────────────
  ctx.reportStep('research', 'running');
  ctx.tool(
    'WebSearch',
    { query: 'lightweight tagging model for note apps' },
    'Common pattern: many-to-many tags table with case-insensitive unique labels.',
  );
  await ctx.sleep(1400);
  ctx.say('Research done — a simple label array on each note is enough at this scale; no join table needed yet.');
  await ctx.sleep(800);

  // ── Plan phase · approve-idea (human gate) ────────────────────────────────
  ctx.reportStep('approve-idea', 'running');
  ctx.say('The idea spec is ready. Please review and approve it in the **Human review** queue to continue.');
  await ctx.humanGate('approve-idea', 'Approve idea spec');
  ctx.say('Idea approved — moving on to decomposition.');
  await ctx.sleep(800);

  // ── Refine phase · epics ──────────────────────────────────────────────────
  ctx.reportStep('epics', 'running');
  const epic = await router.applyChange(projectId, {
    actor: 'agent:demo',
    entityType: 'epic',
    title: 'Note tagging',
    summary: `Tagging across the notes service (${tagStyle.toLowerCase()}).`,
    body: `## Goal\n\nLet users attach tags to notes and surface them in formatted output.\n\n**Approach:** ${tagStyle}.`,
    originatingIdeaId: idea?.id ?? undefined,
    runId: ctx.runId,
  });
  ctx.say('Created the epic **Note tagging** on the board.');
  await ctx.sleep(1200);

  // ── Refine phase · tasks ──────────────────────────────────────────────────
  ctx.reportStep('tasks', 'running');
  const taskSpecs = [
    {
      title: 'Add tags field to the note model',
      body: '## AC\n- `Note` gains a `tags: string[]` field (default empty)\n- `addNote` accepts optional tags\n- Existing call sites compile unchanged',
    },
    {
      title: 'Show tags in formatted output',
      body: '## AC\n- `formatNote` renders `#tag` suffixes when tags exist\n- No trailing whitespace when a note has no tags',
    },
    {
      title: 'Filter notes by tag',
      body: '## AC\n- `listNotes(tag?)` filters case-insensitively\n- GET requests accept a `tag` query parameter',
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
    ctx.say(`Captured task: **${spec.title}**`);
    await ctx.sleep(900);
  }

  // ── Refine phase · approve-plan (human gate) ──────────────────────────────
  ctx.reportStep('approve-plan', 'running');
  ctx.say('The plan is laid out — 1 epic, 3 tasks. Approve the task plan in the **Human review** queue to seal it.');
  await ctx.humanGate('approve-plan', 'Approve task plan');
  ctx.reportStep('approve-plan', 'done');
  ctx.say(
    'Plan approved. The tasks are on the board and ready for a sprint — start one from this session, ' +
      'pick the tagging tasks, and watch the lanes go.',
  );
}
