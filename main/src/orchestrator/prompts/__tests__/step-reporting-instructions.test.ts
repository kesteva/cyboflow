/**
 * Unit tests for step-reporting-instructions.ts
 *
 * Behaviors covered (TASK-803 test_strategy):
 *  1. buildStepReportingAppend(resolved def) names `cyboflow_report_step` and
 *     emits the flat step ids in declaration order for the built-in planner and
 *     sprint definitions.
 *  2. Fail-soft: a null definition (and an unknown / non-SoloFlow name via the
 *     name-keyed convenience) returns '' and never throws.
 *  3. No drift: every step id the generator emits for a RESOLVED definition is
 *     ∈ that resolved def's flat steps — for built-ins, for an edited built-in,
 *     and for a fully custom flow. The generator tracks the resolved spec, not
 *     the static WORKFLOW_DEFINITIONS constant.
 *
 * The broader prompt↔definition parity gate (across all five built-ins, plus the
 * frontend forward-jump test) is TASK-804, not here.
 *
 * No DB/IPC/fs — the generator is a pure string builder.
 */
import { describe, it, expect } from 'vitest';
import {
  buildStepReportingAppend,
  buildStepReportingAppendForName,
  flattenStepIds,
} from '../step-reporting-instructions';
import {
  resolveWorkflowDefinition,
  type WorkflowDefinition,
} from '../../../../../shared/types/workflows';

/** Assert `subs` appear in `haystack` in the given order (and all present). */
function expectInOrder(haystack: string, subs: string[]): void {
  let cursor = 0;
  for (const sub of subs) {
    const at = haystack.indexOf(sub, cursor);
    expect(at, `expected to find '${sub}' at/after index ${cursor}`).toBeGreaterThanOrEqual(0);
    cursor = at + sub.length;
  }
}

