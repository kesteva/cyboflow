/**
 * Unit tests for fan-out-instructions.ts — the pure generator that derives the
 * per-run fan-out execution instruction block from a resolved WorkflowDefinition's
 * `fanOut` specs.
 *
 * Behaviors covered:
 *  1. Canonical 5-step chain + no explicit maxConcurrency → the default cap (5),
 *     DAG-wave + same-file-guard dispatch, all 5 lane ids + all 5 `cyboflow-<agent>`
 *     names, the awaiting-verify park, and the loopback/attempt protocol.
 *  2. Explicit maxConcurrency 3 → "at most 3" and no cap-5 text.
 *  3. maxConcurrency 1 → strictly-serial dispatch (no DAG waves / same-file guard).
 *  4. A custom 2-step chain (custom ids, one explicit loopback + one defaulted)
 *     → the generic fallback texture, the explicit loopback target, and the
 *     first-inner-step default loopback.
 *  5. Fail-soft: a def with no fanOut-bearing step, and a `null` def, both → ''.
 *
 * The module is pure (no fs/DB/Electron, no Date/random) so output is asserted
 * directly.
 */
import { describe, it, expect } from 'vitest';
import { buildFanOutAppend } from '../fan-out-instructions';
import { WORKFLOW_DEFINITIONS, type WorkflowDefinition } from '../../../../../shared/types/workflows';

/**
 * Build a single-phase def whose one step declares the canonical sprint fan-out
 * chain, with an overridable `maxConcurrency`.
 */
function canonicalFanOutDef(maxConcurrency?: number): WorkflowDefinition {
  return {
    id: 'sprint-fixture',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: ['filesystem'],
            retries: 3,
            fanOut: {
              over: 'tasks',
              ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
              inner: [
                { id: 'implement', agent: 'implement', name: 'Implement' },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
                { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
                {
                  id: 'visual-verify',
                  agent: 'visual-verify',
                  name: 'Visual check',
                  optional: true,
                  loopback: 'implement',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * A custom 2-step fan-out over a non-'tasks' source: `alpha` carries an EXPLICIT
 * loopback to `beta`; `beta` has no loopback, so it defaults to the first inner
 * step (`alpha`).
 */
function customFanOutDef(): WorkflowDefinition {
  return {
    id: 'custom-fixture',
    phases: [
      {
        id: 'run',
        label: 'Run',
        color: '#3b6dd6',
        steps: [
          {
            id: 'do-each',
            name: 'Do each item',
            agent: 'alpha-agent',
            mcps: [],
            retries: 0,
            fanOut: {
              over: 'items',
              inner: [
                { id: 'alpha', agent: 'alpha-agent', name: 'Alpha', loopback: 'beta' },
                { id: 'beta', agent: 'beta-agent', name: 'Beta' },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('buildFanOutAppend — canonical chain, default cap', () => {
  const block = buildFanOutAppend(canonicalFanOutDef());

  it('governs the fanOut step and names its item source', () => {
    expect(block).toContain('## Fan-out execution — `execute-tasks`');
    expect(block).toContain('one lane per task');
  });

  it('uses the default cap of 5 and DAG-wave + same-file-guard dispatch', () => {
    expect(block).toContain('at most **5**');
    expect(block).toContain('DAG waves');
    expect(block).toContain('same file');
  });

  it('lists all 5 lane ids and all 5 cyboflow-<agent> delegates', () => {
    for (const id of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(block).toContain(`\`${id}\``);
      expect(block).toContain(`cyboflow-${id}`);
    }
  });

  it('parks the visual merge-gate at awaiting-verify', () => {
    expect(block).toContain('awaiting-verify');
    expect(block).toContain('async visual merge-gate');
  });

  it('emits the loopback + attempt protocol', () => {
    expect(block).toContain('Loopback + attempt protocol');
    expect(block).toContain('attempt: <n>');
    expect(block).toContain('Stuck subagents');
    expect(block).toContain('On task success');
  });
});

describe('buildFanOutAppend — explicit maxConcurrency', () => {
  it('cap 3 → "at most 3", and no cap-5 text', () => {
    const block = buildFanOutAppend(canonicalFanOutDef(3));
    expect(block).toContain('at most **3**');
    expect(block).not.toContain('**5**');
  });

  it('cap 1 → strictly serial: no DAG waves / same-file guard', () => {
    const block = buildFanOutAppend(canonicalFanOutDef(1));
    expect(block).toContain('one at a time');
    expect(block).toContain('one lane at a time');
    expect(block).not.toContain('DAG waves');
    expect(block).not.toContain('same file');
  });
});

describe('buildFanOutAppend — custom chain (generic fallback)', () => {
  const block = buildFanOutAppend(customFanOutDef());

  it('names the generic item source for a non-tasks over key', () => {
    expect(block).toContain('the resolved item set (`items`)');
  });

  it('delegates each custom inner step generically with its files-touched context', () => {
    expect(block).toContain('cyboflow-alpha-agent');
    expect(block).toContain('cyboflow-beta-agent');
    expect(block).toContain('running files-touched list');
  });

  it('names the EXPLICIT loopback target (alpha → beta)', () => {
    expect(block).toContain('id `beta`');
  });

  it('defaults a missing loopback to the FIRST inner step (beta → alpha)', () => {
    expect(block).toContain('id `alpha`');
    // The protocol paragraph also documents the first-inner default.
    expect(block).toContain('THE FIRST');
  });
});

describe('buildFanOutAppend — fail-soft', () => {
  it("returns '' for a definition with no fanOut-bearing step (built-in planner)", () => {
    expect(buildFanOutAppend(WORKFLOW_DEFINITIONS.planner)).toBe('');
  });

  it("returns '' for a null definition", () => {
    expect(buildFanOutAppend(null)).toBe('');
  });

  it('emits a section for the built-in sprint definition (real fanOut step)', () => {
    const block = buildFanOutAppend(WORKFLOW_DEFINITIONS.sprint);
    expect(block).toContain('## Fan-out execution — `execute-tasks`');
    expect(block).toContain('at most **5**');
  });
});
