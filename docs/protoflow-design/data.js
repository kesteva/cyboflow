// Shared workflow data for Protoflow — derived from kesteva/soloflow.
// 5 named workflows: full · planner · sprint · compound · prune.
// Each defines its own phases. window.PHASES is a live alias to the
// currently-selected workflow so existing components (FlowReadOnly,
// Direction A editor, the right-rail feed) work unchanged.

// ─── Agent catalogue ─────────────────────────────────────────
window.AGENTS = [
  { id: 'idea-extractor',   name: 'idea-extractor',   model: 'sonnet-4.5', role: 'extract',  desc: 'Parses raw input, scans the codebase for context, writes a structured IDEA-NNN spec.', tokens: '12k avg' },
  { id: 'researcher',       name: 'researcher',       model: 'sonnet-4.5', role: 'extract',  desc: 'Optional web/codebase research before the idea spec is finalized. Gated by the user.',  tokens: '9k avg' },
  { id: 'task-refiner',     name: 'task-refiner',     model: 'opus-4.5',   role: 'plan',     desc: 'Refines an approved idea into execution-ready TASK-NNN plans with acceptance criteria.', tokens: '38k avg' },
  { id: 'executor',         name: 'executor',         model: 'sonnet-4.5', role: 'execute',  desc: 'Implements one task at a time. Reads CODE-PATTERNS.md before editing.',                tokens: '64k avg' },
  { id: 'verifier',         name: 'verifier',         model: 'opus-4.5',   role: 'verify',   desc: 'Checks the executor’s diff against acceptance criteria. Loops up to 3× per task.',     tokens: '22k avg' },
  { id: 'visual-verifier',  name: 'visual-verifier',  model: 'sonnet-4.5', role: 'verify',   desc: 'Maestro / Playwright run + screenshot diff. Optional, off by default.',               tokens: '8k avg' },
  { id: 'test-writer',      name: 'test-writer',      model: 'sonnet-4.5', role: 'execute',  desc: 'Writes unit / integration tests for the executor’s diff before verification.',         tokens: '16k avg' },
  { id: 'code-reviewer',    name: 'code-reviewer',    model: 'opus-4.5',   role: 'review',   desc: 'Sprint-level review for taste, naming, layering, CLAUDE.md compliance.',              tokens: '18k avg' },
  { id: 'compounder',       name: 'compounder',       model: 'sonnet-4.5', role: 'learn',    desc: 'Extracts reusable patterns from a completed sprint into solution files.',              tokens: '14k avg' },
  { id: 'pruner',           name: 'pruner',           model: 'sonnet-4.5', role: 'learn',    desc: 'Sweeps stale ideas, archived sprints, and orphaned tasks out of .soloflow/ state.',     tokens: '7k avg' },
  { id: 'human',            name: 'human',            model: 'you',        role: 'review',   desc: 'A human teammate steps in to review, edit, or approve. Run pauses until you respond.', tokens: '—' },
];

// ─── MCP / tool catalogue ────────────────────────────────────
window.MCPS = [
  { id: 'filesystem',  label: 'Filesystem', desc: 'Read/write project files' },
  { id: 'bash',        label: 'Bash',       desc: 'Run shell commands' },
  { id: 'git',         label: 'Git',        desc: 'Git operations' },
  { id: 'web-search',  label: 'Web search', desc: 'Internet research' },
  { id: 'context7',    label: 'context7',   desc: 'Library docs' },
  { id: 'linear',      label: 'Linear',     desc: 'Issue tracking' },
  { id: 'maestro',     label: 'Maestro',    desc: 'Mobile UI flows' },
  { id: 'playwright',  label: 'Playwright', desc: 'Browser automation' },
];

window.MODELS = [
  { id: 'opus-4.5',     label: 'Opus 4.5',     subtitle: 'Reasoning · slow · $$$' },
  { id: 'sonnet-4.5',   label: 'Sonnet 4.5',   subtitle: 'Balanced · default' },
  { id: 'haiku-4.5',    label: 'Haiku 4.5',    subtitle: 'Fast · cheap' },
  { id: 'custom',       label: 'Custom agent', subtitle: 'Bring your own' },
];

