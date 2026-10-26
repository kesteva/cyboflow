/**
 * Concrete WorktreeMonitorProvider for the `cyboflow.worktreeMonitor` router:
 * composes the worktree registry reconciler (DB rows + `git worktree list`) with
 * the shared DiskUsageService. Lives in services/ so the router itself stays free
 * of service imports; wired at boot in main/src/index.ts.
 */
import type { WorktreeMonitorProvider } from '../orchestrator/trpc/routers/worktreeMonitor';
import {
  loadWorktreeRegistry,
  type WorktreeRegistryDatabase,
  type WorktreeRegistryGit,
} from './worktreeRegistry';
import type { DiskUsageService } from './diskUsageService';
import type { SiblingWorktreeClaims } from './siblingInstances';

export interface WorktreeMonitorProviderDeps {
  database: WorktreeRegistryDatabase & { getProject(id: number): { path: string } | undefined };
  worktreeManager: WorktreeRegistryGit;
  diskUsage: Pick<DiskUsageService, 'getUsage' | 'requestFresh'>;
  /** Sibling instances' worktree claims (keeps their live worktrees out of `orphan`). */
  readSiblingClaims?: () => Promise<SiblingWorktreeClaims>;
}

export function createWorktreeMonitorProvider(deps: WorktreeMonitorProviderDeps): WorktreeMonitorProvider {
  return {
    async loadRegistry(projectId) {
      const project = deps.database.getProject(projectId);
      if (!project) return [];
      return loadWorktreeRegistry({
        database: deps.database,
        worktreeManager: deps.worktreeManager,
        projectId,
        projectPath: project.path,
        readSiblingClaims: deps.readSiblingClaims,
      });
    },
    getDiskUsage: (path) => deps.diskUsage.getUsage(path),
    requestFresh: (path) => deps.diskUsage.requestFresh(path),
  };
}
