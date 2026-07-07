import { describe, it, expect, vi } from 'vitest';
import { SpawnStepRunner } from '../spawnStepRunner';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions } from '../../runExecutor';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { ControllerStepContext } from '../types';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}
const ctx: ControllerStepContext = { runId: 'r', phaseId: 'p', stepIndex: 0, attempt: 1 };

function makeSpawner(impl?: () => Promise<void>): ClaudeSpawnerLike {
  return {
    spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<void>>(impl ?? (() => Promise.resolve())),
    abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

const opts = {
  panelId: 'r',
  sessionId: 'r',
  runId: 'r',
  worktreePath: '/wt',
  workflowName: 'planner',
  // Per-step resolver thunk (permission-mode redesign §3c#2) — invoked each
  // runStep, never captured at construction.
  agentPermissionMode: () => 'auto' as const,
};

describe('SpawnStepRunner', () => {
  it('returns ok and spawns a scoped per-step turn when the turn drains cleanly', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'epics', agent: 'epics' }), ctx);

    expect(result.status).toBe('ok');
    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.panelId).toBe('r');
    expect(passed.worktreePath).toBe('/wt');
    expect(passed.agentPermissionMode).toBe('auto');
    expect(passed.prompt).toContain('`epics`'); // the step-scoped prompt
  });

  it('forwards ctx.item into the composed prompt (fan-out item scope)', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    await runner.runStep(step({ id: 'implement', agent: 'implement' }), {
      ...ctx,
      item: { id: 'TASK-42', over: 'tasks' },
    });

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.prompt).toContain('PARALLEL fan-out');
    expect(passed.prompt).toContain('**TASK-42**');
    expect(passed.prompt).toContain('**tasks**');
  });

  it('omits the fan-out block from the prompt when ctx has no item', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    await runner.runStep(step({ id: 'a' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.prompt).not.toContain('PARALLEL fan-out');
  });

  it('returns failed (not throws) when the spawned turn rejects, carrying the error', async () => {
    const spawner = makeSpawner(() => Promise.reject(new Error('turn aborted')));
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('turn aborted');
  });

  it('omits agentPermissionMode from the spawn when none is bound', async () => {
    const spawner = makeSpawner();
    const noMode = { panelId: 'r', sessionId: 'r', runId: 'r', worktreePath: '/wt', workflowName: 'planner' };
    const runner = new SpawnStepRunner(spawner, noMode);

    await runner.runStep(step({ id: 'a' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.agentPermissionMode).toBeUndefined();
  });

  it('omits agentPermissionMode when the bound resolver returns undefined (thunk present, value absent)', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, { ...opts, agentPermissionMode: () => undefined });

    await runner.runStep(step({ id: 'a' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect('agentPermissionMode' in passed).toBe(false);
  });

  it('RE-RESOLVES agentPermissionMode per step — invokes the thunk each runStep, not captured at construction', async () => {
    const spawner = makeSpawner();
    // A resolver whose return value CHANGES between steps (mirrors a mid-run
    // session-mode flip): the spawn for each step must carry the freshly-resolved
    // value, proving the mode is read per runStep rather than frozen at build time.
    const modes = ['default', 'acceptEdits'] as const;
    let call = 0;
    const resolve = vi.fn<() => (typeof modes)[number]>(() => modes[Math.min(call++, modes.length - 1)]);
    const runner = new SpawnStepRunner(spawner, { ...opts, agentPermissionMode: resolve });

    await runner.runStep(step({ id: 's1' }), ctx);
    await runner.runStep(step({ id: 's2' }), ctx);

    expect(resolve).toHaveBeenCalledTimes(2);
    const calls = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0][0] as ClaudeSpawnerOptions).agentPermissionMode).toBe('default');
    expect((calls[1][0] as ClaudeSpawnerOptions).agentPermissionMode).toBe('acceptEdits');
  });

  // ── cancellation: SDK abort resolves the spawn cleanly, so a resolved spawn
  //    under an aborted signal must map to 'aborted', NOT 'ok' (fix #5/#3/#14) ──
  it('returns aborted (not ok) when the signal fired during a cleanly-resolving spawn', async () => {
    const ac = new AbortController();
    // The spawn "resolves cleanly" (SDK treats a canceled turn as a clean drain),
    // but the signal aborted meanwhile.
    const spawner = makeSpawner(() => {
      ac.abort();
      return Promise.resolve();
    });
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), { ...ctx, signal: ac.signal });

    expect(result.status).toBe('aborted');
  });

  it('short-circuits to aborted without spawning when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), { ...ctx, signal: ac.signal });

    expect(result.status).toBe('aborted');
    expect(spawner.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('maps a rejection under an aborted signal to aborted (not failed)', async () => {
    const ac = new AbortController();
    const spawner = makeSpawner(() => {
      ac.abort();
      return Promise.reject(new Error('killed'));
    });
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), { ...ctx, signal: ac.signal });

    expect(result.status).toBe('aborted');
  });

  // ── additive per-lane spawnKey forwarding (Option A — parallel lane spawns) ──
  it('forwards ctx.spawnKey into the spawn options when present (fan-out lane)', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    await runner.runStep(step({ id: 'implement', agent: 'implement' }), {
      ...ctx,
      item: { id: 'TASK-7', over: 'tasks' },
      spawnKey: 'r:TASK-7',
    });

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.spawnKey).toBe('r:TASK-7');
    // panelId is NEVER overloaded by the lane key — it stays the run panel id.
    expect(passed.panelId).toBe('r');
  });

  it('OMITS spawnKey from the spawn options when ctx.spawnKey is undefined (byte-identity, no-item path)', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    await runner.runStep(step({ id: 'a' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    // The conditional spread leaves the key entirely ABSENT — not present-with-undefined —
    // so the spawner defaults spawnKey to panelId and every non-fan-out path stays byte-identical.
    expect('spawnKey' in passed).toBe(false);
  });

  // ── operator guidance thunk (RunDirectives live steering) ──────────────────
  it('appends operator guidance to the composed prompt when the stepGuidance thunk returns text', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, {
      ...opts,
      stepGuidance: (id) => (id === 'implement' ? 'prefer the streaming API' : undefined),
    });

    await runner.runStep(step({ id: 'implement', agent: 'implement' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.prompt).toContain('## Operator guidance');
    expect(passed.prompt).toContain('prefer the streaming API');
  });

  it('adds NO guidance section when no stepGuidance thunk is bound (byte-identity)', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts); // opts has no stepGuidance

    await runner.runStep(step({ id: 'implement', agent: 'implement' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.prompt).not.toContain('## Operator guidance');
  });

  it('adds NO guidance section when the bound thunk returns undefined for this step id', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, { ...opts, stepGuidance: () => undefined });

    await runner.runStep(step({ id: 'implement', agent: 'implement' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.prompt).not.toContain('## Operator guidance');
  });

  it('RE-RESOLVES stepGuidance per step — invokes the thunk each runStep, honoring a mid-run change', async () => {
    const spawner = makeSpawner();
    // A resolver whose return value CHANGES between steps (mirrors the operator
    // adding guidance mid-run): the thunk must be read PER runStep, not frozen at
    // construction, so the second step's spawn carries the freshly-added text.
    const guidance = new Map<string, string>();
    const resolve = vi.fn<(id: string) => string | undefined>((id) => guidance.get(id));
    const runner = new SpawnStepRunner(spawner, { ...opts, stepGuidance: resolve });

    // First step: no guidance yet.
    await runner.runStep(step({ id: 's1', agent: 's1' }), ctx);
    // Operator adds guidance for s2 AFTER the runner was constructed.
    guidance.set('s2', 'watch the null case');
    await runner.runStep(step({ id: 's2', agent: 's2' }), ctx);

    expect(resolve).toHaveBeenCalledTimes(2);
    const calls = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0][0] as ClaudeSpawnerOptions).prompt).not.toContain('## Operator guidance');
    expect((calls[1][0] as ClaudeSpawnerOptions).prompt).toContain('watch the null case');
  });
});
