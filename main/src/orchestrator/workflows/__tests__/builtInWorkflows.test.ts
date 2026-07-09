/**
 * Unit tests for buildBuiltInWorkflows() — the in-repo built-in workflow
 * descriptors that severed the SoloFlow plugin-cache dependency (P0).
 *
 * Coverage:
 *  1. Maps EXACTLY the three cyboflow built-in names (planner + sprint +
 *     compound), keyed by CYBOFLOW_WORKFLOW_NAMES.
 *  2. Each descriptor path points at an existing, readable, non-empty `.md`
 *     prompt body alongside the module.
 *  3. The prompt bodies are self-contained: no `.soloflow` / `IDEA-NNN.md` /
 *     `TASK-NNN.md` references.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildBuiltInWorkflows } from '../builtInWorkflows';
import { CYBOFLOW_WORKFLOW_NAMES, WORKFLOW_DEFINITIONS } from '../../../../../shared/types/workflows';
import { CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT } from '../../../../../shared/types/agentIdentity';

describe('buildBuiltInWorkflows', () => {
  it('maps exactly the cyboflow built-in names (planner + sprint + compound + ship)', () => {
    const descriptors = buildBuiltInWorkflows();
    const names = descriptors.map((d) => d.name).sort();
    expect(names).toEqual(['compound', 'planner', 'ship', 'sprint']);
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
      const frontmatterMatch = body.match(/^---\n([\s\S]*?)\n---/);
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
    expect(body, 'compound proposes doc edits as blocking decision items').toMatch(/decision/);
    expect(body, "compound must never emit kind:'finding' (a finding is its input)").toMatch(
      /finding is Compound's input/i,
    );
  });

  it('ship is planner (idea → epics → tasks) concatenated with sprint to integration', () => {
    const ship = buildBuiltInWorkflows().find((d) => d.name === 'ship');
    expect(ship, 'ship descriptor present').toBeDefined();
    expect(ship!.path, 'ship path').toMatch(/ship\.md$/);
    const body = readFileSync(ship!.path, 'utf-8');
    expect(body.trim().length, 'ship prompt body non-empty').toBeGreaterThan(0);
  });

  it('ship definition has 6 phases, 15 steps, unique ids, and canonical/human agents', () => {
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

    // 15 steps total, with globally-unique step ids.
    const steps = def.phases.flatMap((p) => p.steps);
    expect(steps).toHaveLength(15);
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
});
