/**
 * Unit tests for buildBuiltInWorkflows() — the in-repo built-in workflow
 * descriptors that severed the SoloFlow plugin-cache dependency (P0).
 *
 * Coverage:
 *  1. Maps EXACTLY the cyboflow built-in names (planner + sprint + compound +
 *     ship + verify-setup + launch), keyed by CYBOFLOW_WORKFLOW_NAMES.
 *  2. Each descriptor path points at an existing, readable, non-empty `.md`
 *     prompt body alongside the module.
 *  3. The prompt bodies are self-contained: no `.soloflow` / `IDEA-NNN.md` /
 *     `TASK-NNN.md` references.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { buildBuiltInWorkflows } from '../builtInWorkflows';
import { CYBOFLOW_WORKFLOW_NAMES, WORKFLOW_DEFINITIONS } from '../../../../../shared/types/workflows';
import { CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT } from '../../../../../shared/types/agentIdentity';

describe('buildBuiltInWorkflows', () => {
  it('maps exactly the cyboflow built-in names (planner + sprint + compound + ship + verify-setup + launch)', () => {
    const descriptors = buildBuiltInWorkflows();
    const names = descriptors.map((d) => d.name).sort();
    expect(names).toEqual(['compound', 'launch', 'planner', 'ship', 'sprint', 'verify-setup']);
    // Keyed by CYBOFLOW_WORKFLOW_NAMES — same set, no extras, no omissions.
    expect(names).toEqual([...CYBOFLOW_WORKFLOW_NAMES].sort());
  });

  it('points each descriptor at an existing, readable, non-empty prompt .md', () => {
    for (const descriptor of buildBuiltInWorkflows()) {
      expect(descriptor.path, `${descriptor.name} path`).toMatch(/\.md$/);
      const body = readFileSync(descriptor.path, 'utf-8');
      expect(body.trim().length, `${descriptor.name} prompt body non-empty`).toBeGreaterThan(0);
    }
  });

  it('prompt bodies are self-contained (no .soloflow / IDEA-NNN.md / TASK-NNN.md)', () => {
    for (const descriptor of buildBuiltInWorkflows()) {
      const body = readFileSync(descriptor.path, 'utf-8');
      expect(body, `${descriptor.name} must not reference .soloflow`).not.toMatch(/\.soloflow/);
      expect(body, `${descriptor.name} must not reference IDEA-NNN.md`).not.toMatch(/IDEA-NNN\.md/);
      expect(body, `${descriptor.name} must not reference TASK-NNN.md`).not.toMatch(/TASK-NNN\.md/);
    }
  });

  it('frontmatter permission_mode is optional; if present it is one of the four valid modes', () => {
    // Built-in flows ship WITHOUT a frontmatter permission_mode (null by
    // default); per-agent override is opt-in only. Absent values fall back to
    // the global agentPermissionMode default, not a flow-pinned mode — so an
    // ABSENT permission_mode is allowed and is the current baseline. We scan
    // ONLY the leading frontmatter fence so a prose mention can't false-trigger,
    // and IF a flow declares permission_mode we assert it is one of the four
    // valid PermissionMode values the registry can parse (incl. 'auto').
    for (const descriptor of buildBuiltInWorkflows()) {
      const body = readFileSync(descriptor.path, 'utf-8');
      const frontmatterMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(frontmatterMatch, `${descriptor.name} has a frontmatter block`).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      const declared = frontmatter.match(/^permission_mode:\s*([A-Za-z]+)/m);
      if (declared) {
        expect(
          ['default', 'acceptEdits', 'auto', 'dontAsk'],
          `${descriptor.name} frontmatter permission_mode must be a valid PermissionMode`,
        ).toContain(declared[1]);
      }
    }
  });

  it('planner surfaces human gates inline via AskUserQuestion and forbids silently passing a gate', () => {
    const planner = buildBuiltInWorkflows().find((d) => d.name === 'planner');
    expect(planner, 'planner descriptor present').toBeDefined();
    const body = readFileSync(planner!.path, 'utf-8');

    // The orchestrator names AskUserQuestion as the gate mechanism and forbids
    // silently proceeding past a gate.
    expect(body, 'planner must name AskUserQuestion').toMatch(/AskUserQuestion/);
    expect(body, 'Hard rules must forbid silently passing a gate').toMatch(
      /never silently proceed past a gate/,
    );

    // Human gates run INLINE in the orchestrator (IDEA-013 subagent rework):
    // subagents have no AskUserQuestion, so the `Approve idea` / `Approve plan`
    // headers (≤12 char wire limit) live in the planner prose itself, not in a
    // delegated unit. \s allows the soft line-break before the backtick'd header.
    expect(body, 'planner uses the `Approve idea` gate header').toMatch(/header\s+`Approve idea`/);
    expect(body, 'planner uses the `Approve plan` gate header').toMatch(/header\s+`Approve plan`/);
  });

  it('compound proposes quick/doc/task improvements (never findings) + a recommendations doc, gated inline', () => {
    const compound = buildBuiltInWorkflows().find((d) => d.name === 'compound');
    expect(compound, 'compound descriptor present').toBeDefined();
    const body = readFileSync(compound!.path, 'utf-8');

    // approve-learnings is a human gate run inline via AskUserQuestion; nothing
    // folds back without it.
    expect(body, 'compound must name AskUserQuestion for the gate').toMatch(/AskUserQuestion/);
    expect(body, 'compound forbids silently folding a learning back').toMatch(
      /never silently fold a learning back/,
    );

    // The gate reviews a published summary-of-recommendations artifact rather than
    // an inline dump of every learning.
    expect(body, 'compound publishes a compound-recommendations artifact').toMatch(
      /compound-recommendations/,
    );
    expect(body, 'compound reports the recommendations doc via cyboflow_report_artifact').toMatch(
      /cyboflow_report_artifact/,
    );

    // Outputs are proposed improvements — quick fixes / doc-edit decisions /
    // backlog tasks — and NEVER new findings (a finding is Compound's input).
    expect(body, 'compound creates backlog tasks via cyboflow_create_task').toMatch(
      /cyboflow_create_task/,
    );
    expect(body, "compound must never emit kind:'finding' (a finding is its input)").toMatch(
      /finding is Compound's input/i,
    );

    // Single review point: discarded candidates are surfaced in the doc's
    // Discarded section, NEVER as per-drop review-queue gates.
    expect(body, 'compound publishes a Discarded section in the doc').toMatch(/## Discarded/);
    expect(body, 'compound forbids filing a decision per discarded candidate').toMatch(
      /NEVER a `decision` per discarded candidate|per-item gates are the sequential-gate spam/is,
    );

    // approve-learnings approves the PLAN and files no review items. [Codex finding 1]
    expect(body, 'approve-learnings gate emits no review items').toMatch(
      /emits \*\*no review items\*\*/,
    );

    // Write-back APPLIES approved doc edits in-place (not per-edit decisions) and
    // emits NO review items — the terminal human-review step is the merge gate.
    // The edits themselves are delegated to `cyboflow-compound-writeback`, the
    // one compound agent that can write files; the orchestrator still commits.
    expect(body, 'write-back delegates the approved edits to the write-back agent').toMatch(
      /delegate to\s+`cyboflow-compound-writeback`/,
    );
    expect(body, 'write-back applies approved doc edits in-place').toMatch(
      /It applies them in place/,
    );
    // Whitespace-normalized so multi-word phrases match regardless of line wrapping.
    const flat = body.replace(/\s+/g, ' ');

    // CLAUDE.md edits get their own section of the recommendations doc so the
    // human can weigh them apart from the (lower-bar) reference-doc edits.
    expect(flat, 'the recommendations doc separates CLAUDE.md edits from doc edits').toMatch(
      /`### Quick fixes` \/ `### CLAUDE\.md edits` \/ `### Doc edits` \/ `### Tasks`/,
    );
    expect(flat, 'CLAUDE.md edits are never folded into the doc-edits section').toMatch(
      /is its own section and is never folded into `### Doc edits`/,
    );
    expect(flat, 'CLAUDE.md edits are capped at one per run').toMatch(/At most ONE per run/);
    expect(flat, 'the final gate is the terminal human-review "merge in changes" step').toMatch(
      /merge in changes/i,
    );
    expect(flat, 'compound emits NO decision review items anywhere').toMatch(
      /emits \*\*NO\*\* `decision` review items anywhere/,
    );

    // Seeded runs have no discovery, so the doc omits the Discarded section rather
    // than inventing one. [Codex review finding 4]
    expect(body, 'seeded path omits the Discarded section').toMatch(/omit `## Discarded`/);
  });

  it('compound compounder subagent tags quick/task/doc (not "decision") and is extract-only', () => {
    // The compounder returns the learning TAG `doc`, not `decision` — `decision` is
    // the review-item KIND, and overloading the word made the step agent file
    // decisions prematurely. Surveying the merged work is no longer its job at
    // all: that is `cyboflow-compound-load`'s own step.
    // [Codex review findings 2 + 3]
    const compound = buildBuiltInWorkflows().find((d) => d.name === 'compound')!;
    const compounderPath = join(dirname(compound.path), 'compound', 'agents', 'compounder.md');
    // Collapse wrapped-prose whitespace so multi-word phrases match regardless of
    // where markdown line-wrapping falls.
    const body = readFileSync(compounderPath, 'utf-8').replace(/\s+/g, ' ');
    expect(body, 'compounder tags are quick / task / doc (two rungs)').toContain(
      'quick / task / `doc:claude-md` / `doc:reference`',
    );
    expect(body, 'compounder does not use "decision" as a bucket tag').toContain(
      'do not use the word "decision" as a tag',
    );

    // Instruction-file edits clear a bar ABOVE the durability bar, with CLAUDE.md
    // strictest — that skepticism is the point of the two rungs.
    expect(body, 'CLAUDE.md edits require all five admission questions').toContain(
      'Propose a `doc:claude-md` edit ONLY when ALL FIVE hold',
    );
    expect(body, 'CLAUDE.md edits are capped at one per run, zero expected').toContain(
      'At most ONE `doc:claude-md` edit per run, and zero is the expected outcome',
    );
    expect(body, 'reference docs clear a lower but real bar').toContain(
      'A lower bar than rung 1, but still a real one',
    );
    expect(body, 'incident detail is an automatic discard').toContain(
      'carrying a migration number, version stamp, date, commit SHA, session name, or run id as part of the rule',
    );
    // Extract-only: the compounder consumes the load step's summary and must not
    // re-survey or re-emit it. Its two returned sections are Learnings +
    // Discarded, nothing else.
    expect(body, 'compounder consumes the load step summary').toContain(
      'summary that `cyboflow-compound-load` produced',
    );
    expect(body, 'compounder returns exactly two sections').toContain(
      'Return TWO sections, and only these two',
    );
    expect(body, 'compounder does not re-report a Merged work summary').toContain(
      'do not re-report a `## Merged work` summary here',
    );
  });

  it('compound splits its three agent steps across three agents with the right write access', () => {
    // One `compounder` bound to load-sprint / extract / write-back put the
    // extraction bars in front of the read-only survey step AND named a
    // read-only agent on the step that applies edits. Each step now has its own
    // agent, and only write-back's can write.
    const compound = buildBuiltInWorkflows().find((d) => d.name === 'compound')!;
    const agentsDir = join(dirname(compound.path), 'compound', 'agents');
    const steps = WORKFLOW_DEFINITIONS.compound.phases.flatMap((phase) => phase.steps);
    const agentByStep = Object.fromEntries(steps.map((step) => [step.id, step.agent]));

    expect(agentByStep['load-sprint']).toBe('compound-load');
    expect(agentByStep.extract).toBe('compounder');
    expect(agentByStep['write-back']).toBe('compound-writeback');

    // Frontmatter tools: only write-back may edit files.
    const toolsOf = (key: string): string => {
      const raw = readFileSync(join(agentsDir, `${key}.md`), 'utf-8');
      return /^tools:(.*)$/m.exec(raw)?.[1] ?? '';
    };
    for (const readOnly of ['compound-load', 'compounder']) {
      expect(toolsOf(readOnly), `${readOnly} is read-only`).not.toMatch(/\bEdit\b|\bWrite\b/);
    }
    expect(toolsOf('compound-writeback'), 'write-back can edit files').toMatch(/\bEdit\b/);
    expect(toolsOf('compound-writeback'), 'write-back can create files').toMatch(/\bWrite\b/);

    // The load agent surveys; judging is the extract step's job.
    const loadBody = readFileSync(join(agentsDir, 'compound-load.md'), 'utf-8').replace(/\s+/g, ' ');
    expect(loadBody, 'load agent does not mine learnings').toContain(
      'You survey; you do not judge',
    );

    // The write-back agent applies what the gate approved; it does not re-decide.
    const writeBody = readFileSync(join(agentsDir, 'compound-writeback.md'), 'utf-8').replace(
      /\s+/g,
      ' ',
    );
    expect(writeBody, 'write-back does not re-litigate the gate').toContain(
      'The approval is settled',
    );
    expect(writeBody, 'write-back never creates backlog tasks').toContain(
      'You do **not** create backlog tasks',
    );
  });

  it('compound DEFINITION drives the programmatic path: extract outputs the recommendations doc, write-back emits no findings', () => {
    const def = WORKFLOW_DEFINITIONS.compound;
    expect(def, 'WORKFLOW_DEFINITIONS.compound present').toBeDefined();
    const steps = def.phases.flatMap((p) => p.steps);
    const loadSprint = steps.find((s) => s.id === 'load-sprint');
    const extract = steps.find((s) => s.id === 'extract');
    const writeBack = steps.find((s) => s.id === 'write-back');
    expect(loadSprint, 'load-sprint step present').toBeDefined();
    expect(extract, 'extract step present').toBeDefined();
    expect(writeBack, 'write-back step present').toBeDefined();

    // load-sprint returns only the Merged work summary — no premature mining of
    // learnings/drops (the original per-drop-gate leak was at this step). [finding 2]
    expect(loadSprint!.desc ?? '', 'load-sprint desc scopes to Merged work only').toMatch(
      /Merged work summary.*no learnings/is,
    );

    // The programmatic step prompt is built from desc + outputArtifact, so the
    // recommendations artifact MUST be a declared step output (else a programmatic
    // run never mints it — the gap that shipped the doc-less run).
    expect(extract!.outputArtifact?.atype, 'extract declares the recommendations artifact').toBe(
      'compound-recommendations',
    );
    // The doc the programmatic extract step drives is the single review — it names
    // both the Act on set and the Discarded set that replaces the per-drop gates.
    expect(extract!.desc ?? '', 'extract desc names the Discarded section').toMatch(/discarded/i);

    // Neither driving desc may instruct emitting findings.
    expect(extract!.desc ?? '', 'extract desc forbids findings').not.toMatch(/emit findings/i);
    expect(writeBack!.desc ?? '', 'write-back desc no longer emits findings').not.toMatch(
      /emit findings/i,
    );
    expect(writeBack!.desc ?? '', "write-back desc forbids kind:'finding'").toMatch(
      /NEVER kind:'finding'/,
    );
    // Write-back applies every approved item in-place, commits, and emits NO review
    // items — the terminal human-review step is the only final gate.
    expect(writeBack!.desc ?? '', 'write-back applies approved items in-place').toMatch(
      /Apply EVERY approved item in-place/,
    );
    expect(writeBack!.desc ?? '', 'write-back emits no review items').toMatch(
      /Emits NO review items/,
    );
    expect(writeBack!.desc ?? '', 'write-back never files a decision per edit').toMatch(
      /NEVER a decision per edit/,
    );

    // The terminal human-review step is the "merge in changes" gate — modelled on
    // sprint/ship's human-review, but eval-exempt (snapshotRunForEval skips compound).
    const humanReview = steps.find((s) => s.id === 'human-review');
    expect(humanReview, 'compound has a terminal human-review step').toBeDefined();
    expect(humanReview!.agent, 'human-review is a human gate').toBe('human');
    expect(humanReview!.human, 'human-review is a human: true gate').toBe(true);
    expect(humanReview!.desc ?? '', 'human-review is the merge-in-changes gate').toMatch(
      /merge in changes/i,
    );
    // human-review must be the LAST step (the terminal merge gate).
    expect(steps[steps.length - 1]!.id, 'human-review is the terminal step').toBe('human-review');
  });

  it('ship is planner (idea → epics → tasks) concatenated with sprint to integration', () => {
    const ship = buildBuiltInWorkflows().find((d) => d.name === 'ship');
    expect(ship, 'ship descriptor present').toBeDefined();
    expect(ship!.path, 'ship path').toMatch(/ship\.md$/);
    const body = readFileSync(ship!.path, 'utf-8');
    expect(body.trim().length, 'ship prompt body non-empty').toBeGreaterThan(0);
  });

  it('planner and ship preserve stub expansion and adversarial-review ordering', () => {
    const designOrder = [
      'context',
      'approve-idea',
      'expand-spec',
      'ui-prototype',
      'architecture',
      'adversarial-review',
      'approve-design',
    ];

    for (const name of ['planner', 'ship'] as const) {
      const stepIds = WORKFLOW_DEFINITIONS[name].phases.flatMap((phase) =>
        phase.steps.map((step) => step.id),
      );
      expect(stepIds.filter((stepId) => designOrder.includes(stepId)), name).toEqual(designOrder);
    }
  });

  it('ship definition has 6 phases, 17 steps, unique ids, and canonical/human agents', () => {
    const def = WORKFLOW_DEFINITIONS.ship;
    expect(def, 'WORKFLOW_DEFINITIONS.ship present').toBeDefined();
    expect(def.id).toBe('ship');

    // 6 phases in the locked Ship DAG: plan, refine, materialize, sprint-plan,
    // execute, verify.
    expect(def.phases).toHaveLength(6);
    const phaseIds = def.phases.map((p) => p.id);
    expect(phaseIds).toEqual(['plan', 'refine', 'materialize', 'sprint-plan', 'execute', 'verify']);
    // Phase ids are globally unique.
    expect(new Set(phaseIds).size, 'phase ids are unique').toBe(phaseIds.length);

    // 17 steps total, with globally-unique step ids.
    const steps = def.phases.flatMap((p) => p.steps);
    expect(steps).toHaveLength(17);
    const stepIds = steps.map((s) => s.id);
    expect(new Set(stepIds).size, 'step ids are globally unique').toBe(stepIds.length);

    // Every step.agent is either a canonical agent key or the human gate.
    const validAgents = new Set<string>([...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]);
    for (const step of steps) {
      expect(
        validAgents.has(step.agent),
        `step ${step.id} agent "${step.agent}" must be a canonical key or '${HUMAN_GATE_AGENT}'`,
      ).toBe(true);
    }
  });

  it('verify-setup definition is 1 phase / 5 steps: inspect → derive → approve-runbook → prove → human-review', () => {
    const def = WORKFLOW_DEFINITIONS['verify-setup'];
    expect(def, "WORKFLOW_DEFINITIONS['verify-setup'] present").toBeDefined();
    expect(def.id).toBe('verify-setup');

    // ONE phase, mirroring compound's single-phase shape (the flow this one is
    // modelled on 1:1 — propose → gate → apply → terminal merge gate).
    expect(def.phases).toHaveLength(1);
    expect(def.phases[0]!.id).toBe('verify-setup');
    expect(def.phases[0]!.label).toBe('Verify Setup');
    expect(def.phases[0]!.color, 'phase color is a 7-char hex').toMatch(/^#[0-9a-f]{6}$/);

    const steps = def.phases.flatMap((p) => p.steps);
    expect(steps.map((s) => s.id)).toEqual([
      'inspect',
      'derive',
      'approve-runbook',
      'prove',
      'human-review',
    ]);

    // Every step.agent is either a canonical agent key or the human gate — and the
    // three working steps all bind the ONE verify-setup agent.
    const validAgents = new Set<string>([...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]);
    for (const step of steps) {
      expect(
        validAgents.has(step.agent),
        `step ${step.id} agent "${step.agent}" must be a canonical key or '${HUMAN_GATE_AGENT}'`,
      ).toBe(true);
    }
    for (const id of ['inspect', 'derive', 'prove']) {
      expect(steps.find((s) => s.id === id)!.agent, `${id} binds the verify-setup agent`).toBe(
        'verify-setup',
      );
    }

    // EXACTLY two human gates, both workflow steps: approve-runbook (before
    // anything touches the repo) and the terminal human-review merge gate.
    const gates = steps.filter((s) => s.human === true);
    expect(gates.map((s) => s.id)).toEqual(['approve-runbook', 'human-review']);
    for (const gate of gates) {
      expect(gate.agent, `${gate.id} is a human gate`).toBe(HUMAN_GATE_AGENT);
    }
    expect(steps[steps.length - 1]!.id, 'human-review is the terminal step').toBe('human-review');

    // The programmatic step prompt is built from desc + outputArtifact, so the
    // proposal artifact MUST be a declared step output — otherwise a programmatic
    // run never mints the doc the approve-runbook gate reviews (the exact gap that
    // once shipped a doc-less compound run).
    const derive = steps.find((s) => s.id === 'derive')!;
    // 'verify-runbook', NOT 'compound-recommendations'. The atype the proposal was
    // first shipped under is a Compound deliverable, and migration 097 minted
    // 'verify-runbook' precisely to stop mislabeling it as one at the gate where a
    // human approves repo changes. The atype is also load-bearing on the
    // programmatic plane: composeStepPrompt's artifactFollowUp switches on it, so
    // the stale value handed `derive` COMPOUND's instructions (delegate to
    // cyboflow-compounder, compose `## Act on` / `## Discarded`) and produced a
    // runbook proposal shaped as a compound report (observed live 2026-08-27).
    expect(derive.outputArtifact?.atype).toBe('verify-runbook');
    expect(derive.outputArtifact?.label).toBe('Runbook proposal');
  });

  it('verify-setup step descs pin the contract: levers not values, no installs, engine-owned proof', () => {
    const steps = WORKFLOW_DEFINITIONS['verify-setup'].phases.flatMap((p) => p.steps);
    const descOf = (id: string): string => steps.find((s) => s.id === id)!.desc ?? '';

    // inspect probes for the isolation levers + the existing runbook, from evidence.
    expect(descOf('inspect'), 'inspect probes the isolation levers').toMatch(
      /isolation levers/i,
    );
    expect(descOf('inspect'), 'inspect reads the existing runbook + its status').toMatch(
      /verify-runbook\.json/,
    );

    // derive drafts TEMPLATES (levers, never resolved values) and never an install.
    expect(descOf('derive'), 'derive drafts the portable half as templates').toMatch(
      /\$\{PORT\}/,
    );
    expect(descOf('derive'), 'derive forbids install/rebuild commands').toMatch(
      /never an install or native-rebuild command/i,
    );
    expect(descOf('derive'), 'derive requires an attestation spec per modality').toMatch(
      /attestation/i,
    );
    // The rung ladder: rung 2 is proposed, NEVER auto-applied.
    expect(descOf('derive'), 'derive names the rung ladder').toMatch(
      /rung 0[\s\S]*rung 1[\s\S]*rung 2/i,
    );
    expect(descOf('derive'), 'a rung-2 diff is never auto-applied').toMatch(/NEVER auto-applied/);

    // prove proves BY RUNNING, and the flow never marks proven itself.
    expect(descOf('prove'), 'prove fires a setup-proof verification').toMatch(
      /cyboflow_request_verification/,
    );
    expect(descOf('prove'), 'prove blocks on the verdict').toMatch(
      /cyboflow_await_verification/,
    );
    expect(descOf('prove'), 'prove registers each declared modality').toMatch(
      /cyboflow_register_verify_runbook/,
    );
    expect(descOf('prove'), 'the ENGINE marks proven, never the flow').toMatch(
      /never this flow/i,
    );
    // Exhaustion keeps the draft — never a dead end (§5.3 unproven-draft).
    expect(descOf('prove'), 'exhaustion keeps the unproven draft').toMatch(
      /keep the unproven draft/i,
    );
    expect(descOf('prove'), 'exhaustion is never a dead end').toMatch(/never a dead end/i);
  });

  it('verify-setup prose contracts the runbook split, the rung ladder, and the §3.2 skip CTA', () => {
    const descriptor = buildBuiltInWorkflows().find((d) => d.name === 'verify-setup');
    expect(descriptor, 'verify-setup descriptor present').toBeDefined();
    expect(descriptor!.path, 'verify-setup path').toMatch(/verify-setup\.md$/);
    // Collapse wrapped-prose whitespace so multi-word phrases match regardless of
    // where markdown line-wrapping falls.
    const raw = readFileSync(descriptor!.path, 'utf-8');
    const flat = raw.replace(/\s+/g, ' ');

    // Both human gates run INLINE via AskUserQuestion; nothing self-approves.
    expect(raw, 'verify-setup must name AskUserQuestion').toMatch(/AskUserQuestion/);
    expect(flat, 'verify-setup forbids silently passing a gate').toMatch(
      /never silently (pass|proceed past) a gate/i,
    );

    // The three MCP seams the flow drives, by name.
    expect(raw).toMatch(/cyboflow_register_verify_runbook/);
    expect(raw).toMatch(/cyboflow_request_verification/);
    expect(raw).toMatch(/cyboflow_await_verification/);
    expect(flat, 'setup proofs are budget-exempt + lower priority').toMatch(
      /exempt from the project's lifetime judge budget/i,
    );

    // §5.3 runbook contract: split halves, request-scoped values never persisted,
    // attestation REQUIRED per modality.
    expect(flat, 'the portable half is committed').toMatch(/Committed-portable/);
    expect(flat, 'the machine-local half is a project-row record').toMatch(/Machine-local/);
    expect(flat, 'request-scoped values are never persisted').toMatch(
      /Request-scoped values are NEVER persisted/,
    );
    expect(flat, 'attestation is required per modality').toMatch(
      /Attestation is REQUIRED per modality/,
    );

    // §5.1 rung ladder, with rung 2 never auto-applied.
    expect(flat).toMatch(/Rung 0 — existing levers only/);
    expect(flat).toMatch(/Rung 1 — config-only/);
    expect(flat).toMatch(/Rung 2 — a proposed diff/);
    expect(flat, 'rung 2 is never auto-applied').toMatch(/\*\*never\s+auto-applied\*\*/);

    // §7.2: install/rebuild commands are runner-rejected, not merely discouraged.
    expect(flat, 'no install or rebuild, ever').toMatch(/Never an install or a rebuild/);

    // §3.2: an unproven project's build/serve verifications SKIP with a CTA until
    // this flow proves a runbook — the reason this flow exists at all.
    expect(flat, 'unproven ⇒ build/serve requests are skipped, not attempted').toMatch(
      /would have to \*\*build or serve\*\* the deliverable is \*\*skipped\*\*, not attempted/,
    );
    expect(flat, 'the skip carries the setup CTA').toMatch(
      /no proven verification runbook for this project \(run verification setup\)/,
    );

    // Proof-by-running is engine-enforced: the flow never marks its own runbook proven.
    expect(flat, 'the flow never marks a runbook proven').toMatch(
      /You never mark a runbook proven/,
    );
  });

  it('verify-setup subagent persona: evidence-only, no installs, no hardcoded ports, no self-proof', () => {
    const descriptor = buildBuiltInWorkflows().find((d) => d.name === 'verify-setup')!;
    const agentPath = join(dirname(descriptor.path), 'verify-setup', 'agents', 'verify-setup.md');
    const flat = readFileSync(agentPath, 'utf-8').replace(/\s+/g, ' ');

    expect(flat, 'the persona reads the project from evidence').toMatch(
      /evidence, never inference/i,
    );
    expect(flat, 'a command nobody documented does not exist').toMatch(
      /A command you cannot find written down does not exist/,
    );
    expect(flat, 'never installs or rebuilds').toMatch(/Never install, never rebuild/);
    expect(flat, 'never hardcodes a port or a temp dir').toMatch(
      /Never hardcode a port, a temp dir, or an absolute path/,
    );
    expect(flat, 'never claims a runbook works — proving is a separate step').toMatch(
      /Never claim a runbook works/,
    );
    expect(flat, 'the persona writes no cyboflow state and no repo files').toMatch(
      /Never write cyboflow state, never write repo files, never commit/,
    );

    // Single-writer invariant: a bundled agent body must never name a `cyboflow_*`
    // write tool (validateAgentDraft rejects one, so an edited copy would fail).
    expect(flat, 'no cyboflow_* tool tokens in an agent body').not.toMatch(/cyboflow_/);
  });

  // Dogfood findings 1 + 2 (2026-07-31). Left to PROSE, the drafting agent
  // reverse-engineered VerifyRunbookV1 by grepping cyboflow's own source (which
  // exists on no other machine) and, before it found the types, invented an
  // attestation kind — `static-file-by-construction`, arguing no nonce was
  // needed because "the runner owns the dir and leases ${PORT}", which is
  // exactly the reasoning §7.1 exists to defeat. Both prompts now carry the
  // literal contract; these assertions are the regression guard, since a prompt
  // edit that quietly drops it reproduces the finding with no test failing.
  it('both verify-setup prompts embed the literal VerifyRunbookV1 + AttestationSpec contract', () => {
    const descriptor = buildBuiltInWorkflows().find((d) => d.name === 'verify-setup')!;
    const orchestrator = readFileSync(descriptor.path, 'utf-8');
    const subagent = readFileSync(
      join(dirname(descriptor.path), 'verify-setup', 'agents', 'verify-setup.md'),
      'utf-8',
    );

    for (const [label, body] of [['orchestrator', orchestrator], ['subagent', subagent]] as const) {
      // The wrapper shape the draft missed entirely: no `version`, no
      // `modalities` map, so parseVerifyRunbookV1 died on "expected literal 1".
      expect(body, `${label}: declares the version literal`).toMatch(/version: 1/);
      expect(body, `${label}: declares the modalities map`).toMatch(/modalities/);
      // The exact field names the draft got wrong (`command`, `readiness`, `type`).
      expect(body, `${label}: names serve.cmd literally`).toMatch(/serve\.cmd/);
      expect(body, `${label}: names serve.readyWhen literally`).toMatch(/readyWhen/);
      expect(body, `${label}: names attestation.kind literally`).toMatch(/attestation\.kind/);
      // `behaviors` is NOT a runbook field — the draft added one.
      expect(body, `${label}: says behaviors is not a runbook field`).toMatch(/behaviors/i);
      // All five attestation kinds, so none has to be guessed.
      for (const kind of ['http-endpoint', 'dom-marker', 'cdp-token', 'window-identity', 'file-identity']) {
        expect(body, `${label}: names the '${kind}' attestation kind`).toContain(kind);
      }
      // The specific wrong turn: file-identity claimed for a served static site.
      expect(body, `${label}: closes the file-identity loophole for a served deliverable`).toMatch(
        /file-identity/,
      );
    }
  });
});