// ─── Phase palette ───────────────────────────────────────────
const PHASE_COLORS = {
  plan:      { color: '#3b6dd6', accent: 'oklch(0.65 0.14 255)' },
  refine:    { color: '#5a4ad6', accent: 'oklch(0.6 0.15 275)' },
  execute:   { color: '#c96442', accent: 'oklch(0.62 0.14 35)' },
  verify:    { color: '#2d8a5b', accent: 'oklch(0.6 0.13 155)' },
  review:    { color: '#a87a2c', accent: 'oklch(0.65 0.12 80)' },
  compound:  { color: '#8b5cf6', accent: 'oklch(0.62 0.18 295)' },
  prune:     { color: '#8a4a4a', accent: 'oklch(0.55 0.1 25)' },
};
const ph = (id, label, key, steps) => ({ id, label, ...PHASE_COLORS[key], steps });

// ─── Workflow definitions ────────────────────────────────────
// Each `WORKFLOW_DEFS[id]` is an array of phases (same shape FlowReadOnly
// + Direction A consume). The full pipeline is the union; the others are
// the four standalone slash-commands the soloflow plugin exposes.

window.WORKFLOW_DEFS = {

  // /soloflow — full lifecycle (idea → planner → sprint → compound)
  soloflow: [
    ph('plan', 'Plan', 'plan', [
      { id: 'context',   name: 'Get context on user idea', agent: 'idea-extractor', mcps: ['filesystem', 'web-search'], retries: 0, human: true,
        desc: 'Parse the raw user input, scan the codebase, write IDEA-NNN.md.' },
      { id: 'research',  name: 'Research',                 agent: 'researcher',     mcps: ['web-search', 'context7'],   retries: 1, optional: true,
        desc: 'Optional. Pulls in docs, prior art, and library references.' },
      { id: 'approve-idea', name: 'Approve idea spec',     agent: 'human',          mcps: [],                            retries: 0, human: true,
        desc: 'You read the IDEA-NNN.md and approve, edit, or reject.' },
    ]),
    ph('refine', 'Refine', 'refine', [
      { id: 'epics',     name: 'Create epics',             agent: 'task-refiner',   mcps: ['filesystem', 'linear'],      retries: 0,
        desc: 'Group the idea into epics with file ownership and dependency edges.' },
      { id: 'tasks',     name: 'Fill out task details',    agent: 'task-refiner',   mcps: ['filesystem'],                retries: 0,
        desc: 'Write each TASK-NNN.md with acceptance criteria and test plan.' },
      { id: 'approve-plan', name: 'Approve task plan',     agent: 'human',          mcps: [],                            retries: 0, human: true,
        desc: 'You confirm scope, ordering, and acceptance criteria before sprint.' },
    ]),
    ph('execute', 'Execute', 'execute', [
      { id: 'implement',     name: 'Implement task',       agent: 'executor',       mcps: ['filesystem', 'bash', 'git'], retries: 3,
        desc: 'Reads CODE-PATTERNS.md, writes the diff, runs local checks.' },
      { id: 'write-tests',   name: 'Write tests',          agent: 'test-writer',    mcps: ['filesystem', 'bash'],        retries: 1,
        desc: 'Adds unit / integration tests covering the new diff before verification.' },
      { id: 'code-review',   name: 'Code review',          agent: 'code-reviewer',  mcps: ['filesystem', 'git'],         retries: 0,
        desc: 'Inline review of the diff — naming, layering, pattern compliance.' },
      { id: 'task-verify',   name: 'Task verification',    agent: 'verifier',       mcps: ['filesystem', 'bash'],        retries: 3, loopback: 'implement',
        desc: 'Checks acceptance criteria. Bounces back up to 3× before escalating.' },
      { id: 'visual-verify', name: 'Visual verification',  agent: 'visual-verifier',mcps: ['maestro', 'playwright'],     retries: 1, optional: true,
        desc: 'Maestro / Playwright snapshot diff. Off unless enabled in config.' },
    ]),
    ph('verify', 'Sprint review', 'review', [
      { id: 'sprint-verify', name: 'Sprint verification',  agent: 'verifier',       mcps: ['filesystem', 'bash', 'playwright'], retries: 1,
        desc: 'Runs the full suite once after every task is archived.' },
      { id: 'sprint-review', name: 'Code review',          agent: 'code-reviewer',  mcps: ['filesystem', 'git'],         retries: 0,
        desc: 'Taste pass — naming, layering, CLAUDE.md drift.' },
      { id: 'human-review',  name: 'Human review',         agent: 'human',          mcps: [],                            retries: 0, human: true,
        desc: 'You do the taste-level review. All functional checks already passed.' },
    ]),
    ph('compound', 'Compound', 'compound', [
      { id: 'extract',           name: 'Extract learnings',           agent: 'compounder', mcps: ['filesystem'], retries: 0,
        desc: 'Reads sprint diffs + verifier reports, drafts solution files.',
        outputs: ['Immediate fixes', 'Backlog tasks', 'CLAUDE.md improvements', 'Workflow improvements'] },
      { id: 'approve-learnings', name: 'Review and approve learnings',agent: 'human',     mcps: [],             retries: 0, human: true,
        desc: 'You decide which learnings get merged into shared docs.' },
    ]),
  ],

  // /soloflow:planner — idea → tasks only (no execute, no compound)
  planner: [
    ph('plan', 'Plan', 'plan', [
      { id: 'context',      name: 'Get context on user idea', agent: 'idea-extractor', mcps: ['filesystem', 'web-search'], retries: 0, human: true,
        desc: 'Parse the user’s prompt, scan the codebase, write IDEA-NNN.md.' },
      { id: 'research',     name: 'Research',                 agent: 'researcher',     mcps: ['web-search', 'context7'],   retries: 1, optional: true,
        desc: 'Optional research pass before the idea is locked.' },
      { id: 'approve-idea', name: 'Approve idea spec',        agent: 'human',          mcps: [],                            retries: 0, human: true,
        desc: 'You approve, edit, or reject the idea spec.' },
    ]),
    ph('refine', 'Refine', 'refine', [
      { id: 'epics',        name: 'Create epics',             agent: 'task-refiner',   mcps: ['filesystem', 'linear'],      retries: 0,
        desc: 'Decompose the idea into epics with dependency edges.' },
      { id: 'tasks',        name: 'Fill out task details',    agent: 'task-refiner',   mcps: ['filesystem'],                retries: 0,
        desc: 'Write each TASK-NNN.md with acceptance criteria.' },
      { id: 'approve-plan', name: 'Approve task plan',        agent: 'human',          mcps: [],                            retries: 0, human: true,
        desc: 'You sign off on scope before tasks queue for sprint.' },
    ]),
  ],

  // /soloflow:sprint — execute the queued tasks
  sprint: [
    ph('execute', 'Execute', 'execute', [
      { id: 'implement',     name: 'Implement task',      agent: 'executor',       mcps: ['filesystem', 'bash', 'git'], retries: 3,
        desc: 'Implements one task. Reads CODE-PATTERNS.md, writes diff, runs checks.' },
      { id: 'write-tests',   name: 'Write tests',         agent: 'test-writer',    mcps: ['filesystem', 'bash'],        retries: 1,
        desc: 'Adds unit / integration tests for the diff before verification.' },
      { id: 'code-review',   name: 'Code review',         agent: 'code-reviewer',  mcps: ['filesystem', 'git'],         retries: 0,
        desc: 'Inline review of the diff — naming, layering, pattern compliance.' },
      { id: 'task-verify',   name: 'Task verification',   agent: 'verifier',       mcps: ['filesystem', 'bash'],        retries: 3, loopback: 'implement',
        desc: 'Checks acceptance criteria. Loops back to executor up to 3×.' },
      { id: 'visual-verify', name: 'Visual verification', agent: 'visual-verifier',mcps: ['maestro', 'playwright'],     retries: 1, optional: true,
        desc: 'Snapshot diff via Maestro or Playwright.' },
    ]),
    ph('verify', 'Sprint review', 'review', [
      { id: 'sprint-verify', name: 'Sprint verification', agent: 'verifier',       mcps: ['filesystem', 'bash', 'playwright'], retries: 1,
        desc: 'Runs the full suite after the last task is archived.' },
      { id: 'sprint-review', name: 'Code review',         agent: 'code-reviewer',  mcps: ['filesystem', 'git'],         retries: 0,
        desc: 'Taste pass over the whole sprint diff.' },
      { id: 'human-review',  name: 'Human review',        agent: 'human',          mcps: [],                            retries: 0, human: true,
        desc: 'Final taste check before the sprint is sealed.' },
    ]),
  ],

  // /soloflow:compound — pull learnings out of the most recent sprint
  compound: [
    ph('compound', 'Compound', 'compound', [
      { id: 'load-sprint',       name: 'Load sprint artifacts',       agent: 'compounder', mcps: ['filesystem'], retries: 0,
        desc: 'Reads the sprint diff, verifier reports, and stuck-task notes.' },
      { id: 'extract',           name: 'Extract learnings',           agent: 'compounder', mcps: ['filesystem'], retries: 0,
        desc: 'Drafts solution files for future sessions.',
        outputs: ['Immediate fixes', 'Backlog tasks', 'CLAUDE.md improvements', 'Workflow improvements'] },
      { id: 'approve-learnings', name: 'Review and approve learnings',agent: 'human',     mcps: [],             retries: 0, human: true,
        desc: 'You decide which learnings get merged into shared docs.' },
      { id: 'write-back',        name: 'Write to solution files',     agent: 'compounder', mcps: ['filesystem'], retries: 0,
        desc: 'Persists approved learnings into CLAUDE.md / CODE-PATTERNS.md / backlog.' },
    ]),
  ],

  // /soloflow:prune — sweep stale ideas, archived sprints, orphan tasks
  prune: [
    ph('prune', 'Prune', 'prune', [
      { id: 'scan',           name: 'Scan .soloflow state',     agent: 'pruner', mcps: ['filesystem'], retries: 0,
        desc: 'Walks .soloflow/ for archived sprints, stale ideas, orphan tasks.' },
      { id: 'propose',        name: 'Propose deletions',        agent: 'pruner', mcps: ['filesystem'], retries: 0,
        desc: 'Drafts a deletion plan with reasons. Nothing is removed yet.' },
      { id: 'approve-prune',  name: 'Approve deletions',        agent: 'human',  mcps: [],             retries: 0, human: true,
        desc: 'You confirm what gets deleted. Default is keep everything.' },
      { id: 'execute-prune',  name: 'Execute deletions',        agent: 'pruner', mcps: ['filesystem', 'git'], retries: 0,
        desc: 'Removes approved entries and commits the cleanup.' },
    ]),
  ],
};

