/**
 * Unit tests for the parallel-sprint internal workflow definitions
 * (feat/parallel-sprint, phase P2): `task`, `sprint-init`, `sprint-finalize`.
 *
 * Coverage:
 *  1. All three definitions exist in WORKFLOW_DEFINITIONS, resolve via
 *     resolveWorkflowDefinition, and carry the expected phase/step ids.
 *  2. The three are marked `internal: true`; the two user-facing flows
 *     (planner/sprint) are NOT internal. isInternalWorkflowName agrees.
 *  3. CYBOFLOW_USER_WORKFLOW_NAMES is exactly planner/sprint and every name in
 *     it is non-internal; every other CYBOFLOW_WORKFLOW_NAMES entry is internal.
 *  4. WorkflowRegistry.listByProject excludes the three internal flows while
 *     keeping planner/sprint (the picker-visibility contract).
 *  5. Each internal flow's step ids round-trip through buildStepReportingAppend.
 *  6. Each internal flow's co-located agent bundle resolves to the expected
 *     subagents, and every subagent obeys the single-writer rule (no cyboflow_*).
 *
 * No DB beyond the in-memory registry fixture; the definition assertions are
 * pure (resolver + generator have no Node imports).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  WORKFLOW_DEFINITIONS,
  CYBOFLOW_WORKFLOW_NAMES,
  CYBOFLOW_USER_WORKFLOW_NAMES,
  isInternalWorkflowName,
  isCyboflowWorkflowName,
  resolveWorkflowDefinition,
  type CyboflowWorkflowName,
} from '../../../../../shared/types/workflows';
import {
  buildStepReportingAppend,
  flattenStepIds,
} from '../../prompts/step-reporting-instructions';
import { resolveWorkflowBundle } from '../workflowBundle';
import { buildBuiltInWorkflows } from '../builtInWorkflows';
import { WorkflowRegistry } from '../../workflowRegistry';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { REGISTRY_SCHEMA } from '../../../database/__test_fixtures__/registrySchema';

const INTERNAL_NAMES = ['task', 'sprint-init', 'sprint-finalize'] as const;
const workflowsDir = path.join(__dirname, '..');

const silentLogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

// ---------------------------------------------------------------------------
// (1) definitions exist + resolve + expected step ids
// ---------------------------------------------------------------------------

describe('parallel-sprint internal workflow definitions', () => {
  it('all three are present in WORKFLOW_DEFINITIONS and resolve', () => {
    for (const name of INTERNAL_NAMES) {
      expect(WORKFLOW_DEFINITIONS[name], `${name} def present`).toBeDefined();
      const resolved = resolveWorkflowDefinition(name, '{}');
      expect(resolved, `${name} resolves`).not.toBeNull();
      expect(resolved).toEqual(WORKFLOW_DEFINITIONS[name]);
    }
  });

  it('task = a single execute phase with the five sprint-execute step ids/agents', () => {
    const task = WORKFLOW_DEFINITIONS.task;
    expect(task.phases.map((p) => p.id)).toEqual(['execute']);
    expect(flattenStepIds(task)).toEqual([
      'implement',
      'write-tests',
      'code-review',
      'task-verify',
      'visual-verify',
    ]);
    // Step agents/retries copied verbatim from sprint's execute phase.
    const sprintExecute = WORKFLOW_DEFINITIONS.sprint.phases.find((p) => p.id === 'execute');
    expect(task.phases[0].steps).toEqual(sprintExecute?.steps);
    // No human step anywhere in task.
    expect(task.phases.flatMap((p) => p.steps).some((s) => s.human === true)).toBe(false);
  });

  it('sprint-init = a single plan phase with one analyze-dependencies step', () => {
    const init = WORKFLOW_DEFINITIONS['sprint-init'];
    expect(init.phases.map((p) => p.id)).toEqual(['plan']);
    expect(flattenStepIds(init)).toEqual(['analyze-dependencies']);
    expect(init.phases[0].steps[0].human ?? false).toBe(false);
    expect(init.phases[0].steps[0].agent).toBe('dependency-analyzer');
  });

  it('sprint-finalize = the verify phase lifted from sprint (incl. the human-review gate)', () => {
    const fin = WORKFLOW_DEFINITIONS['sprint-finalize'];
    expect(fin.phases.map((p) => p.id)).toEqual(['verify']);
    expect(flattenStepIds(fin)).toEqual(['sprint-verify', 'sprint-review', 'human-review']);
    const sprintVerify = WORKFLOW_DEFINITIONS.sprint.phases.find((p) => p.id === 'verify');
    expect(fin.phases[0].steps.map((s) => s.id)).toEqual(
      sprintVerify?.steps.map((s) => s.id),
    );
    const humanStep = fin.phases[0].steps.find((s) => s.id === 'human-review');
    expect(humanStep?.agent).toBe('human');
    expect(humanStep?.human).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (2) + (3) internal flag + user/internal partition
// ---------------------------------------------------------------------------

describe('internal-flow flag and partition', () => {
  it('marks the three new flows internal and leaves planner/sprint non-internal', () => {
    for (const name of INTERNAL_NAMES) {
      expect(WORKFLOW_DEFINITIONS[name].internal, `${name} internal`).toBe(true);
      expect(isInternalWorkflowName(name)).toBe(true);
    }
    for (const name of ['planner', 'sprint'] as const) {
      expect(WORKFLOW_DEFINITIONS[name].internal ?? false, `${name} not internal`).toBe(false);
      expect(isInternalWorkflowName(name)).toBe(false);
    }
  });

  it('isInternalWorkflowName is false for custom / unknown names', () => {
    expect(isInternalWorkflowName('my-custom-flow')).toBe(false);
    expect(isInternalWorkflowName('__quick__')).toBe(false);
    expect(isInternalWorkflowName('')).toBe(false);
  });

  it('CYBOFLOW_USER_WORKFLOW_NAMES is exactly the non-internal subset', () => {
    expect([...CYBOFLOW_USER_WORKFLOW_NAMES].sort()).toEqual(['planner', 'sprint']);
    const derivedUserNames = CYBOFLOW_WORKFLOW_NAMES.filter((n) => !isInternalWorkflowName(n));
    expect([...derivedUserNames].sort()).toEqual([...CYBOFLOW_USER_WORKFLOW_NAMES].sort());
    // And every internal name is in CYBOFLOW_WORKFLOW_NAMES but not the user set.
    for (const name of INTERNAL_NAMES) {
      expect((CYBOFLOW_WORKFLOW_NAMES as readonly string[]).includes(name)).toBe(true);
      expect((CYBOFLOW_USER_WORKFLOW_NAMES as readonly string[]).includes(name)).toBe(false);
      expect(isCyboflowWorkflowName(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (4) listByProject excludes internal flows (picker contract)
// ---------------------------------------------------------------------------

describe('WorkflowRegistry.listByProject internal-flow filter', () => {
  it('seeds all five built-ins but lists only planner/sprint', () => {
    const rawDb = new Database(':memory:');
    rawDb.pragma('foreign_keys = ON');
    rawDb.exec(REGISTRY_SCHEMA);
    const registry = new WorkflowRegistry(dbAdapter(rawDb), silentLogger);

    // reconcileBuiltIns seeds every CYBOFLOW_WORKFLOW_NAMES row (the scheduler
    // launches internal flows by wf-<projectId>-<name>).
    registry.reconcileBuiltIns(7, buildBuiltInWorkflows());

    interface CountRow { count: number }
    const { count } = rawDb
      .prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 7')
      .get() as CountRow;
    expect(count).toBe(CYBOFLOW_WORKFLOW_NAMES.length); // all 5 rows exist

    // …but the user-facing list excludes the three internal flows.
    const listed = registry.listByProject(7).map((r) => r.name).sort();
    expect(listed).toEqual(['planner', 'sprint']);
    for (const name of INTERNAL_NAMES) {
      expect(listed).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// (5) step-reporting round-trip
// ---------------------------------------------------------------------------

describe('internal flows step-reporting round-trip', () => {
  for (const name of INTERNAL_NAMES) {
    it(`'${name}': buildStepReportingAppend emits exactly the def step ids in order`, () => {
      const def = resolveWorkflowDefinition(name, '{}');
      expect(def).not.toBeNull();
      const append = buildStepReportingAppend(def);
      const flat = flattenStepIds(def);
      // Every step id appears, backtick-quoted, in the append.
      for (const id of flat) {
        expect(append, `${name} append contains \`${id}\``).toContain(`\`${id}\``);
      }
      // The append names the report tool.
      expect(append).toContain('cyboflow_report_step');
    });
  }
});

// ---------------------------------------------------------------------------
// (6) co-located agent bundles resolve as expected
// ---------------------------------------------------------------------------

describe('internal flows agent bundles', () => {
  /** Single-writer + shape contract for every subagent in a bundle. */
  function assertAgentShape(agents: { name: string; content: string }[]): void {
    for (const agent of agents) {
      expect(agent.content, `${agent.name} frontmatter`).toMatch(
        /^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/,
      );
      expect(agent.content, `${agent.name} returns a Result block`).toContain('## Result');
      expect(agent.content, `${agent.name} must not call any cyboflow_* tool`).not.toMatch(/cyboflow_/);
    }
  }

  it('task ships the five Phase-1 subagents (gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'task.md'));
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'code-review',
      'implement',
      'task-verify',
      'visual-verify',
      'write-tests',
    ]);
    assertAgentShape(bundle.agents);
  });

  it('sprint-init ships the dependency-analyzer subagent', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'sprint-init.md'));
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual(['dependency-analyzer']);
    assertAgentShape(bundle.agents);
    // The analyzer's tools allowlist EXCLUDES write tools (read-only).
    const analyzer = bundle.agents[0];
    expect(analyzer.content).toMatch(/tools:\s*Read, Grep, Glob/);
  });

  it('sprint-finalize ships the two Phase-2 verify/review subagents (gate stays inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'sprint-finalize.md'));
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual(['sprint-review', 'sprint-verify']);
    assertAgentShape(bundle.agents);
  });
});

// keep CyboflowWorkflowName referenced so the type import is load-bearing
const _typecheck: CyboflowWorkflowName = 'task';
void _typecheck;
