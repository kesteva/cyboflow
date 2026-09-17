/**
 * buildProposalExecutorWorkflowDeps — the field mapping onto the two
 * chokepoints. The live smoke found the model pin silently dropped: the
 * router keeps `model` only under a pinned Claude runtime, so the mapping must
 * supply that runtime whenever a proposal agent carries a model.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildProposalExecutorWorkflowDeps } from './proposalExecutorWorkflowDeps';
import type { ProposalExecutorWorkflowCollaborators } from './proposalExecutorWorkflowDeps';
import type { CreateWorkflowAgent } from '../../../../shared/types/agentThread';

const DOCS_WRITER: CreateWorkflowAgent = {
  name: 'Docs Writer',
  description: 'Improves docs',
  systemPrompt: 'You write docs.',
  tools: ['Read', 'Edit'],
};

function makeCollaborators() {
  const applyChange = vi.fn(async (_projectId: number, _change: unknown) => ({ agentKey: 'docs-writer' }));
  const createCustom = vi.fn((_input: unknown) => ({ id: 'wf-1-custom-abc' }));
  const c = {
    workflowRegistry: { getEffectiveDefinition: vi.fn(), updateSpec: vi.fn(), createCustom },
    agentOverrideRouter: { applyChange },
    db: { prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })) },
  } as unknown as ProposalExecutorWorkflowCollaborators;
  return { c, applyChange, createCustom };
}

describe('buildProposalExecutorWorkflowDeps — createCustomAgent', () => {
  it('pins the claude-sdk runtime when the agent carries a model, so the chokepoint keeps the pin', async () => {
    const { c, applyChange } = makeCollaborators();
    await buildProposalExecutorWorkflowDeps(c).createCustomAgent(1, { ...DOCS_WRITER, model: 'sonnet' });
    expect(applyChange).toHaveBeenCalledWith(1, expect.objectContaining({ op: 'createCustom', model: 'sonnet', runtime: 'claude-sdk' }));
  });

  it('leaves runtime and model unpinned (inherit the run) when no model is given', async () => {
    const { c, applyChange } = makeCollaborators();
    await buildProposalExecutorWorkflowDeps(c).createCustomAgent(1, DOCS_WRITER);
    expect(applyChange).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ op: 'createCustom', name: 'Docs Writer', model: null, runtime: null, role: null, enabledMcps: [] }),
    );
  });
});

describe('buildProposalExecutorWorkflowDeps — createWorkflow', () => {
  it('stringifies the definition for the registry and returns the minted id', () => {
    const { c, createCustom } = makeCollaborators();
    const definition = { id: 'docs-review', phases: [] };
    const out = buildProposalExecutorWorkflowDeps(c).createWorkflow({ projectId: 1, name: 'docs-review', definition });
    expect(out).toEqual({ workflowId: 'wf-1-custom-abc' });
    expect(createCustom).toHaveBeenCalledWith({ projectId: 1, name: 'docs-review', specJson: JSON.stringify(definition) });
  });
});