// Counts for the picker (kept in sync with WORKFLOW_DEFS so picker meta
// can never drift).
const stepCount = (id) => window.WORKFLOW_DEFS[id].reduce((n, p) => n + p.steps.length, 0);
const phaseCount = (id) => window.WORKFLOW_DEFS[id].length;

window.WORKFLOWS = [
  { id: 'soloflow', name: 'soloflow',  subtitle: 'Plan → Refine → Execute → Sprint review → Compound', steps: stepCount('soloflow'), phases: phaseCount('soloflow'), lastUsed: '2h ago',  isDefault: true,  command: '/soloflow' },
  { id: 'planner',  name: 'planner',   subtitle: 'Idea extraction → task refinement (no execute)',     steps: stepCount('planner'),  phases: phaseCount('planner'),  lastUsed: '6h ago',                       command: '/soloflow:planner' },
  { id: 'sprint',   name: 'sprint',    subtitle: 'Executor ↔ verifier loop → sprint review',           steps: stepCount('sprint'),   phases: phaseCount('sprint'),   lastUsed: '1d ago',                       command: '/soloflow:sprint' },
  { id: 'compound', name: 'compound',  subtitle: 'Extract reusable learnings from a sprint',           steps: stepCount('compound'), phases: phaseCount('compound'), lastUsed: '3d ago',                       command: '/soloflow:compound' },
  { id: 'prune',    name: 'prune',     subtitle: 'Sweep stale ideas, archived sprints, orphan tasks',  steps: stepCount('prune'),    phases: phaseCount('prune'),    lastUsed: '12d ago',                      command: '/soloflow:prune' },
];

// ─── Selection ───────────────────────────────────────────────
// window.PHASES is a live alias to the currently-selected workflow.
// FlowReadOnly + Direction A both read this so swapping it re-renders.
window.SELECTED_WORKFLOW = 'soloflow';
window.PHASES = window.WORKFLOW_DEFS.soloflow;
window.selectWorkflow = (id) => {
  if (!window.WORKFLOW_DEFS[id]) return;
  window.SELECTED_WORKFLOW = id;
  window.PHASES = window.WORKFLOW_DEFS[id];
};
