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

  it('omits the human-gate step entirely, while keeping every other step', () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-human-gate', { model: 'sonnet', agentProvider: 'claude' });

    const result = resolveRunStepModels(dbAdapter(db), 'run-human-gate', fakeResolveEffectiveAgents);

    expect(result.some((s) => s.stepId === 'human-gate')).toBe(false);
    expect(result.map((s) => s.stepId).sort()).toEqual(
      [
        'inherit-step',
        'claude-runtime-only-step',
        'opus-step',
        'codex-step',
        'claude-runtime-and-model-step',
      ].sort(),
    );
  });

  it('produces stepIds identical to what getPhaseState would flatten for the same fixture', async () => {
    const db = makeDb();
    seedStepModelsRun(db, 'run-parity', { model: 'sonnet', agentProvider: 'claude' });

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const phaseState = await caller.cyboflow.runs.getPhaseState({ runId: 'run-parity' });
    const allFlattenedSteps = phaseState.definition.phases.flatMap((p) =>
      p.steps.map((s) => ({ stepId: s.id, agent: s.agent })),
    );
    const expectedNonHumanIds = allFlattenedSteps
      .filter((s) => resolveStepAgentKey(s.stepId, s.agent) !== null)
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
        ['agentKey', 'family', 'label', 'phaseId', 'stepId', 'stepName'].sort(),
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
        ['agentKey', 'family', 'label', 'phaseId', 'stepId', 'stepName'].sort(),
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
