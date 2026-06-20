import { describe, it, expect, vi } from 'vitest';
import { DefaultProgrammaticRunner } from '../defaultProgrammaticRunner';
import type { StepReporter } from '../programmaticRunHost';
import type { HumanGateResolver } from '../humanGate';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, ProgrammaticRunContext } from '../../runExecutor';
import type { WorkflowDefinition, WorkflowRow, WorkflowRunRow } from '../../../../../shared/types/workflows';

function makeSpawner(impl?: () => Promise<void>): ClaudeSpawnerLike {
  return {
    spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<void>>(impl ?? (() => Promise.resolve())),
    abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}
const reporter: StepReporter = { report: vi.fn() };
function gateOf(d: 'approve' | 'reject' | 'revise'): HumanGateResolver {
  return { resolve: vi.fn().mockResolvedValue(d) };
}

/** Build a ProgrammaticRunContext whose workflow.spec_json encodes `def`. */
function ctxFor(def: WorkflowDefinition): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: 'wf',
    project_id: 1,
    name: 'custom',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: JSON.stringify(def),
    created_at: 'now',
  };
  const run: WorkflowRunRow = {
    id: 'run-1',
    workflow_id: 'wf',
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/wt',
    branch_name: null,
    created_at: 'now',
    updated_at: 'now',
  };
  return {
    runId: 'run-1',
    panelId: 'run-1',
    sessionId: 'run-1',
    worktreePath: '/wt',
    run,
    workflow,
    signal: new AbortController().signal,
  };
}

function oneStepDef(): WorkflowDefinition {
  return { id: 'd', phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: 'a', name: 'A', agent: 'executor', mcps: [], retries: 0 }] }] };
}
function gateDef(): WorkflowDefinition {
  return { id: 'd', phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: 'g', name: 'Gate', agent: 'human', mcps: [], retries: 0, human: true }] }] };
}

describe('DefaultProgrammaticRunner', () => {
  it('resolves (rests the run) when the controller completes', async () => {
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('approve') });
    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();
  });

  it('throws when a required step fails (so RunExecutor marks the run failed)', async () => {
    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(() => Promise.reject(new Error('boom'))),
      reporter,
      gate: gateOf('approve'),
    });
    await expect(runner.run(ctxFor(oneStepDef()))).rejects.toThrow("failed at step 'a'");
  });

  it('resolves (does NOT throw) when a human gate is rejected — a terminal human decision, not a failure', async () => {
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('reject') });
    await expect(runner.run(ctxFor(gateDef()))).resolves.toBeUndefined();
  });

  it('throws when the run has no resolvable workflow definition', async () => {
    const ctx = ctxFor(oneStepDef());
    const badCtx: ProgrammaticRunContext = {
      ...ctx,
      workflow: { ...ctx.workflow, name: 'not-a-builtin', spec_json: 'not json' },
    };
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('approve') });
    await expect(runner.run(badCtx)).rejects.toThrow('no resolvable workflow definition');
  });
});
