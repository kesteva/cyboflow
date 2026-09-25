import { describe, it, expect, vi } from 'vitest';
import {
  composeDirectStepSystemPrompt,
  DIRECT_STEPS_KILL_SWITCH_ENV,
  resolveStepDispatch,
} from '../stepDispatch';
import { SpawnStepRunner, PROGRAMMATIC_STEP_DISALLOWED_TOOLS } from '../spawnStepRunner';
import { composeStepPrompt } from '../stepPrompt';
import { renderWorkflowPromptForRuntime } from '../../workflowPromptRenderer';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions } from '../../runExecutor';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { ControllerStepContext } from '../types';

const ROLE_PROMPT = 'You are the implement subagent. Return a summary to the orchestrator. Never write cyboflow state.';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: p.id, mcps: [], retries: 0, ...p };
}
const ctx: ControllerStepContext = { runId: 'r', phaseId: 'p', stepIndex: 0, attempt: 1 };

function makeSpawner(): ClaudeSpawnerLike {
  return {
    spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<CliSpawnOutcome | void>>(() => Promise.resolve()),
    abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function spawned(spawner: ClaudeSpawnerLike): ClaudeSpawnerOptions {
  return (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
}

const baseOpts = {
  panelId: 'r',
  sessionId: 'r',
  runId: 'r',
  worktreePath: '/wt',
  workflowName: 'sprint',
  resolveStepRole: (agentKey: string) => (agentKey === 'unknown' ? undefined : { systemPrompt: ROLE_PROMPT }),
};

describe('resolveStepDispatch', () => {
  const args = {
    workflowName: 'sprint',
    stepId: 'implement',
    agentKey: 'implement',
    runtime: 'claude-sdk' as const,
    roleSystemPrompt: ROLE_PROMPT,
    env: {},
  };

  it('is direct by default on claude-sdk and codex-sdk', () => {
    expect(resolveStepDispatch(args).dispatch).toBe('direct');
    expect(resolveStepDispatch({ ...args, runtime: 'codex-sdk' }).dispatch).toBe('direct');
  });

  it('delegates on runtimes that keep their own adapter', () => {
    expect(resolveStepDispatch({ ...args, runtime: 'omp-sdk' }).dispatch).toBe('delegated');
    expect(resolveStepDispatch({ ...args, runtime: 'pi-sdk' }).dispatch).toBe('delegated');
  });

  it('delegates when the role prompt is missing or blank', () => {
    expect(resolveStepDispatch({ ...args, roleSystemPrompt: undefined }).dispatch).toBe('delegated');
    expect(resolveStepDispatch({ ...args, roleSystemPrompt: '   ' }).dispatch).toBe('delegated');
  });

  it('keeps verify-setup prove and every address-review step delegated', () => {
    expect(
      resolveStepDispatch({ ...args, workflowName: 'verify-setup', stepId: 'prove', agentKey: 'verify-setup' }).dispatch,
    ).toBe('delegated');
    // `derive` shares the verify-setup role but is an ordinary drafting step.
    expect(
      resolveStepDispatch({ ...args, workflowName: 'verify-setup', stepId: 'derive', agentKey: 'verify-setup' }).dispatch,
    ).toBe('direct');
    for (const workflowName of ['sprint', 'ship', 'custom-flow']) {
      expect(
        resolveStepDispatch({ ...args, workflowName, stepId: 'fix-findings', agentKey: 'address-review' }).dispatch,
      ).toBe('delegated');
    }
  });

  it('honors the kill switch, and treats "0" and empty as off', () => {
    const decision = resolveStepDispatch({ ...args, env: { [DIRECT_STEPS_KILL_SWITCH_ENV]: '1' } });
    expect(decision.dispatch).toBe('delegated');
    expect(decision.reason).toContain(DIRECT_STEPS_KILL_SWITCH_ENV);
    expect(resolveStepDispatch({ ...args, env: { [DIRECT_STEPS_KILL_SWITCH_ENV]: '0' } }).dispatch).toBe('direct');
    expect(resolveStepDispatch({ ...args, env: { [DIRECT_STEPS_KILL_SWITCH_ENV]: '' } }).dispatch).toBe('direct');
  });
});

describe('composeDirectStepSystemPrompt', () => {
  it('puts the role body first and the governing addendum last', () => {
    const out = composeDirectStepSystemPrompt('implement', ROLE_PROMPT);
    expect(out.indexOf(ROLE_PROMPT)).toBeGreaterThan(-1);
    expect(out.indexOf(ROLE_PROMPT)).toBeLessThan(out.indexOf('# Direct step'));
    expect(out).toContain('`cyboflow-implement`');
    expect(out).toMatch(/YOU are the orchestrator/);
    expect(out).toMatch(/no Task, Agent or Workflow tool, no `spawn_agent`/);
  });
});

describe('composeStepPrompt — direct dispatch', () => {
  const s = step({ id: 'implement', agent: 'implement' });

  it('tells the turn to do the work itself, never to delegate', () => {
    const out = composeStepPrompt({ step: s, workflowName: 'sprint', attempt: 1, stepDispatch: 'direct' });
    expect(out).toContain('**Do the work yourself.**');
    expect(out).not.toContain('Delegate to the `cyboflow-implement` role');
    expect(out).not.toContain('Task tool');
    expect(out).toContain('## Reading the sections below');
  });

  it('is byte-identical to the default when dispatch is absent or delegated', () => {
    const plain = composeStepPrompt({ step: s, workflowName: 'sprint', attempt: 1 });
    expect(composeStepPrompt({ step: s, workflowName: 'sprint', attempt: 1, stepDispatch: 'delegated' })).toBe(plain);
    expect(plain).toContain('Delegate to the `cyboflow-implement` role');
    expect(plain).not.toContain('## Reading the sections below');
  });

  it('drops the "pass it to your subagent" clause from the task scope', () => {
    const out = composeStepPrompt({
      step: s,
      workflowName: 'sprint',
      attempt: 1,
      taskScope: '- TASK-1: do a thing',
      stepDispatch: 'direct',
    });
    expect(out).toContain('use THIS list; do NOT hunt');
    expect(out).not.toContain('pass it to your subagent');
  });

  it('gives task-verify a verdict contract that does not relay a subagent', () => {
    const tv = step({ id: 'task-verify', agent: 'task-verify' });
    const out = composeStepPrompt({ step: tv, workflowName: 'sprint', attempt: 1, stepDispatch: 'direct' });
    const start = out.indexOf('## Final message contract (task-verify)');
    const end = out.indexOf('\n\n## ', start);
    const contract = out.slice(start, end === -1 ? undefined : end);
    expect(contract).toContain('`VERDICT: PASS`');
    expect(contract).not.toContain('subagent');
    expect(contract).not.toContain('RELAY, do not summarize');
  });
});

describe('renderWorkflowPromptForRuntime — direct programmatic steps', () => {
  const prompt = { prompt: 'STEP', systemPromptAppend: '' };

  it('uses the direct Codex envelope, which forbids spawn_agent delegation', () => {
    const out = renderWorkflowPromptForRuntime(prompt, {
      provider: 'codex',
      runtime: 'codex-sdk',
      executionModel: 'programmatic',
      turnKind: 'programmatic-step',
      stepDispatch: 'direct',
    });
    expect(out.prompt).toContain('This step runs its `cyboflow-*` role DIRECTLY');
    expect(out.prompt).not.toContain('delegate with `spawn_agent`');
    expect(out.prompt.endsWith('STEP')).toBe(true);
  });

  it('keeps the delegating envelope for delegated steps and non-step turns', () => {
    const delegated = renderWorkflowPromptForRuntime(prompt, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'programmatic-step',
    });
    expect(delegated.prompt).toContain('delegate with `spawn_agent`');
    const launch = renderWorkflowPromptForRuntime(prompt, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'launch',
      stepDispatch: 'direct',
    });
    expect(launch.prompt).toContain('delegate with `spawn_agent`');
  });

  it('leaves Claude unwrapped either way', () => {
    const out = renderWorkflowPromptForRuntime(prompt, {
      provider: 'claude',
      runtime: 'claude-sdk',
      turnKind: 'programmatic-step',
      stepDispatch: 'direct',
    });
    expect(out.prompt).toBe('STEP');
  });
});

describe('SpawnStepRunner — direct dispatch', () => {
  it('runs a Claude step directly: role prompt as system append, delegation tools denied', async () => {
    const spawner = makeSpawner();
    await new SpawnStepRunner(spawner, baseOpts).runStep(step({ id: 'implement' }), ctx);
    const passed = spawned(spawner);
    expect(passed.systemPromptAppend).toBe(composeDirectStepSystemPrompt('implement', ROLE_PROMPT));
    expect(passed.disallowedTools).toEqual([...PROGRAMMATIC_STEP_DISALLOWED_TOOLS, 'Task', 'Agent', 'Workflow']);
    expect(passed.prompt).toContain('**Do the work yourself.**');
  });

  it('runs a Codex step directly with the direct envelope and no Claude-only denials', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, {
      ...baseOpts,
      promptRenderContext: { provider: 'codex', runtime: 'codex-sdk', executionModel: 'programmatic' },
    });
    await runner.runStep(step({ id: 'implement' }), ctx);
    const passed = spawned(spawner);
    expect(passed.systemPromptAppend).toContain(ROLE_PROMPT);
    expect(passed.disallowedTools).toEqual([...PROGRAMMATIC_STEP_DISALLOWED_TOOLS]);
    expect(passed.prompt).toContain('This step runs its `cyboflow-*` role DIRECTLY');
    expect(passed.prompt).toContain('**Do the work yourself.**');
  });

  it('follows a per-step runtime pin when deciding (Codex step in a Claude run)', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, {
      ...baseOpts,
      resolveStepAgent: () => ({ runtime: 'codex-sdk' as const }),
    });
    await runner.runStep(step({ id: 'implement' }), ctx);
    const passed = spawned(spawner);
    expect(passed.agentRuntime).toBe('codex-sdk');
    expect(passed.prompt).toContain('This step runs its `cyboflow-*` role DIRECTLY');
    expect(passed.disallowedTools).not.toContain('Task');
  });

  it('delegates an OMP step even with a role prompt available', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, {
      ...baseOpts,
      promptRenderContext: { provider: 'omp', runtime: 'omp-sdk', executionModel: 'programmatic' },
    });
    await runner.runStep(step({ id: 'implement' }), ctx);
    const passed = spawned(spawner);
    expect(passed.systemPromptAppend).toBeUndefined();
    expect(passed.prompt).toContain('Delegate to the `cyboflow-implement` role');
  });

  it('delegates when the role cannot be resolved, and when no resolver is wired', async () => {
    const unknown = makeSpawner();
    await new SpawnStepRunner(unknown, baseOpts).runStep(step({ id: 'custom', agent: 'unknown' }), ctx);
    expect(spawned(unknown).systemPromptAppend).toBeUndefined();

    const unwired = makeSpawner();
    const noResolver = { ...baseOpts, resolveStepRole: undefined };
    await new SpawnStepRunner(unwired, noResolver).runStep(step({ id: 'implement' }), ctx);
    expect(spawned(unwired).systemPromptAppend).toBeUndefined();
    expect(spawned(unwired).prompt).toContain('Delegate to the `cyboflow-implement` role');
  });

  it('logs the dispatch of every step once a resolver is wired', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const runner = new SpawnStepRunner(makeSpawner(), { ...baseOpts, workflowName: 'sprint' }, logger);
    await runner.runStep(step({ id: 'implement' }), ctx);
    await runner.runStep(step({ id: 'address-review' }), ctx);
    const lines = logger.info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("step 'implement' dispatch=direct"))).toBe(true);
    expect(lines.some((l) => l.includes("step 'address-review' dispatch=delegated") && l.includes('two agents'))).toBe(true);
  });
});