describe('buildStepReportingAppend', () => {
  // -------------------------------------------------------------------------
  // planner — ordered ids + cyboflow_report_step
  // -------------------------------------------------------------------------
  it('emits cyboflow_report_step and the planner flat step ids in order', () => {
    const def = resolveWorkflowDefinition('planner', '{}');
    const append = buildStepReportingAppend(def);

    expect(append).toContain('cyboflow_report_step');
    expectInOrder(append, [
      '`context`',
      '`research`',
      '`approve-idea`',
      '`epics`',
      '`tasks`',
      '`approve-plan`',
    ]);
  });

  it('matches the name-keyed convenience for the built-in planner', () => {
    const def = resolveWorkflowDefinition('planner', '{}');
    expect(buildStepReportingAppendForName('planner')).toBe(buildStepReportingAppend(def));
  });

  // -------------------------------------------------------------------------
  // sprint — ordered ids
  // -------------------------------------------------------------------------
  it('emits the sprint flat step ids in order from implement to human-review', () => {
    const def = resolveWorkflowDefinition('sprint', '{}');
    const append = buildStepReportingAppend(def);

    expect(append).toContain('cyboflow_report_step');
    expectInOrder(append, [
      '`implement`',
      '`write-tests`',
      '`code-review`',
      '`task-verify`',
      '`visual-verify`',
      '`sprint-verify`',
      '`sprint-review`',
      '`human-review`',
    ]);
  });

  // -------------------------------------------------------------------------
  // documents the v1 subagent limitation
  // -------------------------------------------------------------------------
  it('documents the v1 main-session-only subagent limitation', () => {
    const append = buildStepReportingAppendForName('sprint');
    expect(append.toLowerCase()).toContain('subagent');
    expect(append.toLowerCase()).toContain('observational');
  });

  // -------------------------------------------------------------------------
  // fail-soft — null def + unknown name
  // -------------------------------------------------------------------------
  it('returns "" for a null definition and does not throw', () => {
    expect(buildStepReportingAppend(null)).toBe('');
  });

  it('returns "" for an unknown / non-SoloFlow workflow name and does not throw', () => {
    // resolveWorkflowDefinition('not-a-workflow', '{}') is null → fail-soft.
    expect(buildStepReportingAppendForName('not-a-workflow')).toBe('');
    expect(() => buildStepReportingAppendForName('not-a-workflow')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // no drift — emitted ids ∈ resolved def's flat steps (built-in, edited, custom)
  // -------------------------------------------------------------------------
  it('every emitted id is ∈ the RESOLVED def flat steps for each built-in', () => {
    for (const name of ['soloflow', 'planner', 'sprint', 'compound', 'prune'] as const) {
      const def = resolveWorkflowDefinition(name, '{}');
      expect(def, `built-in '${name}' must resolve`).not.toBeNull();
      const flat = flattenStepIds(def);
      const append = buildStepReportingAppend(def);
      for (const id of flat) {
        expect(append, `'${name}' append must contain id '${id}'`).toContain(`\`${id}\``);
      }
      // And the generator emits exactly the resolved flat set (no extra ids).
      const emitted = flat.filter((id) => append.includes(`\`${id}\``));
      expect(emitted).toEqual(flat);
    }
  });

  it('tracks an EDITED built-in def, not the static constant', () => {
    // Edit the built-in planner: rename `context` → `kickoff`, drop `research`.
    const base = resolveWorkflowDefinition('planner', '{}') as WorkflowDefinition;
    const edited: WorkflowDefinition = {
      ...base,
      phases: base.phases.map((phase, i) =>
        i === 0
          ? {
              ...phase,
              steps: phase.steps
                .filter((s) => s.id !== 'research')
                .map((s) => (s.id === 'context' ? { ...s, id: 'kickoff' } : s)),
            }
          : phase,
      ),
    };
    const resolved = resolveWorkflowDefinition('planner', JSON.stringify(edited));
    const flat = flattenStepIds(resolved);
    const append = buildStepReportingAppend(resolved);

    // Tracks the edit: new id present, removed id absent, static id absent.
    expect(append).toContain('`kickoff`');
    expect(append).not.toContain('`research`');
    expect(append).not.toContain('`context`');
    // Every emitted id ∈ the resolved (edited) def's flat steps.
    for (const id of flat) {
      expect(append).toContain(`\`${id}\``);
    }
    expect(flat).toEqual(['kickoff', 'approve-idea', 'epics', 'tasks', 'approve-plan']);
  });

  it('tracks a fully CUSTOM flow def whose ids are user-authored', () => {
    const custom: WorkflowDefinition = {
      id: 'my-custom-flow',
      phases: [
        {
          id: 'discovery',
          label: 'Discovery',
          color: '#3b6dd6',
          steps: [
            { id: 'gather', name: 'Gather', agent: 'researcher', mcps: [], retries: 0 },
            { id: 'synthesize', name: 'Synthesize', agent: 'researcher', mcps: [], retries: 0 },
          ],
        },
        {
          id: 'ship',
          label: 'Ship',
          color: '#c96442',
          steps: [{ id: 'deploy', name: 'Deploy', agent: 'executor', mcps: [], retries: 0 }],
        },
      ],
    };
    const resolved = resolveWorkflowDefinition('my-custom-flow', JSON.stringify(custom));
    const flat = flattenStepIds(resolved);
    const append = buildStepReportingAppend(resolved);

    expect(flat).toEqual(['gather', 'synthesize', 'deploy']);
    for (const id of flat) {
      expect(append).toContain(`\`${id}\``);
    }
    expectInOrder(append, ['`gather`', '`synthesize`', '`deploy`']);
  });

  it('returns "" for a custom-flow name with a broken/empty spec (fail-soft)', () => {
    // Custom name + no usable spec → resolveWorkflowDefinition returns null.
    expect(buildStepReportingAppend(resolveWorkflowDefinition('my-custom-flow', '{}'))).toBe('');
    expect(buildStepReportingAppend(resolveWorkflowDefinition('my-custom-flow', 'not json'))).toBe(
      '',
    );
  });
});
