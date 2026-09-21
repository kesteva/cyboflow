import { describe, it, expect } from 'vitest';
import { composeStepPrompt } from '../stepPrompt';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}

describe('composeStepPrompt', () => {
  it('scopes the prompt to one step and names its subagent', () => {
    const out = composeStepPrompt({ step: step({ id: 'epics', name: 'Create epics', agent: 'epics' }), workflowName: 'planner', attempt: 1 });
    expect(out).toContain('one step');
    expect(out).toContain('`epics`');
    expect(out).toContain('Create epics');
    expect(out).toContain('cyboflow-epics');
    expect(out).toContain('"planner" workflow');
    // Tells the agent NOT to advance — the host sequences.
    expect(out).toContain('Do NOT start any other step');
  });

  it('includes the step description when present', () => {
    const out = composeStepPrompt({ step: step({ id: 'a', desc: 'Capture the idea.' }), workflowName: 'planner', attempt: 1 });
    expect(out).toContain('Capture the idea.');
  });

  it('adds a retry note only on attempts after the first', () => {
    expect(composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'w', attempt: 1 })).not.toContain('attempt');
    const retry = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'w', attempt: 3 });
    expect(retry).toContain('attempt 3');
  });

  it('renders the fan-out item block when item context is present', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      item: { id: 'TASK-42', over: 'tasks' },
    });
    expect(out).toContain('PARALLEL fan-out');
    expect(out).toContain('**tasks**');
    expect(out).toContain('**TASK-42**');
    expect(out).toContain('do not touch other items');
  });

  it('omits the fan-out and sprint-task blocks when no item / scope is supplied', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a', name: 'Step A', agent: 'executor', desc: 'Do the thing.' }),
      workflowName: 'planner',
      attempt: 1,
    });
    // No item ⇒ no fan-out block; no scope ⇒ no sprint-tasks block leaks in.
    expect(out).not.toContain('PARALLEL fan-out');
    expect(out).not.toContain('# Sprint tasks');
    // The single-step skeleton is still intact.
    expect(out).toContain('Step: **Step A** (id: `a`)');
    expect(out).toContain('Do the thing.');
    expect(out).toContain('cyboflow-executor');
  });

  // -------------------------------------------------------------------------
  // Hardening — pin the subagent + faithful persistence + DB-canonical scope.
  // These guard against the programmatic step agent improvising (general-purpose
  // fallback, disk-state probing, collapsing real edges to "none"). 2026-06-22.
  // -------------------------------------------------------------------------

  it('pins Claude delegation to the installed role and forbids the general-purpose fallback', () => {
    const out = composeStepPrompt({
      step: step({ id: 'analyze-dependencies', name: 'Analyze deps', agent: 'dependency-analyzer' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).toContain('cyboflow-dependency-analyzer');
    expect(out).toContain('On the Claude runtime, use the Task tool with that EXACT `subagent_type`');
    expect(out).toContain('do NOT fall back to `general-purpose`');
  });

  it('requires faithfully persisting every returned item (no collapsing edges to "none")', () => {
    const out = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'sprint', attempt: 1 });
    expect(out).toContain('recording EVERY item the subagent returns');
    expect(out).toContain('cyboflow_add_task_dependency');
    expect(out).toContain('never collapse a non-empty result to "none"');
  });

  it('requires an atomic commit only for repository file changes, never DB-only or analysis work', () => {
    const out = composeStepPrompt({ step: step({ id: 'context', agent: 'context' }), workflowName: 'ship', attempt: 1 });
    expect(out).toContain('If this step changes repository files, make ONE git commit');
    expect(out).toContain('For DB-only, analysis, review, or artifact-reporting work, do not make a git commit');
    expect(out).toContain('Never create an empty commit');
  });

  it('declares the database canonical and forbids deciding scope/status from disk state', () => {
    const out = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'sprint', attempt: 1 });
    expect(out).toContain('single source of truth');
    expect(out).toContain('never read on-disk or worktree state files');
  });

  // -------------------------------------------------------------------------
  // Visual-verification threading (verification-agent redesign §5.3): the
  // task-verify contract re-run + the visual-FAIL implement re-delegate sections.
  // -------------------------------------------------------------------------

  it('renders the visual-verification output-contract section when contractError is present', () => {
    const out = composeStepPrompt({
      step: step({ id: 'task-verify', agent: 'task-verify' }),
      workflowName: 'sprint',
      attempt: 2,
      contractError: 'duplicate "## Visual verification task" heading (more than one section present)',
    });
    expect(out).toContain('## Visual-verification output contract (fix required)');
    // Quotes the exact defect and demands a compliant re-emit.
    expect(out).toContain('duplicate "## Visual verification task" heading');
    expect(out).toContain('EXACTLY ONE of');
    expect(out).toContain('VISUAL-VERIFICATION: NOT-APPLICABLE');
  });

  it('renders the task-verify relay contract for task-verify steps (live-smoke fix 2026-07-22)', () => {
    // The generic wrapper prose ("one-line summary" + "persist every ACTION via
    // cyboflow_* tools") made the step turn summarize the fence away AND fire
    // cyboflow_request_verification itself on the first live run. The relay
    // note overrides both for task-verify steps.
    const out = composeStepPrompt({
      step: step({ id: 'task-verify', agent: 'task-verify' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).toContain('## Final message contract (task-verify)');
    expect(out).toContain('overrides steps 1 and 3');
    expect(out).toContain('RELAY, do not summarize');
    expect(out).toContain('copied byte-for-byte');
    expect(out).toContain('do NOT call `cyboflow_request_verification`');
    expect(out).toContain('do NOT set the lane to `awaiting-verify`');
  });

  it('keys the relay contract on the agent too, and omits it for every other step', () => {
    const byAgent = composeStepPrompt({
      step: step({ id: 'verify-task-custom', agent: 'task-verify' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(byAgent).toContain('## Final message contract (task-verify)');
    const other = composeStepPrompt({
      step: step({ id: 'implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(other).not.toContain('Final message contract (task-verify)');
  });

  it('renders the address-review findings contract, keyed on id or agent', () => {
    // Nothing in the generic wrapper tells a step agent that this step's INPUT is
    // the run's own review queue, nor that the three verdicts map to different
    // dispositions — so the contract has to say it.
    const byId = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(byId).toContain('## Findings contract (address-review)');
    expect(byId).toContain('cyboflow_list_run_findings');
    expect(byId).toContain("resolution_kind: 'fixed'");
    expect(byId).toContain("resolution_kind: 'triaged'");
    // The load-bearing asymmetry: a DEFERRED finding must survive this step.
    expect(byId).toContain('**DEFERRED** → do NOTHING');

    const byAgent = composeStepPrompt({
      step: step({ id: 'act-on-review', agent: 'address-review' }),
      workflowName: 'ship',
      attempt: 1,
    });
    expect(byAgent).toContain('## Findings contract (address-review)');
  });

  it('renders the runbook-bootstrap denylist on address-review, when the run bootstrapped', () => {
    // address-review is the ONE step in the chain that "fixes in place", and both
    // of these files are booby-trapped for a well-meant fix: the runbook's proof
    // is content-addressed against the committed bytes (so any edit demotes it
    // and the next verification silently skips), and reverting the config change
    // un-proves the environment while the runbook goes on claiming otherwise.
    const out = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
      bootstrapProtectedPaths: ['.cyboflow/verify-runbook.json', 'package.json'],
    });
    expect(out).toContain('.cyboflow/verify-runbook.json');
    expect(out).toContain('package.json');
    expect(out).toContain('content-addressed');
    // The subagent cannot see this prompt, so the step agent has to forward it.
    expect(out).toContain('Relay this list');
  });

  it('renders NOTHING about the bootstrap on a run that did not bootstrap', () => {
    // Which is nearly every run. The common prompt must stay byte-identical to
    // what it was, or every existing prompt assertion becomes noise.
    const withEmpty = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
      bootstrapProtectedPaths: [],
    });
    const without = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(withEmpty).toBe(without);
    expect(without).not.toContain('verification bootstrap wrote');
  });

  it('does not render the denylist on a step that is not address-review', () => {
    // The paths are only hazardous to a step that edits files it was not asked
    // to edit; telling implement about them would be noise in every lane.
    const out = composeStepPrompt({
      step: step({ id: 'implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      bootstrapProtectedPaths: ['.cyboflow/verify-runbook.json'],
    });
    expect(out).not.toContain('verification bootstrap wrote');
  });

  it('requires a full-suite re-run when address-review changed files (programmatic parity)', () => {
    // The controller walks the definition in order: sprint-verify runs BEFORE
    // address-review, so any fix this step applies is unverified by the time the
    // human merge gate opens. The orchestrated prose re-runs sprint-verify; the
    // programmatic plane has no such step, so the contract must demand it here
    // or the two planes diverge on a shipping-correctness property.
    const out = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).toContain("re-run the project's FULL test suite");
    expect(out).toContain('must not open over a tree whose suite has not passed');
    // …and must not burn a full suite run when nothing changed.
    expect(out).toContain('changed NO files, skip straight to step 4');
  });

  it('orders resolution AFTER verify+commit, and keeps a reverted fix open', () => {
    // Resolving is irreversible (no un-resolve tool). Resolving a FIXED finding
    // before the suite re-run means the repair pass can revert that very fix and
    // leave a live defect behind a closed record — so the contract must put
    // resolution last AND handle the reverted case explicitly.
    const out = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    const verifyAt = out.indexOf("Settle the code BEFORE you resolve anything");
    const resolveAt = out.indexOf('cyboflow_resolve_finding');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(verifyAt);
    expect(out).toContain('reverted or dropped in step 3');
    expect(out).toContain('IRREVERSIBLE');
  });

  it('escalates a persistently red tree as a BLOCKING finding, not just prose', () => {
    // The controller does not parse this step's output (there is no VERDICT:
    // relay channel like task-verify's), so "say so in your summary" guarantees
    // nothing. A blocking review item is the only thing that actually parks the
    // run before the human's merge gate.
    const out = composeStepPrompt({
      step: step({ id: 'address-review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).toContain('file a BLOCKING finding');
    expect(out).toContain('address-review-regression');
    expect(out).toContain('your summary prose is not machine-read');
  });

  it('omits the address-review contract for every other step', () => {
    const other = composeStepPrompt({
      step: step({ id: 'sprint-review', agent: 'sprint-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(other).not.toContain('Findings contract (address-review)');
    expect(other).not.toContain('cyboflow_list_run_findings');
  });

  it('contract re-run prose forbids firing the request in place of printing the contract', () => {
    const out = composeStepPrompt({
      step: step({ id: 'task-verify', agent: 'task-verify' }),
      workflowName: 'sprint',
      attempt: 2,
      contractError: 'missing section',
    });
    expect(out).toContain('do NOT call `cyboflow_request_verification` or park the lane yourself');
    expect(out).toContain('If a previous attempt already fired a request, still print the contract');
  });

  it('renders the previous step output as the consuming step\'s input', () => {
    const out = composeStepPrompt({
      step: step({ id: 'extract', agent: 'compounder', consumesPriorStepOutput: true }),
      workflowName: 'compound',
      attempt: 1,
      priorStepOutput: { stepId: 'load-sprint', name: 'Load merged work', text: '## Merged work\n\nTwo runs shipped the guard.' },
    });
    expect(out).toContain('## Previous step output');
    expect(out).toContain('**Load merged work**');
    expect(out).toContain('Two runs shipped the guard.');
    // Named as INPUT, not background: a fresh turn has no other view of it.
    expect(out).toContain('It is your INPUT');
  });

  it('says the channel failed rather than going silent when the prior text is missing', () => {
    // Silence would read as "the previous step found nothing", which is a
    // different and wrong conclusion — the substrate simply could not capture
    // the turn's final text.
    const out = composeStepPrompt({
      step: step({ id: 'extract', consumesPriorStepOutput: true }),
      workflowName: 'compound',
      attempt: 1,
      priorStepOutput: { stepId: 'load-sprint', name: 'Load merged work' },
    });
    expect(out).toContain('## Previous step output');
    expect(out).toContain('could not be captured on this substrate');
    expect(out).toContain('re-derive');
  });

  it('renders no previous-step section when the step does not consume one', () => {
    const out = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'w', attempt: 1 });
    expect(out).not.toContain('## Previous step output');
  });

  it('renders the visual-verification-failed section when loopbackFeedback is present', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 2,
      loopbackFeedback: 'Failed behaviors:\n- Behavior b1: the submit button never appeared',
    });
    expect(out).toContain('## Visual verification failed (previous attempt)');
    expect(out).toContain('the submit button never appeared');
  });

  it('omits both visual-verification sections (byte-identical) when neither field is set', () => {
    const base = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'sprint', attempt: 1 });
    const withEmpty = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
      contractError: '   ',
      loopbackFeedback: '',
    });
    expect(base).not.toContain('output contract (fix required)');
    expect(base).not.toContain('Visual verification failed (previous attempt)');
    // Empty/whitespace values render nothing — byte-identical to the base prompt.
    expect(withEmpty).toBe(base);
  });

  // -------------------------------------------------------------------------
  // Grounding — the `taskScope` block (the linchpin fix for the dependency
  // analyzer concluding "No dependencies" because it never saw the tasks).
  // -------------------------------------------------------------------------

  it('injects the sprint task scope as a `# Sprint tasks` block when provided', () => {
    const out = composeStepPrompt({
      step: step({ id: 'analyze-dependencies', name: 'Analyze deps', agent: 'dependency-analyzer' }),
      workflowName: 'sprint',
      attempt: 1,
      taskScope: '## TASK-001: Init Vite\n\nScaffold the app.\n\n## TASK-002: Add Tailwind\n\nDepends on the scaffold.',
    });
    expect(out).toContain('# Sprint tasks');
    expect(out).toContain('## TASK-001: Init Vite');
    expect(out).toContain('## TASK-002: Add Tailwind');
    expect(out).toContain('EXACT tasks in scope');
    expect(out).toContain('do NOT hunt for task files');
  });

  it('omits the task block when taskScope is empty / whitespace', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
      taskScope: '   ',
    });
    expect(out).not.toContain('# Sprint tasks');
  });

  // -------------------------------------------------------------------------
  // Artifact follow-up — the programmatic plane has no top-level agent to read
  // planner.md's "after your subagent returns, report/fold this" prose, so
  // composeStepPrompt must inline the same instruction per outputArtifact atype
  // or the artifact silently never gets minted. 2026-07-06.
  // -------------------------------------------------------------------------

  it('instructs a ui-prototype step to write the static file and call cyboflow_report_artifact with a fileName pointer', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'ui-prototype',
        name: 'UI prototype',
        agent: 'ui-prototype',
        outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_report_artifact');
    expect(out).toContain("atype: 'ui-prototype'");
    expect(out).toContain('"UI prototype"');
    expect(out).toContain('{"fileName": "prototype/index.html"}');
    expect(out).not.toContain('{"url":');
  });

  it('instructs an architecture step to fold the section into the idea body via cyboflow_update_task, not report_artifact', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'architecture',
        name: 'Architecture design',
        agent: 'architecture',
        outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_update_task');
    expect(out).toContain('## Architecture design');
    expect(out).toContain('REPLACE that section');
    expect(out).not.toContain('report_artifact');
  });

  it('instructs a compound extract step to compose the Act on / Discarded doc and call cyboflow_report_artifact', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'extract',
        name: 'Extract learnings',
        agent: 'compounder',
        outputArtifact: { atype: 'compound-recommendations', label: 'Recommendations' },
      }),
      workflowName: 'compound',
      attempt: 1,
    });
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_report_artifact');
    expect(out).toContain("atype: 'compound-recommendations'");
    expect(out).toContain('"Recommendations"');
    expect(out).toContain('{"markdown": "<the doc>"}');
    // The doc is the single review: an Act on section AND a Discarded section.
    expect(out).toContain('## Act on');
    expect(out).toContain('## Discarded');
    // And it must forbid re-emitting the learnings as findings AND filing a drop
    // as a decision (the sequential-gate spam this rework kills).
    expect(out).toContain("kind:'finding'");
    expect(out).toContain('DISCARDED candidate');
  });

  it('adds the compound review-queue discipline guard to EVERY compound step (incl. one with no outputArtifact)', () => {
    // load-sprint has no outputArtifact, so the artifact addendum never reaches
    // it — yet it is where the per-drop `decision` spam was observed. The guard
    // must attach on workflow name alone.
    const loadSprint = composeStepPrompt({
      step: step({ id: 'load-sprint', name: 'Load merged work', agent: 'compounder' }),
      workflowName: 'compound',
      attempt: 1,
    });
    expect(loadSprint).toContain('## Compound review-queue discipline');
    expect(loadSprint).toContain('NEVER file a discarded candidate');
    // New model: BOTH gates are workflow steps; the terminal one is human-review,
    // and the flow emits NO decision review items (no batched write-back decision).
    expect(loadSprint).toContain('human-review');
    expect(loadSprint).toContain('emits NO `decision` review items anywhere');
    expect(loadSprint).not.toContain('## Artifact to report'); // no outputArtifact

    // A non-compound step never gets the guard.
    const plannerStep = composeStepPrompt({
      step: step({ id: 'context', name: 'Context', agent: 'context' }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(plannerStep).not.toContain('## Compound review-queue discipline');
  });

  it('adds no artifact addendum for an outputArtifact atype that mints without a follow-up (idea-spec)', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'context',
        name: 'Get context on user idea',
        agent: 'context',
        outputArtifact: { atype: 'idea-spec', label: 'Idea spec' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).not.toContain('## Artifact to report');
  });

  it('adds no artifact addendum when the step has no outputArtifact at all', () => {
    const out = composeStepPrompt({
      step: step({ id: 'approve-idea', name: 'Approve idea spec', agent: 'human' }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).not.toContain('## Artifact to report');
  });

  it('gates a UI prototype on the persisted UI_PROTOTYPE flag before delegating', () => {
    const out = composeStepPrompt({
      step: step({ id: 'ui-prototype', agent: 'ui-prototype' }),
      workflowName: 'ship',
      attempt: 1,
      runOwnedIdeaIds: ['IDEA-run', 'IDEA-created'],
    });
    expect(out).toContain('## Conditional execution');
    expect(out).toContain('## Run-owned idea scope');
    expect(out).toContain('`IDEA-run`, `IDEA-created`');
    expect(out).toContain('cyboflow_get_task');
    expect(out).not.toContain('cyboflow_list_tasks');
    expect(out).toContain('Do NOT enumerate project ideas or infer an active idea');
    expect(out).toContain('UI_PROTOTYPE: yes');
    expect(out).toContain('do not delegate, do not write prototype files, do not report an artifact');
  });

  it('gates architecture on the persisted ARCH_DESIGN flag before delegating', () => {
    const out = composeStepPrompt({
      step: step({ id: 'architecture', agent: 'architecture' }),
      workflowName: 'ship',
      attempt: 1,
      runOwnedIdeaIds: ['IDEA-run'],
    });
    expect(out).toContain('## Conditional execution');
    expect(out).toContain('ARCH_DESIGN: yes');
    expect(out).toContain('do not delegate, do not change an idea body');
  });

  it('composes the artifact addendum correctly with the fan-out item context variant', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'ui-prototype',
        name: 'UI prototype',
        agent: 'ui-prototype',
        outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
      }),
      workflowName: 'planner',
      attempt: 1,
      item: { id: 'IDEA-1', over: 'ideas' },
    });
    expect(out).toContain('PARALLEL fan-out');
    expect(out).toContain('## Artifact to report');
    expect(out).toContain('cyboflow_report_artifact');
  });

  // -------------------------------------------------------------------------
  // Operator guidance — mid-run steering text (RunDirectives) appended as a tail
  // section. Present ONLY when the operator steered this step; empty/whitespace
  // or absent ⇒ no section (output unchanged).
  // -------------------------------------------------------------------------

  it('renders an Operator guidance section when userGuidance is provided', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      userGuidance: 'Keep the change under the feature flag.',
    });
    expect(out).toContain('## Operator guidance');
    expect(out).toContain('Keep the change under the feature flag.');
  });

  it('omits the Operator guidance section when userGuidance is undefined', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).not.toContain('## Operator guidance');
  });

  it('omits the Operator guidance section when userGuidance is empty / whitespace', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
      userGuidance: '   ',
    });
    expect(out).not.toContain('## Operator guidance');
  });

  // -------------------------------------------------------------------------
  // laneGuidance — the supervisor's LANE-RESCUE guidance (monitor lane triage).
  // Shares the `## Operator guidance` heading with the operator's own steer, but
  // is labelled separately; both may be present at once.
  // -------------------------------------------------------------------------

  it('renders the supervisor lane-rescue guidance under the Operator guidance heading', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      laneGuidance: 'mock the clock instead of sleeping',
    });
    expect(out).toContain('## Operator guidance');
    expect(out).toContain('SUPERVISOR');
    expect(out).toContain('mock the clock instead of sleeping');
  });

  it('renders BOTH guidance sources, labelled, when an operator steer and a lane rescue coexist', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      userGuidance: 'Keep the change under the feature flag.',
      laneGuidance: 'mock the clock instead of sleeping',
    });
    // ONE heading, both bodies — an agent should not have to learn two section
    // names for the same kind of instruction.
    expect(out.match(/## Operator guidance/g)).toHaveLength(1);
    expect(out).toContain('The operator added mid-run guidance for this step');
    expect(out).toContain("The run's SUPERVISOR rescued this task's lane");
    expect(out).toContain('Keep the change under the feature flag.');
    expect(out).toContain('mock the clock instead of sleeping');
  });

  it('renders an operator-only steer byte-identically to the single-channel version', () => {
    const args = {
      step: step({ id: 'implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
      userGuidance: 'Keep the change under the feature flag.',
    } as const;
    // No lane guidance ⇒ the exact pre-existing section text.
    expect(composeStepPrompt(args)).toContain(
      '## Operator guidance\n\nThe operator added mid-run guidance for this step — follow it:\n\nKeep the change under the feature flag.',
    );
  });

  it('omits the section when laneGuidance is empty / whitespace and no operator steer exists', () => {
    const out = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 1,
      laneGuidance: '   ',
    });
    expect(out).not.toContain('## Operator guidance');
  });

  // -------------------------------------------------------------------------
  // retryGuidance — the supervisor's ONE-SHOT triage-retry correction. Its own
  // heading (not folded into `## Operator guidance`), rendered AFTER it, and
  // absent ⇒ byte-identical output.
  // -------------------------------------------------------------------------

  it('renders the supervisor retry-guidance section under its own heading', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 2,
      retryGuidance: 'pin the fixture clock instead of sleeping',
    });
    expect(out).toContain('## Supervisor retry guidance (this attempt only)');
    expect(out).toContain('pin the fixture clock instead of sleeping');
    // Not merged into the operator's channel.
    expect(out).not.toContain('## Operator guidance');
  });

  it('renders the retry guidance AFTER the operator guidance when both are present', () => {
    const out = composeStepPrompt({
      step: step({ id: 'implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 2,
      userGuidance: 'Keep the change under the feature flag.',
      retryGuidance: 'pin the fixture clock instead of sleeping',
    });
    expect(out.indexOf('## Operator guidance')).toBeGreaterThan(-1);
    expect(out.indexOf('## Supervisor retry guidance (this attempt only)')).toBeGreaterThan(
      out.indexOf('## Operator guidance'),
    );
    // Both bodies survive; the operator's section is untouched.
    expect(out).toContain('The operator added mid-run guidance for this step');
    expect(out).toContain('Keep the change under the feature flag.');
    expect(out).toContain('pin the fixture clock instead of sleeping');
  });

  it('omits the retry-guidance section (byte-identical output) when absent or blank', () => {
    const base = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'sprint', attempt: 2 });
    const blank = composeStepPrompt({
      step: step({ id: 'a' }),
      workflowName: 'sprint',
      attempt: 2,
      retryGuidance: '   ',
    });
    expect(base).not.toContain('## Supervisor retry guidance');
    expect(blank).toBe(base);
  });

  // -------------------------------------------------------------------------
  // Approve-ideas decisions — the resolved batch-gate verdict lines threaded
  // into every POST-gate step turn (launch's programmatic plane). Heading must
  // stay byte-identical to APPROVE_IDEAS_DECISIONS_HEADING.
  // -------------------------------------------------------------------------

  it('renders the Approve-ideas decisions section with the verdict lines and the denied-refs directive', () => {
    const out = composeStepPrompt({
      step: step({ id: 'expand-spec', name: 'Expand spec', agent: 'context' }),
      workflowName: 'launch',
      attempt: 1,
      approveIdeasDecisions: '- IDEA-001: approve\n- IDEA-002: deny',
    });
    expect(out).toContain('# Approve-ideas decisions');
    expect(out).toContain('- IDEA-001: approve');
    expect(out).toContain('- IDEA-002: deny');
    expect(out).toContain('act on the APPROVED refs only');
    expect(out).toContain('DENIED ideas stay on the backlog untouched');
  });

  it('omits the Approve-ideas decisions section when absent or empty', () => {
    const base = { step: step({ id: 'a' }), workflowName: 'launch', attempt: 1 };
    expect(composeStepPrompt(base)).not.toContain('# Approve-ideas decisions');
    expect(composeStepPrompt({ ...base, approveIdeasDecisions: '  ' })).not.toContain(
      '# Approve-ideas decisions',
    );
  });

  // -------------------------------------------------------------------------
  // Idea persistence contract — flag lines must land in (ideas) / survive
  // (expand-spec) the persisted body, or the conditional design steps
  // self-skip on every programmatic run.
  // -------------------------------------------------------------------------

  it('renders the flag persistence contract on the ideas step (flags + arch fold)', () => {
    const out = composeStepPrompt({
      step: step({ id: 'ideas', name: 'Decompose into ideas', agent: 'interview' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('## Idea persistence contract');
    expect(out).toContain('BUILD_ORDER');
    expect(out).not.toContain('INITIAL_BUILD');
    expect(out).toContain('VERBATIM');
    // The brief-carried architecture folds into the foundation idea here.
    expect(out).toContain('## Architecture design');
    expect(out).toContain('LOWEST `BUILD_ORDER`');
  });

  it('renders the flag preservation contract on the expand-spec step', () => {
    const out = composeStepPrompt({
      step: step({ id: 'expand-spec', name: 'Complete idea specs', agent: 'context' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('## Idea persistence contract');
    expect(out).toContain('MUST preserve those VERBATIM');
  });

  // -------------------------------------------------------------------------
  // Component-ledger contract — launch's programmatic step turns never see
  // launch.md, so the stamp obligations must be composed here or the ledger
  // goes unwritten (observed: an idea with 3 epics + 8 tasks reading
  // `incomplete` for `epics` and `stories`).
  // -------------------------------------------------------------------------

  it('tells the launch tasks step to stamp stories and epics', () => {
    const out = composeStepPrompt({
      step: step({ id: 'tasks', name: 'Fill out task details', agent: 'tasks' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('## Component ledger (launch)');
    expect(out).toContain('cyboflow_set_idea_component');
    expect(out).toContain("component: 'stories', state: 'complete'");
    expect(out).toContain("component: 'epics', state:");
  });

  it('tells the launch expand-spec step to stamp idea-spec after the body write', () => {
    const out = composeStepPrompt({
      step: step({ id: 'expand-spec', name: 'Complete idea specs', agent: 'context' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain("component: 'idea-spec', state: 'complete'");
    expect(out).toContain('AFTER');
    // The spec rewrite stales architecture by materializing a row, so the
    // ideas-step stamp must be renewed here or it reads "needs review".
    expect(out).toContain("component: 'architecture', state: 'complete'");
  });

  it('stamps architecture on the launch ideas step, and prototype only where evidenced', () => {
    const out = composeStepPrompt({
      step: step({ id: 'ideas', name: 'Decompose into ideas', agent: 'interview' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain("component: 'architecture', state: 'complete'");
    // The blanket "never stamp prototype" rule is gone: the approve-ideas gate now
    // binds the concept design to every approved idea, so an idea that received
    // its OWN design-spec section truthfully has designed screens. The narrowing
    // survives — every other idea stays unstamped rather than inheriting a claim
    // one whole-concept mockup cannot support (a ledger row beats derivation).
    expect(out).toContain('Never stamp `prototype` on an idea with no design-spec section of its own');
    expect(out).not.toContain('Do NOT stamp `prototype` on any idea');
  });

  it('defers the epics stamp off the launch epics step', () => {
    const out = composeStepPrompt({
      step: step({ id: 'epics', name: 'Create epics', agent: 'epics' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('Do NOT stamp the `epics` component here');
  });

  it('omits the ledger contract on flows without a ledger and on unrelated steps', () => {
    // Planner and ship DO carry a ledger contract now (see their own block
    // below); sprint / compound / verify-setup have no ideas to stamp.
    for (const workflowName of ['sprint', 'compound', 'verify-setup']) {
      const out = composeStepPrompt({
        step: step({ id: 'tasks', name: 'Fill out task details', agent: 'tasks' }),
        workflowName,
        attempt: 1,
      });
      expect(out, workflowName).not.toContain('## Component ledger');
    }
    for (const workflowName of ['launch', 'planner', 'ship']) {
      const gate = composeStepPrompt({
        step: step({ id: 'approve-plan', name: 'Approve task plan', agent: 'human' }),
        workflowName,
        attempt: 1,
      });
      expect(gate, workflowName).not.toContain('## Component ledger');
    }
  });

  it('omits the persistence contract on unrelated steps', () => {
    const out = composeStepPrompt({
      step: step({ id: 'epics', name: 'Epics', agent: 'epics' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).not.toContain('## Idea persistence contract');
  });

  // -------------------------------------------------------------------------
  // Project brief threading + launch concept-level design conditioning
  // -------------------------------------------------------------------------

  it('renders the Project brief section when the host threads it', () => {
    const out = composeStepPrompt({
      step: step({ id: 'ideas', name: 'Decompose into ideas', agent: 'interview' }),
      workflowName: 'launch',
      attempt: 1,
      projectBrief: '## Project brief\n\n### Vision\nA habit tracker.\n\nUI_PROTOTYPE: yes\nARCH_DESIGN: yes',
    });
    expect(out).toContain('# Project brief');
    expect(out).toContain('A habit tracker.');
    // Absent / empty ⇒ no section (a neutral step: the ideas contract itself
    // mentions the backticked section name, so assert on the heading form).
    const bare = composeStepPrompt({ step: step({ id: 'epics' }), workflowName: 'launch', attempt: 1 });
    expect(bare).not.toContain('\n# Project brief\n');
  });

  it('launch design steps condition on the BRIEF flags, not idea flags', () => {
    const ui = composeStepPrompt({
      step: step({ id: 'ui-prototype', name: 'Concept prototype', agent: 'ui-prototype' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(ui).toContain('## Conditional execution');
    expect(ui).toContain('brief carries `UI_PROTOTYPE: yes`');
    expect(ui).toContain('whole-product concept mockup');
    expect(ui).not.toContain('Run-owned idea scope');

    const arch = composeStepPrompt({
      step: step({ id: 'architecture', name: 'Architecture design', agent: 'architecture' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(arch).toContain('brief carries `ARCH_DESIGN: yes`');
    expect(arch).toContain('PROJECT-LEVEL architecture');
  });

  it('planner/ship design steps keep the per-idea flag conditioning', () => {
    const out = composeStepPrompt({
      step: step({ id: 'ui-prototype', name: 'UI prototype', agent: 'ui-prototype' }),
      workflowName: 'planner',
      attempt: 1,
      runOwnedIdeaIds: ['ide_1'],
    });
    expect(out).toContain('persisted spec contains `UI_PROTOTYPE: yes`');
  });

  it('launch architecture artifact follow-up re-reports the brief (no idea exists yet)', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'architecture',
        name: 'Architecture design',
        agent: 'architecture',
        outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
      }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain("atype: 'project-brief'");
    expect(out).not.toContain("fold it into the IDEA's body");

    // Planner keeps the fold-into-idea follow-up.
    const planner = composeStepPrompt({
      step: step({
        id: 'architecture',
        name: 'Architecture design',
        agent: 'architecture',
        outputArtifact: { atype: 'arch-design', label: 'Architecture design' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(planner).toContain("fold it into the IDEA's body");
  });

  // ---------------------------------------------------------------------------
  // verify-setup grounding (2026-08-27 live defect): the programmatic `prove`
  // step could not see the proposal `derive` had published, so it asked the human
  // to paste it back. Nothing on this plane can read an artifact.
  // ---------------------------------------------------------------------------

  it("renders verify-runbook's own artifact contract, never Compound's", () => {
    const out = composeStepPrompt({
      step: step({
        id: 'derive',
        name: 'Derive the runbook',
        agent: 'verify-setup',
        outputArtifact: { atype: 'verify-runbook', label: 'Runbook proposal' },
      }),
      workflowName: 'verify-setup',
      attempt: 1,
    });
    expect(out).toContain("atype: 'verify-runbook'");
    expect(out).toContain('## Runbook');
    expect(out).toContain('## Repo changes');
    expect(out).toContain('## Risks');
    expect(out).toContain('Rung 2 (proposed diff)');
    // The exact cross-wiring the stale atype caused: Compound's follow-up told
    // this step to delegate to the compounder and compose a learnings doc.
    expect(out).not.toContain('After your `cyboflow-compounder` subagent returns');
    expect(out).not.toContain('## Learnings');
    expect(out).not.toContain('summary-of-recommendations');
    // ...and this contract says so out loud, since the agent may have seen the old one.
    expect(out).toContain('This is NOT a Compound run');
    // Placeholders survive into the prompt un-interpolated.
    expect(out).toContain('${PORT}-style placeholders');
  });

  it('threads the approved runbook proposal and marks it authoritative', () => {
    const out = composeStepPrompt({
      step: step({ id: 'prove', name: 'Prove the runbook', agent: 'verify-setup' }),
      workflowName: 'verify-setup',
      attempt: 1,
      runbookProposal: '## Runbook\n\ncdp-app: serve `pnpm electron-dev`',
      });
    expect(out).toContain('# Approved runbook proposal');
    expect(out).toContain('cdp-app: serve `pnpm electron-dev`');
    expect(out).toContain('Do NOT re-derive');
  });

  it('omits the proposal section entirely when there is none', () => {
    const bare = composeStepPrompt({
      step: step({ id: 'prove', name: 'Prove the runbook', agent: 'verify-setup' }),
      workflowName: 'verify-setup',
      attempt: 1,
    });
    expect(bare).not.toContain('# Approved runbook proposal');
    // A non-verify-setup step is byte-identical with and without the field absent.
    const other = composeStepPrompt({ step: step({ id: 'a' }), workflowName: 'planner', attempt: 1 });
    expect(other).not.toContain('# Approved runbook proposal');
    expect(other).not.toContain('Prove-step contract');
  });

  it('renders a human gate NOTE but drops a bare verdict word', () => {
    const qualified = composeStepPrompt({
      step: step({ id: 'prove', name: 'Prove', agent: 'verify-setup' }),
      workflowName: 'verify-setup',
      attempt: 1,
      approveRunbookResolution: 'approve, but skip native-screen',
    });
    expect(qualified).toContain('Gate note from the human');
    expect(qualified).toContain('skip native-screen');

    // 'approve' alone carries nothing prove can act on — rendering it would read
    // like a trimming instruction when the human gave none.
    for (const bare of ['approve', 'Approved', 'reject', 'revise', 'retry']) {
      const out = composeStepPrompt({
        step: step({ id: 'prove', name: 'Prove', agent: 'verify-setup' }),
        workflowName: 'verify-setup',
        attempt: 1,
        approveRunbookResolution: bare,
      });
      expect(out, bare).not.toContain('Gate note from the human');
    }
  });

  it('gives prove its own do-it-yourself contract, and only prove', () => {
    const prove = composeStepPrompt({
      step: step({ id: 'prove', name: 'Prove the runbook', agent: 'verify-setup' }),
      workflowName: 'verify-setup',
      attempt: 1,
    });
    expect(prove).toContain('Prove-step contract (verify-setup)');
    // The generic step-1 prose would send this step's WRITING work to a role whose
    // own contract forbids writing files, cyboflow state, or commits.
    expect(prove).toContain('Do NOT delegate it');
    // The two failure modes seen live: an ignored .cyboflow/ path staged as a
    // silent no-op, and a composed task that does not match the registered runbook.
    expect(prove).toContain('git add -f .cyboflow/verify-runbook.json');
    expect(prove).toContain('git cat-file -e HEAD:.cyboflow/verify-runbook.json');
    expect(prove).toContain('runbook/sha mismatch');
    // B4: a mobile proof task carries an `app` block in place of `serve`;
    // composing one without it resolves the wrong modality at the authorization
    // check and the setup-proof request is rejected.
    expect(prove).toContain('its serve form OR its `app` block (mobile)');
    expect(prove).toContain('setup_proof: true');
    expect(prove).toContain('Never mark a runbook proven');
    // F10 (docs/proposals/visual-verification-brittleness-fixes.md): the DB
    // record is authoritative — the runner executes the REGISTERED
    // `portable_json` by content hash and never reads the snapshot's file — so
    // the prose must no longer claim an uncommitted runbook makes every proof
    // judge an empty tree, and `committed: false` is a warning, not a blocker.
    expect(prove).not.toContain('every proof will be judged against a tree that has no runbook in it');
    expect(prove).not.toContain('that is a blocker on proving, not a note');
    expect(prove).toContain("the REGISTERED record's `portable_json`");
    expect(prove).toContain('is a WARNING, not a blocker');

    // inspect/derive share prove's agent key, so the contract must key on the step.
    const derive = composeStepPrompt({
      step: step({ id: 'derive', name: 'Derive', agent: 'verify-setup' }),
      workflowName: 'verify-setup',
      attempt: 1,
    });
    expect(derive).not.toContain('Prove-step contract');
  });
  // ── item 9: the Design spec fold ────────────────────────────────────────────

  it('tells ui-prototype to fold the Design spec into each idea (planner/ship) or the brief (launch)', () => {
    const proto = (workflowName: string): string =>
      composeStepPrompt({
        step: step({
          id: 'ui-prototype',
          name: 'UI prototype',
          agent: 'ui-prototype',
          outputArtifact: { atype: 'ui-prototype', label: 'UI prototype' },
        }),
        workflowName,
        attempt: 1,
      });

    for (const flow of ['planner', 'ship']) {
      const out = proto(flow);
      // Reporting the artifact is NOT enough: the prototype file dies with the
      // run, so the prose must send the prose section to a durable body.
      expect(out, flow).toContain('## Design spec');
      expect(out, flow).toContain('cyboflow_update_task');
      expect(out, flow).toContain('REPLACE that section (never stack a second copy)');
      expect(out, flow).not.toContain('re-report the brief');
    }

    const launch = proto('launch');
    // No idea exists on launch at design time, so the brief is the carrier.
    expect(launch).toContain('## Design spec');
    expect(launch).toContain("atype: 'project-brief'");
    expect(launch).not.toContain('cyboflow_update_task');
  });

  it('names Design spec in the expand-spec preserve-list so the rewrite cannot clobber it', () => {
    // Launch writes the section at `ideas` and rewrites the same body at
    // `expand-spec`; a preserve-list that does not name it destroys it, and the
    // rewrite also materializes stale ledger rows that beat derivation forever.
    const out = composeStepPrompt({
      step: step({ id: 'expand-spec', name: 'Expand spec', agent: 'context' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('## Design spec');
    expect(out).toContain('## Architecture design');
    expect(out).toContain('MUST preserve those VERBATIM');
  });

  it('re-stamps prototype at expand-spec only for an idea with BOTH a bound design and a Design spec', () => {
    const out = composeStepPrompt({
      step: step({ id: 'expand-spec', name: 'Expand spec', agent: 'context' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain("component: 'prototype', state: 'complete'");
    expect(out).toContain('approved_design');
    expect(out).toContain('Do NOT stamp `prototype` on an idea missing either half');
  });

  it('gates the launch ideas-step prototype stamp on the idea carrying its own Design spec', () => {
    // C9: the gate binds one whole-concept mockup to EVERY approved idea, but a
    // ledger row is authoritative over derivation — so "complete" must mean "this
    // idea's screens are designed", not "some mockup exists".
    const out = composeStepPrompt({
      step: step({ id: 'ideas', name: 'Ideas', agent: 'interview' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('Never stamp `prototype` on an idea with no design-spec section of its own');
    // The ideas step is also where the brief's one spec is divided among ideas,
    // and where the de-placeholder rule reaches idea bodies.
    expect(out).toContain("Split the brief's spec across the ideas");
    expect(out).toContain("reachable from the app's entry point");
    expect(out).toContain('never write that a control is a placeholder');
  });

  // ── item 10: design surfaces ────────────────────────────────────────────────

  it('renders the design-surfaces block right after the project brief, and omits it when absent', () => {
    const base = {
      step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
      workflowName: 'sprint',
      attempt: 1,
    };
    const bare = composeStepPrompt(base);
    expect(bare).not.toContain('# Design surfaces');

    const withBrief = composeStepPrompt({
      ...base,
      projectBrief: 'BRIEF BODY',
      designSurfaces: '# Design surfaces\n\nSURFACE BODY',
    });
    expect(withBrief).toContain('# Design surfaces');
    expect(withBrief).toContain('SURFACE BODY');
    expect(withBrief.indexOf('# Project brief')).toBeLessThan(withBrief.indexOf('# Design surfaces'));

    // Whitespace-only is treated as absent — byte-identical to no value at all.
    expect(composeStepPrompt({ ...base, designSurfaces: '   \n  ' })).toBe(bare);
  });

  // ── item 12a: the adversarial-review artifact ───────────────────────────────

  it('tells adversarial-review to report an artifact and file NO findings', () => {
    const out = composeStepPrompt({
      step: step({
        id: 'adversarial-review',
        name: 'Adversarial review',
        agent: 'adversarial-review',
        outputArtifact: { atype: 'adversarial-review', label: 'Adversarial review' },
      }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(out).toContain("atype: 'adversarial-review'");
    expect(out).toContain('#### AR-n');
    expect(out).toContain('## Blocking');
    expect(out).toContain('## Findings');
    // The gate decides what becomes a finding; filing here pre-empts it and
    // parks the run behind items the next gate was about to triage.
    expect(out).toContain('Do NOT call `cyboflow_report_finding` at this step');
    expect(out).toContain('Do not renumber');
    // Three sections, not two: the ledger is what makes a re-review readable as
    // a continuation of the last one rather than a fresh critique.
    expect(out).toContain('exactly three top-level sections');
    expect(out).toContain('## Prior entries');
    expect(out).toContain("the subagent's `### Prior entries` ledger, VERBATIM");
    expect(out).toContain('write `None.` under it on a first review');
  });

  // ── item 12b: the gate-revision channel ─────────────────────────────────────

  it('renders a gate revision with the human note and the review, distinct from the visual loopback', () => {
    const base = {
      step: step({ id: 'ui-prototype', name: 'UI prototype', agent: 'ui-prototype' }),
      workflowName: 'launch',
      attempt: 1,
    };
    const bare = composeStepPrompt(base);
    expect(bare).not.toContain('Design gate: revision requested');

    const revised = composeStepPrompt({
      ...base,
      gateRevision: {
        gateStepId: 'approve-design',
        note: 'the spend screen has no way back to Home',
        reviewMarkdown: '## Blocking\n\n#### AR-1 — no back navigation',
      },
    });
    expect(revised).toContain('## Design gate: revision requested');
    expect(revised).toContain('`approve-design`');
    expect(revised).toContain('> the spend screen has no way back to Home');
    expect(revised).toContain('AR-1 — no back navigation');
    expect(revised).toContain('which `AR-n` ids you resolved');
    // The visual-verification loopback wording must NOT leak into a design revision.
    expect(revised).not.toContain('Visual verification failed');

    // A revision with no note leans on the review instead of quoting silence.
    const noNote = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'approve-design', reviewMarkdown: '## Blocking\n\n#### AR-1 — x' },
    });
    expect(noNote).toContain('left no note beyond the decision');
    expect(noNote).not.toContain('>  ');

    // Neither a note nor a review: the prompt must not point at a review that is
    // not there, and must still forbid re-emitting the same output.
    const nothing = composeStepPrompt({ ...base, gateRevision: { gateStepId: 'approve-design' } });
    expect(nothing).toContain('## Design gate: revision requested');
    expect(nothing).toContain('no adversarial review to work from');
    expect(nothing).not.toContain('the adversarial review below');
  });

  it('renders an adversarial-review-sourced revision under its own heading, never as a human decision', () => {
    const base = {
      step: step({ id: 'ui-prototype', name: 'UI prototype', agent: 'ui-prototype' }),
      workflowName: 'planner',
      attempt: 1,
    };
    const auto = composeStepPrompt({
      ...base,
      gateRevision: {
        gateStepId: 'adversarial-review',
        source: 'adversarial-review',
        note: '#### AR-1 — no back navigation',
        reviewMarkdown: '## Blocking\n\n#### AR-1 — no back navigation\n\n## Findings\n\nNone.',
      },
    });
    expect(auto).toContain('## Adversarial review: revision requested');
    expect(auto).not.toContain('## Design gate: revision requested');
    expect(auto).not.toContain('A human reviewed');
    expect(auto).toContain('no human has seen the design gate yet');
    expect(auto).toContain('`adversarial-review`');
    // The artifact is the specification; the extracted note is not quoted twice.
    expect(auto).toContain('### Adversarial review of the previous round');
    expect(auto).toContain('which `AR-n` ids you resolved');
    expect(auto).not.toContain('### Blocking entries from the previous round');

    // Artifact unreadable ⇒ fall back to the blocking entries the controller extracted.
    const fallback = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'adversarial-review', source: 'adversarial-review', note: '#### AR-1 — no back navigation' },
    });
    expect(fallback).toContain('### Blocking entries from the previous round');
    expect(fallback).toContain('AR-1 — no back navigation');

    // Neither ⇒ the verdict alone, with the same no-repeat / no-question rule.
    const nothing = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'adversarial-review', source: 'adversarial-review' },
    });
    expect(nothing).toContain('## Adversarial review: revision requested');
    expect(nothing).toContain('do NOT re-emit the same result');
  });

  // ── item 1: round threading + id continuity ─────────────────────────────────

  it('tells a re-run which round it is and which AR ids are already spent', () => {
    const base = {
      step: step({ id: 'expand-spec', name: 'Expand spec', agent: 'expand-spec' }),
      workflowName: 'planner' as const,
      attempt: 1,
    };
    const reviewMarkdown = '## Blocking\n\n#### AR-3 — still broken\n\n## Prior entries\n\n- AR-1 (blocker) — resolved';

    // Automatic lap, round known.
    const lap = composeStepPrompt({
      ...base,
      gateRevision: {
        gateStepId: 'adversarial-review',
        source: 'adversarial-review',
        round: 1,
        reviewMarkdown,
      },
    });
    expect(lap).toContain('This is round 2 of the adversarial review.');
    expect(lap).toContain('Ids used so far: `AR-1`..`AR-3`.');
    expect(lap).toContain('continue any NEW entry from AR-4');
    expect(lap).toContain('`### Prior entries`');

    // Human gate revise, round known — the same sentence, the other branch.
    const human = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'approve-design', round: 2, reviewMarkdown },
    });
    expect(human).toContain('## Design gate: revision requested');
    expect(human).toContain('This is round 3 of the adversarial review.');
    expect(human).toContain('Ids used so far: `AR-1`..`AR-3`.');

    // Round unknown ⇒ the id rule survives, the round clause is dropped rather
    // than guessed at.
    const noRound = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'approve-design', reviewMarkdown },
    });
    expect(noRound).not.toContain('This is round');
    expect(noRound).toContain('Ids used so far: `AR-1`..`AR-3`.');

    // k = 0 ⇒ no ids exist yet, so the whole sentence is omitted.
    const noIds = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'approve-design', round: 1, reviewMarkdown: '## Blocking\n\nNone.' },
    });
    expect(noIds).not.toContain('Ids used so far');
    expect(noIds).not.toContain('This is round');
  });

  it('renders the supervisor’s steering inside the automatic-revision section, as outranking the review', () => {
    const base = {
      step: step({ id: 'expand-spec', name: 'Expand spec', agent: 'expand-spec' }),
      workflowName: 'planner' as const,
      attempt: 1,
    };
    const reviewMarkdown = '## Blocking\n\n#### AR-1 — no way back\n\n#### AR-2 — no data store';

    const steered = composeStepPrompt({
      ...base,
      gateRevision: {
        gateStepId: 'adversarial-review',
        source: 'adversarial-review',
        round: 1,
        reviewMarkdown,
        steering: {
          address: ['AR-1'],
          setAside: [{ id: 'AR-2', reason: 'a product call, not a defect' }],
          guidance: 'add a Home affordance',
        },
      },
    });
    expect(steered).toContain('## Adversarial review: revision requested');
    expect(steered).toContain("The supervisor's steering — authoritative, outranks the review where they disagree:");
    expect(steered).toContain('ADDRESS `AR-1` (add a Home affordance).');
    expect(steered).toContain('SET ASIDE `AR-2` (a product call, not a defect): do not spend this lap on them; they are already filed as findings.');
    expect(steered).toContain('Reviewer: list set-aside ids under `### Prior entries` as `set-aside`; do not re-raise them as blocking.');
    // It comes AFTER the review it outranks.
    expect(steered.indexOf("supervisor's steering")).toBeGreaterThan(steered.indexOf('#### AR-1 — no way back'));

    // A mechanical lap (no supervisor verdict) renders no steering at all.
    const mechanical = composeStepPrompt({
      ...base,
      gateRevision: { gateStepId: 'adversarial-review', source: 'adversarial-review', round: 1, reviewMarkdown },
    });
    expect(mechanical).not.toContain('supervisor');
    expect(mechanical).not.toContain('SET ASIDE');
  });

  it('renders only the half of the steering that has entries, and nothing when both are empty', () => {
    const base = {
      step: step({ id: 'expand-spec', agent: 'expand-spec' }),
      workflowName: 'planner' as const,
      attempt: 1,
      gateRevision: {
        gateStepId: 'adversarial-review',
        source: 'adversarial-review' as const,
        reviewMarkdown: '## Blocking\n\n#### AR-1 — x',
      },
    };

    const addressOnly = composeStepPrompt({
      ...base,
      gateRevision: { ...base.gateRevision, steering: { address: ['AR-1'], setAside: [] } },
    });
    expect(addressOnly).toContain('ADDRESS `AR-1`.');
    expect(addressOnly).not.toContain('SET ASIDE');
    // No guidance ⇒ no empty parenthesis.
    expect(addressOnly).not.toContain('()');

    const setAsideOnly = composeStepPrompt({
      ...base,
      gateRevision: { ...base.gateRevision, steering: { address: [], setAside: [{ id: 'AR-1', reason: '  ' }] } },
    });
    expect(setAsideOnly).not.toContain('ADDRESS');
    expect(setAsideOnly).toContain('SET ASIDE `AR-1` (no reason given)');

    const empty = composeStepPrompt({
      ...base,
      gateRevision: { ...base.gateRevision, steering: { address: [], setAside: [] } },
    });
    expect(empty).not.toContain("supervisor's steering");
  });

  it('asks the adversarial-review step for the REVIEW verdict trailer, and only promises a loop when the step declares one', () => {
    const review = (loopback?: string): string =>
      composeStepPrompt({
        step: step({
          id: 'adversarial-review',
          name: 'Adversarial review',
          agent: 'adversarial-review',
          outputArtifact: { atype: 'adversarial-review', label: 'Adversarial review' },
          ...(loopback ? { loopback } : {}),
        }),
        workflowName: 'planner',
        attempt: 1,
      });
    const looping = review('expand-spec');
    expect(looping).toContain('`REVIEW: BLOCKING`');
    expect(looping).toContain('`REVIEW: CLEAN`');
    expect(looping).toContain('re-runs the design steps automatically');
    const plain = review();
    expect(plain).toContain('`REVIEW: BLOCKING`');
    expect(plain).not.toContain('re-runs the design steps automatically');
    expect(plain).toContain('the design gate is what routes');
  });

  // ── item 13b: thoroughness budgets ──────────────────────────────────────────

  it('renders only the running agent\'s thoroughness budget, and nothing without a level', () => {
    const arch = (level?: 'prototype' | 'v1' | 'production'): string =>
      composeStepPrompt({
        step: step({ id: 'architecture', name: 'Architecture', agent: 'architecture' }),
        workflowName: 'planner',
        attempt: 1,
        ...(level ? { solutionThoroughness: level } : {}),
      });

    expect(arch()).not.toContain('# Solution thoroughness');

    const proto = arch('prototype');
    expect(proto).toContain('# Solution thoroughness: prototype');
    expect(proto).toContain('at most 40 lines');
    expect(proto).toContain('OVERRIDES');
    // Another agent's budget must not bleed into this prompt.
    expect(proto).not.toContain('HAPPY-PATH acceptance criteria');

    const prod = arch('production');
    expect(prod).toContain('# Solution thoroughness: production');
    expect(prod).toContain('failure modes');
    expect(prod).not.toContain('at most 40 lines');

    // An agent with no entry at this level gets the level, not a budget.
    const epics = composeStepPrompt({
      step: step({ id: 'epics', name: 'Epics', agent: 'epics' }),
      workflowName: 'planner',
      attempt: 1,
      solutionThoroughness: 'prototype',
    });
    expect(epics).toContain('# Solution thoroughness: prototype');
    expect(epics).not.toContain('OVERRIDES');
  });
  // -------------------------------------------------------------------------
  // Planner / Ship component ledger (survey D P5 / P6 / P18) — the obligations
  // that were prose-only for as long as ideaLedgerContract was launch-guarded.
  // -------------------------------------------------------------------------

  describe('planner / ship component ledger', () => {
    for (const workflowName of ['planner', 'ship'] as const) {
      it(`tells ${workflowName}'s context step to READ the ledger before planning`, () => {
        const out = composeStepPrompt({
          step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
          workflowName,
          attempt: 1,
        });
        expect(out).toContain('## Component ledger');
        expect(out).toContain('`cyboflow_get_task` on EVERY idea in scope');
        // The three-way read is the part a step agent cannot infer.
        expect(out).toContain('settled work. Do NOT redo it');
        expect(out).toContain('needs RE-VERIFICATION, not a redo');
        expect(out).toContain('genuinely not started');
        expect(out).toContain('never silently un-skip it');
      });

      it(`stamps idea-spec at ${workflowName}'s expand-spec step, after the body write`, () => {
        const out = composeStepPrompt({
          step: step({ id: 'expand-spec', name: 'Complete idea spec', agent: 'context' }),
          workflowName,
          attempt: 1,
        });
        expect(out).toContain("component: 'idea-spec', state: 'complete'");
        expect(out).toContain('never before the write');
        expect(out).toContain("component: 'architecture', state: 'complete'");
        expect(out).toContain("component: 'prototype', state: 'complete'");
      });

      it(`defers the epics stamp off ${workflowName}'s epics step`, () => {
        const out = composeStepPrompt({
          step: step({ id: 'epics', name: 'Create epics', agent: 'epics' }),
          workflowName,
          attempt: 1,
        });
        expect(out).toContain('Do NOT stamp the `epics` component here');
      });

      it(`closes the ledger out at ${workflowName}'s tasks step`, () => {
        const out = composeStepPrompt({
          step: step({ id: 'tasks', name: 'Fill out task details', agent: 'tasks' }),
          workflowName,
          attempt: 1,
        });
        expect(out).toContain("component: 'stories', state: 'complete'");
        expect(out).toContain("component: 'epics', state: …");
        // P18 — the closeout, not just the two stamps.
        expect(out).toContain("ledger's CLOSEOUT");
        expect(out).toContain('account for all five components');
      });
    }

    it('keeps launch on its own heading and strings', () => {
      const launch = composeStepPrompt({
        step: step({ id: 'tasks', name: 'Fill out task details', agent: 'tasks' }),
        workflowName: 'launch',
        attempt: 1,
      });
      expect(launch).toContain('## Component ledger (launch)');
      // Launch's tasks string is the pre-existing one — no closeout paragraph.
      expect(launch).not.toContain("ledger's CLOSEOUT");
      // And launch has no context-step ledger section at all.
      const launchContext = composeStepPrompt({
        step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
        workflowName: 'launch',
        attempt: 1,
      });
      expect(launchContext).not.toContain('## Component ledger');
    });

    it('never renders the planner/ship heading on launch, nor launch’s on planner', () => {
      const launch = composeStepPrompt({
        step: step({ id: 'expand-spec', name: 'Expand', agent: 'context' }),
        workflowName: 'launch',
        attempt: 1,
      });
      // Launch's heading carries the "(launch)" qualifier; planner/ship's does not.
      expect(launch).toContain('## Component ledger (launch)');
      const planner = composeStepPrompt({
        step: step({ id: 'expand-spec', name: 'Expand', agent: 'context' }),
        workflowName: 'planner',
        attempt: 1,
      });
      expect(planner).not.toContain('## Component ledger (launch)');
      expect(planner).toContain('## Component ledger');
    });
  });

  // -------------------------------------------------------------------------
  // Planner idea-size guard (survey D P3)
  // -------------------------------------------------------------------------

  describe('idea-size guard', () => {
    it('fires on a BATCHED planner context step', () => {
      const out = composeStepPrompt({
        step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
        workflowName: 'planner',
        attempt: 1,
        runOwnedIdeaIds: ['idea-1', 'idea-2', 'idea-3'],
      });
      expect(out).toContain('## Idea-size guard (batched run)');
      expect(out).toContain('seeded with 3 ideas');
      expect(out).toContain('`idea-size-guard: <the idea’s ref>`'.replace('’', "'"));
      expect(out).toContain('"gate":"idea-size-guard"');
      expect(out).toContain('DROP that idea from this run’s working set'.replace('’', "'"));
    });

    it('stays absent on a single-seed planner run (a dedicated run by construction)', () => {
      const out = composeStepPrompt({
        step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
        workflowName: 'planner',
        attempt: 1,
        runOwnedIdeaIds: ['idea-1'],
      });
      expect(out).not.toContain('Idea-size guard');
    });

    it('stays absent on other flows and other steps', () => {
      const ship = composeStepPrompt({
        step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
        workflowName: 'ship',
        attempt: 1,
        runOwnedIdeaIds: ['a', 'b'],
      });
      expect(ship).not.toContain('Idea-size guard');
      const laterStep = composeStepPrompt({
        step: step({ id: 'tasks', name: 'Tasks', agent: 'tasks' }),
        workflowName: 'planner',
        attempt: 1,
        runOwnedIdeaIds: ['a', 'b'],
      });
      expect(laterStep).not.toContain('Idea-size guard');
    });
  });

  // -------------------------------------------------------------------------
  // Launch: decompose everything approved (survey D L15)
  // -------------------------------------------------------------------------

  describe('decompose everything approved', () => {
    for (const id of ['ideas', 'expand-spec', 'tasks'] as const) {
      it(`binds on launch's ${id} step`, () => {
        const out = composeStepPrompt({
          step: step({ id, name: id, agent: 'tasks' }),
          workflowName: 'launch',
          attempt: 1,
        });
        expect(out).toContain('## Decompose everything approved');
        expect(out).toContain('Never narrow the set to save time');
        expect(out).toContain('`BUILD_ORDER` as a cut line');
        expect(out).toContain('DENIED at the approve-ideas gate');
      });
    }

    it('stays absent on other launch steps and other flows', () => {
      const epics = composeStepPrompt({
        step: step({ id: 'epics', name: 'Epics', agent: 'epics' }),
        workflowName: 'launch',
        attempt: 1,
      });
      expect(epics).not.toContain('Decompose everything approved');
      const planner = composeStepPrompt({
        step: step({ id: 'tasks', name: 'Tasks', agent: 'tasks' }),
        workflowName: 'planner',
        attempt: 1,
      });
      expect(planner).not.toContain('Decompose everything approved');
    });
  });

  // -------------------------------------------------------------------------
  // Ship: no design fork (survey D H2)
  // -------------------------------------------------------------------------

  describe('ship has no design fork', () => {
    it('suppresses DESIGN_MODE on ship context', () => {
      const out = composeStepPrompt({
        step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
        workflowName: 'ship',
        attempt: 1,
      });
      expect(out).toContain('## No design fork on this flow');
      expect(out).toContain('`DESIGN_MODE: yes`');
      expect(out).toContain('IGNORE it');
    });

    it('leaves planner (which DOES fork) and later ship steps alone', () => {
      const planner = composeStepPrompt({
        step: step({ id: 'context', name: 'Gather context', agent: 'context' }),
        workflowName: 'planner',
        attempt: 1,
      });
      expect(planner).not.toContain('No design fork');
      const later = composeStepPrompt({
        step: step({ id: 'expand-spec', name: 'Expand', agent: 'context' }),
        workflowName: 'ship',
        attempt: 1,
      });
      expect(later).not.toContain('No design fork');
    });
  });

  // -------------------------------------------------------------------------
  // Shared build breaks (Tier 3 detector's input channel)
  // -------------------------------------------------------------------------

  describe('build-break contract', () => {
    for (const workflowName of ['sprint', 'ship'] as const) {
      for (const agent of ['implement', 'write-tests', 'task-verify'] as const) {
        it(`binds on ${workflowName}'s ${agent} lane step`, () => {
          const out = composeStepPrompt({
            step: step({ id: agent, name: agent, agent }),
            workflowName,
            attempt: 1,
          });
          expect(out).toContain('## Build breaks outside your task');
          expect(out).toContain("`category: 'build-break'`");
          expect(out).toContain('Build break: <first error line verbatim>');
          expect(out).toContain('The supervisor groups identical reports across lanes.');
          // The subagent cannot file it — the step agent relays.
          expect(out).toContain('`## Build break` section, YOU file it');
        });
      }
    }

    it('stays off non-lane steps and non-lane flows', () => {
      const review = composeStepPrompt({
        step: step({ id: 'sprint-review', name: 'Sprint review', agent: 'sprint-review' }),
        workflowName: 'sprint',
        attempt: 1,
      });
      expect(review).not.toContain('Build breaks outside your task');
      const planner = composeStepPrompt({
        step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
        workflowName: 'planner',
        attempt: 1,
      });
      expect(planner).not.toContain('Build breaks outside your task');
    });
  });

  // -------------------------------------------------------------------------
  // Compound seeded branch (survey D C1)
  // -------------------------------------------------------------------------

  describe('compound seeded branch', () => {
    const seed = 'Act ONLY on these findings.\n\n## P0 A real bug\n\nTarget: quick';

    it('renders the seed under the same heading the orchestrated plane prepends', () => {
      const out = composeStepPrompt({
        step: step({ id: 'load-sprint', name: 'Load merged work', agent: 'compound-load' }),
        workflowName: 'compound',
        attempt: 1,
        selectedFindings: seed,
      });
      expect(out).toContain('# Selected findings');
      expect(out).toContain('## P0 A real bug');
    });

    for (const id of ['load-sprint', 'extract'] as const) {
      it(`tells ${id} the seed IS the input`, () => {
        const out = composeStepPrompt({
          step: step({ id, name: id, agent: 'compounder' }),
          workflowName: 'compound',
          attempt: 1,
          selectedFindings: seed,
        });
        expect(out).toContain('## This run is SEEDED — the findings above are the input');
        expect(out).toContain('Do NOT rediscover');
        expect(out).toContain('do not mine the merge for additional learnings');
      });
    }

    it('self-skips approve-learnings on a seeded run', () => {
      const out = composeStepPrompt({
        step: step({ id: 'approve-learnings', name: 'Approve learnings', agent: 'compounder' }),
        workflowName: 'compound',
        attempt: 1,
        selectedFindings: seed,
      });
      expect(out).toContain('## This run is SEEDED — this gate does not apply');
      expect(out).toContain('SKIPPED: seeded');
    });

    it('is byte-identical to the unseeded prompt when no seed is threaded', () => {
      const args = {
        step: step({ id: 'extract', name: 'Extract learnings', agent: 'compounder' }),
        workflowName: 'compound',
        attempt: 1,
      } as const;
      const bare = composeStepPrompt(args);
      expect(composeStepPrompt({ ...args, selectedFindings: '' })).toBe(bare);
      expect(composeStepPrompt({ ...args, selectedFindings: '   \n ' })).toBe(bare);
      expect(bare).not.toContain('# Selected findings');
      expect(bare).not.toContain('This run is SEEDED');
    });

    it('never branches a non-compound flow that somehow carries a seed', () => {
      const out = composeStepPrompt({
        step: step({ id: 'implement', name: 'Implement', agent: 'implement' }),
        workflowName: 'sprint',
        attempt: 1,
        selectedFindings: seed,
      });
      // The block still renders (it is grounding), but no seeded branch fires.
      expect(out).toContain('# Selected findings');
      expect(out).not.toContain('This run is SEEDED');
    });
  });

  // -------------------------------------------------------------------------
  // address-review: the tree must not reach the gate red (survey D S15)
  // -------------------------------------------------------------------------

  it('pins the address-review regression finding to one recognizable title', () => {
    const out = composeStepPrompt({
      step: step({ id: 'address-review', name: 'Address review', agent: 'address-review' }),
      workflowName: 'sprint',
      attempt: 1,
    });
    expect(out).toContain('`address-review left the tree red`');
    expect(out).toContain('NAMING the failing spec');
    expect(out).toContain('`blocking: true`');
    // The pre-existing resolve-last rule survives.
    expect(out).toContain('Never resolve a finding before its fix is verified and committed');
  });
});
