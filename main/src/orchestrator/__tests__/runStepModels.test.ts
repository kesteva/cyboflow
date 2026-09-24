/**
 * runStepModels.test.ts — TASK-273 coverage for `resolveRunStepModels` and the
 * `runs.getStepModels` tRPC procedure it backs.
 *
 * Fixture style mirrors the neighboring `cyboflow.runs.getPhaseState` suite in
 * `trpc/routers/__tests__/runs.test.ts` (createTestDb + dbAdapter + a real
 * appRouter caller), but injects a FAKE `resolveEffectiveAgents` — the
 * standalone-invariant DI seam runStepModels.ts documents — instead of routing
 * through the real `agentOverlayWriter`/`agent_overrides` machinery, which is
 * out of scope here (covered by agentOverlayWriter's own suite).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../trpc/router';
import { createContext } from '../trpc/context';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import {
  resolveRunStepModels,
  RunNotFoundError,
  RunDefinitionNotFoundError,
  type EffectiveAgentsResolver,
} from '../runStepModels';
import type { EffectiveAgent } from '../agents/effectiveAgents';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
// Assert the Claude-alias label through the map rather than a literal: the
// alias→label binding is re-pinned whenever a family points at a new snapshot
// (e.g. opus "Opus 5" → "Opus 5.5"), and these tests are about WHICH branch
// resolves the label, not what that release happens to be called.
import { AGENT_MODEL_LABELS } from '../../../../shared/types/agents';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid WorkflowDefinition covering every case this suite needs. */
const TEST_SPEC = {
  id: 'step-models-test',
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        // No effective-agent entry at all -> fully inherits the run model.
        { id: 'inherit-step', name: 'Inherit step', agent: 'inherit-agent' },
        // Human gate -> must be OMITTED from the result.
        { id: 'human-gate', name: 'Human gate', agent: 'human' },
        // Runtime pinned to a CLAUDE transport, but no model pin -> still
        // counts as INHERIT (rule 2 of the module's precedence).
        { id: 'claude-runtime-only-step', name: 'Claude runtime only', agent: 'claude-interactive-agent' },
      ],
    },
    {
      id: 'execute',
      label: 'Execute',
      color: '#2db67a',
      steps: [
        // Pinned Claude alias.
        { id: 'opus-step', name: 'Opus step', agent: 'opus-agent' },
        // Pinned non-Claude runtime with a verbatim provider model id.
        { id: 'codex-step', name: 'Codex step', agent: 'codex-agent' },
        // Pinned Claude runtime AND a pinned Claude model together (distinct
        // from opus-step's runtime===null pin and claude-runtime-only-step's
        // model===null inherit — this is the fourth combination of the
        // {runtime, model} pair the precedence chain must handle).
        { id: 'claude-runtime-and-model-step', name: 'Claude runtime + model', agent: 'claude-interactive-sonnet-agent' },
        // providerModel pinned WITHOUT a runtime pin — meaningful only on a
        // run whose own provider is non-Claude (spawn-seam precedence).
        { id: 'provider-model-only-step', name: 'Provider model only', agent: 'provider-model-only-agent' },
        // Non-Claude runtime pinned with NO providerModel.
        { id: 'codex-runtime-only-step', name: 'Codex runtime only', agent: 'codex-runtime-only-agent' },
        // `human: true` with a non-'human' agent — still a gate, omitted.
        { id: 'flagged-human-step', name: 'Flagged human', agent: 'opus-agent', human: true },
      ],
    },
  ],
};

