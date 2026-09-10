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
  });

  it('stamps architecture but never prototype on the launch ideas step', () => {
    const out = composeStepPrompt({
      step: step({ id: 'ideas', name: 'Decompose into ideas', agent: 'interview' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain("component: 'architecture', state: 'complete'");
    expect(out).toContain('Do NOT stamp `prototype`');
  });

  it('defers the epics stamp off the launch epics step', () => {
    const out = composeStepPrompt({
      step: step({ id: 'epics', name: 'Create epics', agent: 'epics' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(out).toContain('Do NOT stamp the `epics` component here');
  });

  it('omits the ledger contract outside launch and on unrelated launch steps', () => {
    const planner = composeStepPrompt({
      step: step({ id: 'tasks', name: 'Fill out task details', agent: 'tasks' }),
      workflowName: 'planner',
      attempt: 1,
    });
    expect(planner).not.toContain('## Component ledger');
    const gate = composeStepPrompt({
      step: step({ id: 'approve-plan', name: 'Approve task plan', agent: 'human' }),
      workflowName: 'launch',
      attempt: 1,
    });
    expect(gate).not.toContain('## Component ledger');
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
    expect(prove).toContain('setup_proof: true');
    expect(prove).toContain('Never mark a runbook proven');

    // inspect/derive share prove's agent key, so the contract must key on the step.
    const derive = composeStepPrompt({
      step: step({ id: 'derive', name: 'Derive', agent: 'verify-setup' }),
      workflowName: 'verify-setup',
      attempt: 1,
    });
    expect(derive).not.toContain('Prove-step contract');
  });
});
