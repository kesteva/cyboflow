/**
 * proposalExecutorWorkflowDeps — the workflow-shaped closures of
 * {@link ProposalExecutorDeps} (edit-workflow's read/apply pair and
 * create-workflow's mint/unwind/reconcile set), factored out of the boot
 * composition root (main/src/index.ts) so the executor's collaborators for
 * flows and agents are built in ONE place next to the executor that consumes
 * them, and so index.ts stays under its #19 size ratchet.
 *
 * Pure wiring: every closure delegates to the chokepoint that owns the write
 * (WorkflowRegistry for flows, AgentOverrideRouter for agents) or to a plain
 * read on the orchestrator db. No policy lives here.
 */
import type { DatabaseLike } from '../types';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { AgentOverrideRouter } from '../agentOverrideRouter';
import type { ProposalExecutorDeps } from './proposalExecutor';

/** The two chokepoints + the db the workflow-shaped deps delegate to. */
export interface ProposalExecutorWorkflowCollaborators {
  workflowRegistry: Pick<WorkflowRegistry, 'getEffectiveDefinition' | 'updateSpec' | 'createCustom'>;
  agentOverrideRouter: Pick<AgentOverrideRouter, 'applyChange'>;
  db: DatabaseLike;
}

export type ProposalExecutorWorkflowDeps = Pick<
  ProposalExecutorDeps,
  | 'readEffectiveWorkflowSpec'
  | 'applyWorkflowSpec'
  | 'createCustomAgent'
  | 'deleteCustomAgent'
  | 'createWorkflow'
  | 'findWorkflowIdByName'
  | 'customAgentExists'
>;

export function buildProposalExecutorWorkflowDeps(
  c: ProposalExecutorWorkflowCollaborators,
): ProposalExecutorWorkflowDeps {
  return {
    // The EFFECTIVE definition (migration 122) — the tuning level's graph, not
    // the raw slot. Must stay the SAME resolution the proposal's CAS hash was
    // captured from (prepareProposal's edit-workflow precondition).
    readEffectiveWorkflowSpec: (workflowId) => c.workflowRegistry.getEffectiveDefinition(workflowId),
    applyWorkflowSpec: (workflowId, definition) => c.workflowRegistry.updateSpec(workflowId, definition),

    // create-workflow. The SAME chokepoints the Agents pane and the workflow
    // editor write through; the human's Confirm click is the authorship. Field
    // mapping is one-to-one with CreateWorkflowAgent — prepareProposal already
    // ran the chokepoint's draft checks, so a rejection here is a race (a key
    // taken since the proposal), which the executor's saga unwinds.
    createCustomAgent: async (projectId, agent) =>
      c.agentOverrideRouter.applyChange(projectId, {
        op: 'createCustom',
        name: agent.name,
        role: agent.role ?? null,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        tools: agent.tools,
        model: agent.model ?? null,
        // The chokepoint keeps a model pin only under a pinned Claude runtime
        // (normalizeRuntime — the Agents pane says "pin a runtime to choose a
        // model"). The proposal's `model` values are Claude aliases, so a model
        // implies that runtime; without this the pin was silently dropped.
        runtime: agent.model !== undefined ? 'claude-sdk' : null,
        enabledMcps: agent.enabledMcps ?? [],
      }),
    deleteCustomAgent: async (projectId, agentKey) => {
      await c.agentOverrideRouter.applyChange(projectId, { op: 'deleteCustom', agentKey });
    },
    createWorkflow: ({ projectId, name, definition, permissionMode }) => {
      const row = c.workflowRegistry.createCustom({
        projectId,
        name,
        specJson: JSON.stringify(definition),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
      return { workflowId: row.id };
    },
    findWorkflowIdByName: (projectId, name) => {
      const row = (
        projectId === null
          ? c.db.prepare('SELECT id FROM workflows WHERE project_id IS NULL AND name = ? LIMIT 1').get(name)
          : c.db.prepare('SELECT id FROM workflows WHERE project_id = ? AND name = ? LIMIT 1').get(projectId, name)
      ) as { id?: unknown } | undefined;
      return typeof row?.id === 'string' ? row.id : null;
    },
    customAgentExists: (projectId, agentKey) =>
      c.db.prepare('SELECT 1 FROM agent_overrides WHERE project_id = ? AND agent_key = ? LIMIT 1').get(projectId, agentKey) !==
      undefined,
  };
}
