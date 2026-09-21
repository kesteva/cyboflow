/**
 * proposalExecutorLaunchDeps — the launch-run closure of
 * {@link ProposalExecutorDeps}, factored out of the boot composition root
 * (main/src/index.ts) next to its workflow-shaped sibling
 * (proposalExecutorWorkflowDeps.ts) so index.ts stays under its #19 size
 * ratchet and the seed mapping has a home a unit test can reach.
 *
 * What it decides (TASK-294): WHICH row a proposal launches and WHICH seeds
 * reach RunLauncher.launch.
 *   - The row resolves by `workflowId` when the proposal carries one (every
 *     custom flow does — prepareProposal stamps it), else by exact name among
 *     the flows visible to the project (a project-scoped row shadows a global
 *     one, matching the launch wizard).
 *   - The seeds map by the flow's SHAPE (`seedKindForWorkflow` over the
 *     effective definition), never by the row's display name — so a custom
 *     sprint-shaped flow named `dash` gets its `taskIds` as lanes exactly like
 *     the built-in. A seed the shape does not consume is dropped BEFORE the
 *     launch and reported as `ignoredSeeds`, so the launcher's own guards never
 *     fire on it and the result card can say what was ignored.
 */
import { seedKindAccepts, seedKindForWorkflow, type WorkflowSeedKind } from '../../../../shared/workflows/workflowSeedKind';
import type { WorkflowRow } from '../../../../shared/types/workflows';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { RunLauncher } from '../runLauncher';
import type { LaunchRunSideEffectArgs, LaunchSeedField, ProposalExecutorDeps } from './proposalExecutor';

/** The collaborators the launch closure delegates to. */
export interface ProposalExecutorLaunchCollaborators {
  workflowRegistry: Pick<WorkflowRegistry, 'getById' | 'listByProject' | 'getEffectiveDefinition'>;
  /** SessionManager.getProjectById — the project row's on-disk path. */
  getProjectById: (projectId: number) => { path: string } | undefined;
  runLauncher: Pick<RunLauncher, 'launch'>;
}

export type ProposalExecutorLaunchDeps = Pick<ProposalExecutorDeps, 'launchRun'>;

/**
 * The workflow row a launch-run names, among the flows visible to `projectId`.
 * By id: the row must be global or the project's own (a foreign project's row
 * is as unresolvable as a missing one). By name: WorkflowRegistry.listByProject
 * already returns exactly the visible set; a project-scoped row wins over a
 * same-named global one.
 */
export function resolveLaunchWorkflowRow(
  registry: ProposalExecutorLaunchCollaborators['workflowRegistry'],
  args: Pick<LaunchRunSideEffectArgs, 'projectId' | 'workflowId' | 'workflowName'>,
): WorkflowRow | null {
  if (args.workflowId !== undefined) {
    const row = registry.getById(args.workflowId);
    if (!row || (row.project_id !== null && row.project_id !== args.projectId)) return null;
    return row;
  }
  const visible = registry.listByProject(args.projectId).filter((w) => w.name === args.workflowName);
  return visible.find((w) => w.project_id !== null) ?? visible[0] ?? null;
}

/**
 * Split a proposal's seeds into the ones the flow's shape consumes and the
 * ones it does not. Pure: the launch closure and its test share it.
 */
export function partitionLaunchSeeds(
  seedKind: WorkflowSeedKind,
  args: Pick<LaunchRunSideEffectArgs, 'taskIds' | 'ideaIds' | 'findingIds'>,
): {
  seedTaskIds: string[] | undefined;
  findingIds: string[] | undefined;
  ideaId: string | undefined;
  launchOptions: { ideaIds: string[] } | undefined;
  ignoredSeeds: LaunchSeedField[];
} {
  const ignoredSeeds: LaunchSeedField[] = [];
  const present = (field: LaunchSeedField): string[] | undefined => {
    const ids = args[field];
    return ids !== undefined && ids.length > 0 ? ids : undefined;
  };
  const taskIds = present('taskIds');
  const ideaIds = present('ideaIds');
  const findingIds = present('findingIds');
  if (taskIds !== undefined && !seedKindAccepts(seedKind, 'taskIds')) ignoredSeeds.push('taskIds');
  if (ideaIds !== undefined && !seedKindAccepts(seedKind, 'ideaIds')) ignoredSeeds.push('ideaIds');
  if (findingIds !== undefined && !seedKindAccepts(seedKind, 'findingIds')) ignoredSeeds.push('findingIds');
  return {
    seedTaskIds: seedKind === 'tasks' ? taskIds : undefined,
    findingIds: seedKind === 'findings' ? findingIds : undefined,
    // A ship-shaped flow takes ONE idea (the singular positional); a
    // planner-shaped one takes the batch (launchOptions.ideaIds).
    ideaId: seedKind === 'idea' ? ideaIds?.[0] : undefined,
    launchOptions: seedKind === 'ideas' && ideaIds !== undefined ? { ideaIds } : undefined,
    ignoredSeeds,
  };
}

export function buildProposalExecutorLaunchDeps(c: ProposalExecutorLaunchCollaborators): ProposalExecutorLaunchDeps {
  return {
    launchRun: async (args) => {
      const workflow = resolveLaunchWorkflowRow(c.workflowRegistry, args);
      if (!workflow) {
        throw new Error(
          `launch-run: no '${args.workflowId ?? args.workflowName}' workflow for project ${args.projectId}`,
        );
      }
      const project = c.getProjectById(args.projectId);
      if (!project) throw new Error(`launch-run: project ${args.projectId} not found`);
      const definition = c.workflowRegistry.getEffectiveDefinition(workflow.id);
      if (definition === null) throw new Error(`launch-run: workflow '${workflow.name}' has no resolvable definition`);
      const seeds = partitionLaunchSeeds(seedKindForWorkflow(definition), args);
      const { runId, worktreePath, branchName } = await c.runLauncher.launch(
        workflow.id,
        project.path,
        args.substrate,
        undefined,
        seeds.ideaId,
        args.sessionId,
        undefined,
        undefined,
        seeds.seedTaskIds,
        args.projectId,
        undefined,
        seeds.findingIds,
        undefined,
        undefined,
        undefined,
        seeds.launchOptions,
      );
      return {
        runId,
        worktreePath,
        branchName,
        ...(seeds.ignoredSeeds.length > 0 ? { ignoredSeeds: seeds.ignoredSeeds } : {}),
      };
    },
  };
}