function seedStepModelsRun(
  db: Database.Database,
  runId: string,
  opts?: { model?: string | null; agentProvider?: string },
): void {
  const workflowId = `wf-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`,
  ).run(workflowId, 'step-models-test', JSON.stringify(TEST_SPEC));

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, model, agent_provider)
     VALUES (?, ?, 1, '/tmp/test', 'running', '{}', ?, ?)`,
  ).run(runId, workflowId, opts?.model ?? null, opts?.agentProvider ?? 'claude');
}

function makeDb(): Database.Database {
  // includeSubstrate: model/agent_provider/agent_runtime (resolveRunStepModels
  // reads model/agent_provider). includeWorkflowRunTaskColumns: current_step_id
  // (getPhaseState reads it in the parity test below). Composable — both flags
  // fold their shared columns in idempotently.
  return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
}

/** A minimal-but-complete EffectiveAgent — only the fields under test vary. */
function effectiveAgent(overrides: Partial<EffectiveAgent> & { agentKey: string }): EffectiveAgent {
  return {
    name: overrides.agentKey,
    role: 'executor',
    description: '',
    systemPrompt: 'SECRET_SYSTEM_PROMPT_SHOULD_NEVER_LEAK',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
    ...overrides,
  };
}

const FAKE_EFFECTIVE_AGENTS: EffectiveAgent[] = [
  effectiveAgent({ agentKey: 'opus-agent', model: 'opus' }),
  effectiveAgent({ agentKey: 'codex-agent', model: null, runtime: 'codex-sdk', providerModel: 'gpt-5.6-sol' }),
  effectiveAgent({ agentKey: 'claude-interactive-agent', model: null, runtime: 'claude-interactive' }),
  effectiveAgent({
    agentKey: 'claude-interactive-sonnet-agent',
    model: 'sonnet',
    runtime: 'claude-interactive',
  }),
  effectiveAgent({ agentKey: 'provider-model-only-agent', model: null, providerModel: 'gpt-5.6-sol' }),
  effectiveAgent({ agentKey: 'codex-runtime-only-agent', model: null, runtime: 'codex-sdk' }),
  // 'inherit-agent' deliberately absent — a step whose agentKey has no
  // effective-agent row at all must still resolve (fully inherits).
];

const fakeResolveEffectiveAgents: EffectiveAgentsResolver = () => FAKE_EFFECTIVE_AGENTS;

// ---------------------------------------------------------------------------
// resolveRunStepModels (direct unit coverage)
// ---------------------------------------------------------------------------

describe('resolveRunStepModels', () => {
  it('inherit case: an agent with no effective-agent row resolves via the run-level model', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit', fakeResolveEffectiveAgents);
    const inheritStep = result.find((s) => s.stepId === 'inherit-step');

    expect(inheritStep).toBeDefined();
    expect(inheritStep?.label).toBe('Sonnet 5');
    expect(inheritStep?.family).toBe('sonnet');
  });

  it('inherit case: a Claude-runtime pin with no model pin still inherits the run model', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit-runtime', { model: 'haiku', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit-runtime', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'claude-runtime-only-step');

    expect(step).toBeDefined();
    expect(step?.label).toBe('Haiku 4.5');
    expect(step?.family).toBe('haiku');
  });

  it('inherit case with no run-level model pin resolves to the Auto label/family', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit-auto', { model: null, agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit-auto', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'inherit-step');

    expect(step?.label).toBe('Auto');
    expect(step?.family).toBe('auto');
  });

  it('inherit case: a Codex run with no run-level model (null) resolves to Auto/default with family "auto"', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit-codex-null', { model: null, agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit-codex-null', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'inherit-step');

    expect(step?.label).toBe('Auto/default');
    expect(step?.family).toBe('auto');
  });

  it('inherit case: a Codex run with an empty-string run-level model resolves to Auto/default with family "auto"', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit-codex-empty', { model: '', agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit-codex-empty', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'inherit-step');

    expect(step?.label).toBe('Auto/default');
    expect(step?.family).toBe('auto');
  });

  it('inherit case: a Codex run with run-level model "auto" resolves to Auto/default with family "auto"', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit-codex-auto', { model: 'auto', agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit-codex-auto', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'inherit-step');

    expect(step?.label).toBe('Auto/default');
    expect(step?.family).toBe('auto');
  });

  it('inherit case: a Codex run with a concrete non-Claude run-level model resolves verbatim with family "other"', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-inherit-codex-concrete', { model: 'gpt-5.6-sol', agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-inherit-codex-concrete', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'inherit-step');

    expect(step?.label).toBe('gpt-5.6-sol');
    expect(step?.family).toBe('other');
  });

  it('pinned Claude alias resolves via agentRunTargetLabel with the alias as its family', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-pinned-claude', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-pinned-claude', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'opus-step');

    expect(step?.label).toBe(AGENT_MODEL_LABELS.opus);
    expect(step?.family).toBe('opus');
  });

  it('pinned Claude runtime WITH a pinned Claude model resolves via agentRunTargetLabel, not the runtime label', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-pinned-runtime-and-model', { model: 'haiku', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-pinned-runtime-and-model', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'claude-runtime-and-model-step');

    expect(step).toBeDefined();
    expect(step?.label).toBe('Sonnet 5');
    expect(step?.family).toBe('sonnet');
  });

  it('non-Claude runtime (Codex with a providerModel) resolves verbatim with family "other"', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-codex', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-codex', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'codex-step');

    expect(step?.label).toBe('gpt-5.6-sol');
    expect(step?.family).toBe('other');
  });

  // -- Spawn-seam parity (stepSpawnTarget.resolveStepSpawnTarget) ----------

  it('a Claude-runtime pin on a Codex run spawns the Claude default, never the run\'s Codex model id', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-flip-to-claude', { model: 'gpt-5.6-sol', agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-flip-to-claude', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'claude-runtime-only-step');

    expect(step?.label).toBe('Auto');
    expect(step?.family).toBe('auto');
  });

  it('a Claude alias pin with no runtime on a Codex run is ignored at spawn -> inherits the run model', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-alias-on-codex', { model: 'gpt-5.6-sol', agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-alias-on-codex', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'opus-step');

    expect(step?.label).toBe('gpt-5.6-sol');
    expect(step?.family).toBe('other');
  });

  it('a Codex runtime pin with no providerModel on a Codex run inherits the run model', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-codex-inherit', { model: 'gpt-5.6-sol', agentProvider: 'codex' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-codex-inherit', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'codex-runtime-only-step');

    expect(step?.label).toBe('gpt-5.6-sol');
    expect(step?.family).toBe('other');
  });

  it('a Codex runtime pin with no providerModel on a Claude run is the Codex default, family "auto"', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-codex-default', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-codex-default', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'codex-runtime-only-step');

    expect(step?.label).toBe('Codex SDK');
    expect(step?.family).toBe('auto');
  });

  it('a providerModel-only pin never renders the "inherits run model" sentinel as a model name', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-pm-only-claude', { model: 'haiku', agentProvider: 'claude' });
    seedStepModelsRun(db, 'run-pm-only-codex', { model: 'gpt-5.5', agentProvider: 'codex' });

    const onClaude = resolveRunStepModels(dbAdapter(db), 'run-pm-only-claude', fakeResolveEffectiveAgents).find(
      (s) => s.stepId === 'provider-model-only-step',
    );
    const onCodex = resolveRunStepModels(dbAdapter(db), 'run-pm-only-codex', fakeResolveEffectiveAgents).find(
      (s) => s.stepId === 'provider-model-only-step',
    );

    // Claude run: a provider model id is meaningless -> inherits the run model.
    expect(onClaude?.label).toBe(AGENT_MODEL_LABELS.haiku);
    expect(onClaude?.family).toBe('haiku');
    // Codex run: the spawn seam reads providerModel for the run's provider.
    expect(onCodex?.label).toBe('gpt-5.6-sol');
    expect(onCodex?.family).toBe('other');
  });

  it('a concrete Claude snapshot id on the run is labeled by family/version, never as the raw wire id', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-concrete-claude', { model: 'claude-opus-4-8[1m]', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-concrete-claude', fakeResolveEffectiveAgents);
    const step = result.find((s) => s.stepId === 'inherit-step');

    expect(step?.label).toBe('Opus 4.8 · 1M');
    expect(step?.family).toBe('opus');
  });

  it('applies the spawn gates: a disabled provider drops the runtime pin, an unusable guarded model falls back', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-gated', { model: 'fable', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-gated', fakeResolveEffectiveAgents, {
      isProviderEnabled: (p) => p !== 'codex',
      isModelUsable: () => false,
    });

    // Codex disabled -> the codex-sdk pin is dropped; the step falls back to the
    // run's Claude provider, whose Fable model is unavailable -> Opus.
    const codexStep = result.find((s) => s.stepId === 'codex-step');
    expect(codexStep?.label).toBe(AGENT_MODEL_LABELS.opus);
    expect(codexStep?.family).toBe('opus');
    const inheritStep = result.find((s) => s.stepId === 'inherit-step');
    expect(inheritStep?.family).toBe('opus');
  });

  it('omits the human-gate step entirely, while keeping every other step', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-human-gate', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-human-gate', fakeResolveEffectiveAgents);

    expect(result.some((s) => s.stepId === 'human-gate')).toBe(false);
    expect(result.some((s) => s.stepId === 'flagged-human-step')).toBe(false);
    expect(result.map((s) => s.stepId).sort()).toEqual(
      [
        'inherit-step',
        'claude-runtime-only-step',
        'opus-step',
        'codex-step',
        'claude-runtime-and-model-step',
        'provider-model-only-step',
        'codex-runtime-only-step',
      ].sort(),
    );
  });

  it('produces stepIds identical to what getPhaseState would flatten for the same fixture', async () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-parity', { model: 'sonnet', agentProvider: 'claude' });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const phaseState = await caller.cyboflow.runs.getPhaseState({ runId: 'run-parity' });
    const allFlattenedSteps = phaseState.definition.phases.flatMap((p) =>
      p.steps.map((s) => ({ stepId: s.id, agent: s.agent, human: s.human })),
    );
    const expectedNonHumanIds = allFlattenedSteps
      .filter((s) => resolveStepAgentKey(s.stepId, s.agent) !== null && s.human !== true)
      .map((s) => s.stepId);

    const result = resolveRunStepModels(dbAdapter(db), 'run-parity', fakeResolveEffectiveAgents);

    expect(result.map((s) => s.stepId)).toEqual(expectedNonHumanIds);
  });

  it('throws RunNotFoundError for a missing run', () => {
    const db = makeDb();
    expect(() => resolveRunStepModels(dbAdapter(db), 'no-such-run', fakeResolveEffectiveAgents)).toThrow(
      RunNotFoundError,
    );
  });

  it('throws RunDefinitionNotFoundError when the run resolves to no workflow definition', () => {
    const db = makeDb();
    const workflowId = 'wf-bad-def';
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'not-a-builtin', '{}')`,
    ).run(workflowId);
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
       VALUES ('run-bad-def', ?, 1, '/tmp/test', 'running', '{}')`,
    ).run(workflowId);

    expect(() => resolveRunStepModels(dbAdapter(db), 'run-bad-def', fakeResolveEffectiveAgents)).toThrow(
      RunDefinitionNotFoundError,
    );
  });

  it('never leaks agent internals (systemPrompt/tools/mcp*) onto a StepModelInfo', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-no-leak', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-no-leak', fakeResolveEffectiveAgents);

    expect(result.length).toBeGreaterThan(0);
    for (const info of result) {
      expect(Object.keys(info).sort()).toEqual(
        ['family', 'label', 'phaseId', 'stepId', 'stepName'].sort(),
      );
      expect(JSON.stringify(info)).not.toContain('SECRET_SYSTEM_PROMPT_SHOULD_NEVER_LEAK');
    }
  });
});

// ---------------------------------------------------------------------------
// cyboflow.runs.getStepModels (tRPC procedure)
// ---------------------------------------------------------------------------

describe('cyboflow.runs.getStepModels', () => {
  it('returns the same StepModelInfo[] resolveRunStepModels would, with no leaked fields', async () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-trpc', { model: 'sonnet', agentProvider: 'claude' });

    const caller = appRouter.createCaller(
      createContext({ db: dbAdapter(db), resolveRunEffectiveAgents: fakeResolveEffectiveAgents }),
    );
    const result = await caller.cyboflow.runs.getStepModels({ runId: 'run-trpc' });

    expect(result.some((s) => s.stepId === 'human-gate')).toBe(false);
    const opusStep = result.find((s) => s.stepId === 'opus-step');
    expect(opusStep?.label).toBe(AGENT_MODEL_LABELS.opus);
    for (const info of result) {
      expect(Object.keys(info).sort()).toEqual(
        ['family', 'label', 'phaseId', 'stepId', 'stepName'].sort(),
      );
    }
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext({}));
    await expect(caller.cyboflow.runs.getStepModels({ runId: 'run-x' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
  });

  it('throws PRECONDITION_FAILED when ctx.resolveRunEffectiveAgents is not wired', async () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-unwired', { model: 'sonnet', agentProvider: 'claude' });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(caller.cyboflow.runs.getStepModels({ runId: 'run-unwired' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
  });

  it('throws NOT_FOUND for an unknown runId', async () => {
    const db = makeDb();
    const caller = appRouter.createCaller(
      createContext({ db: dbAdapter(db), resolveRunEffectiveAgents: fakeResolveEffectiveAgents }),
    );
    await expect(caller.cyboflow.runs.getStepModels({ runId: 'no-such-run' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<TRPCError>);
  });
});
