import { describe, it, expect, vi } from 'vitest';
import { composeStepPrompt, definitionMergesDecomposition } from '../stepPrompt';
import { SpawnStepRunner } from '../spawnStepRunner';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions } from '../../runExecutor';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import { resolveEffectiveDefinition } from '../../../../../shared/tuning/workflowTuning';
import type { WorkflowDefinition, WorkflowStep } from '../../../../../shared/types/workflows';

function def(flow: string, level: 'efficient' | 'standard' | 'thorough'): WorkflowDefinition {
  const d = resolveEffectiveDefinition(flow, null, level);
  if (!d) throw new Error(`no definition for ${flow}/${level}`);
  return d;
}

function findStep(d: WorkflowDefinition, id: string): WorkflowStep {
  const s = d.phases.flatMap((p) => p.steps).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

const HEADING = '## Task decomposition happens at THIS step';

describe('definitionMergesDecomposition', () => {
  it.each(['planner', 'ship'])('is true for %s at efficient, which drops the tasks step', (flow) => {
    expect(definitionMergesDecomposition(def(flow, 'efficient'))).toBe(true);
  });

  it.each([
    ['planner', 'standard'],
    ['planner', 'thorough'],
    ['ship', 'standard'],
    ['ship', 'thorough'],
    ['launch', 'efficient'],
  ] as const)('is false for %s at %s, which keeps the tasks step', (flow, level) => {
    expect(definitionMergesDecomposition(def(flow, level))).toBe(false);
  });

  it('is false for a flow with no epics step', () => {
    expect(definitionMergesDecomposition(def('sprint', 'efficient'))).toBe(false);
  });
});

describe('composeStepPrompt — merged decomposition on the epics step', () => {
  it.each(['planner', 'ship'])('%s: tells the epics step to create every idea\'s tasks, small ones included', (flow) => {
    const epics = findStep(def(flow, 'efficient'), 'epics');
    const out = composeStepPrompt({ step: epics, workflowName: flow, attempt: 1, mergedDecomposition: true });
    expect(out).toContain(HEADING);
    expect(out).toMatch(/a `small` idea included/);
    expect(out).toMatch(/cyboflow_create_task/);
    expect(out).toMatch(/Fallback epic first/);
  });

  it('moves the tasks step\'s ledger stamps onto the merged epics step', () => {
    const epics = findStep(def('ship', 'efficient'), 'epics');
    const merged = composeStepPrompt({ step: epics, workflowName: 'ship', attempt: 1, mergedDecomposition: true });
    expect(merged).not.toMatch(/Do NOT stamp the `epics` component here/);
    expect(merged).toMatch(/component: 'stories', state: 'complete'/);
  });

  it('leaves the epics prompt byte-identical when the run keeps its tasks step', () => {
    const epics = findStep(def('ship', 'standard'), 'epics');
    const base = composeStepPrompt({ step: epics, workflowName: 'ship', attempt: 1 });
    expect(composeStepPrompt({ step: epics, workflowName: 'ship', attempt: 1, mergedDecomposition: false })).toBe(base);
    expect(base).not.toContain(HEADING);
    expect(base).toMatch(/Do NOT stamp the `epics` component here/);
  });

  it('adds nothing to steps other than epics, or to flows without the small-idea rule', () => {
    const d = def('ship', 'efficient');
    const context = findStep(d, 'context');
    expect(composeStepPrompt({ step: context, workflowName: 'ship', attempt: 1, mergedDecomposition: true })).toBe(
      composeStepPrompt({ step: context, workflowName: 'ship', attempt: 1 }),
    );
    const launchEpics = findStep(def('launch', 'standard'), 'epics');
    expect(
      composeStepPrompt({ step: launchEpics, workflowName: 'launch', attempt: 1, mergedDecomposition: true }),
    ).not.toContain(HEADING);
  });
});

describe('SpawnStepRunner — mergedDecomposition option', () => {
  async function epicsPrompt(mergedDecomposition: boolean | undefined): Promise<string> {
    const spawner: ClaudeSpawnerLike = {
      spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<CliSpawnOutcome | void>>(() => Promise.resolve()),
      abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const runner = new SpawnStepRunner(spawner, {
      panelId: 'r',
      sessionId: 'r',
      runId: 'r',
      worktreePath: '/wt',
      workflowName: 'ship',
      ...(mergedDecomposition === undefined ? {} : { mergedDecomposition }),
    });
    await runner.runStep(findStep(def('ship', 'efficient'), 'epics'), { runId: 'r', phaseId: 'refine', stepIndex: 0, attempt: 1 });
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    return opts.prompt;
  }

  it('threads the flag into the epics step prompt', async () => {
    expect(await epicsPrompt(true)).toContain(HEADING);
  });

  it('omits the contract when the flag is absent', async () => {
    expect(await epicsPrompt(undefined)).not.toContain(HEADING);
  });
});
