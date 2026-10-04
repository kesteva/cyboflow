/**
 * systemViewComposition — the System view's boot wiring (IDEA-037), kept out of
 * index.ts per the #19 god-file split. It injects the three tRPC providers the
 * view reads and acts through:
 *
 *   - worktreeMonitor — the reconciled worktree registry + disk-usage tri-state;
 *   - system          — the aggregated snapshot (ONE ps scan per snapshot() call,
 *                       unioned with the PTY managers' owned handles + run
 *                       shells, plus the worktree registry and orch.sock);
 *   - monitorReap     — the manifest-then-execute gate for every destructive
 *                       action, resolving manifests against the same snapshot the
 *                       view renders.
 *
 * Nothing here polls: every provider computes only when its query is invoked,
 * so no subscriber ⇒ zero ps/du calls.
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports concrete
 * services, so it must stay OUT of main/src/orchestrator/** (the
 * standalone-typecheck invariant scans that tree).
 */

import { setWorktreeMonitorProvider } from './orchestrator/trpc/routers/worktreeMonitor';
import { buildSystemSnapshot, setSystemProvider } from './orchestrator/trpc/routers/system';
import { setMonitorReapProvider } from './orchestrator/trpc/routers/monitorReap';
import { createWorktreeMonitorProvider } from './services/worktreeMonitorProvider';
import { createSystemSnapshotProvider } from './services/systemSnapshotProvider';
import { ProcessSnapshotService } from './services/processSnapshot/processSnapshotService';
import { MonitorReapService } from './services/monitor/monitorReapService';
import { countDescendantPids } from './services/monitor/reapManifest';
import { probeWorktreeGit } from './services/monitor/probeWorktreeGit';
import { ReapExecutorImpl } from './services/monitor/reapExecutor';
import { createWorktreePruner } from './services/monitor/worktreePruner';
import { diskUsageService } from './services/diskUsageService';
import { isBrokerProcess, type CodexBrokerReaper } from './services/codexBrokerReaper';
import type { OrchSocketServer } from './orchestrator/mcpServer/orchSocketServer';
import type { AbstractCliManager } from './services/panels/cli/AbstractCliManager';
import type { RunShellManager } from './services/runShellManager';
import type { WorktreeManager } from './services/worktreeManager';
import type { GitStatusManager } from './services/gitStatusManager';
import type { DatabaseService } from './database/database';

export interface SystemViewCompositionDeps {
  databaseService: DatabaseService;
  worktreeManager: WorktreeManager;
  gitStatusManager: GitStatusManager;
  codexBrokerReaper: CodexBrokerReaper;
  orchSocketServer: OrchSocketServer;
  /** Every interactive-substrate PTY manager whose owned processes the snapshot unions. */
  ptyCliManagers: AbstractCliManager[];
  /** Read lazily: the run-shell manager is constructed later in boot. */
  getRunShellManager: () => RunShellManager | null;
}

export function composeSystemView(deps: SystemViewCompositionDeps): void {
  const { databaseService, worktreeManager, gitStatusManager, codexBrokerReaper } = deps;
  const buildWorktreeProvider = () =>
    createWorktreeMonitorProvider({ database: databaseService, worktreeManager, diskUsage: diskUsageService });

  setWorktreeMonitorProvider(buildWorktreeProvider());
  console.log('[Main] worktreeMonitor deps wired');

  const systemSnapshotProvider = createSystemSnapshotProvider({
    processSnapshot: new ProcessSnapshotService({
      cliManager: deps.ptyCliManagers,
      runShellManager: {
        listOwnedShells: () => deps.getRunShellManager()?.listOwnedShells() ?? [],
      },
      isBrokerProcess,
    }),
    worktrees: buildWorktreeProvider(),
    orchSocket: deps.orchSocketServer,
  });
  setSystemProvider(systemSnapshotProvider);
  console.log('[Main] system deps wired');

  setMonitorReapProvider(
    new MonitorReapService({
      loadSnapshot: (projectId) => buildSystemSnapshot(systemSnapshotProvider, projectId),
      manifestDeps: {
        measureFresh: (p) => diskUsageService.measureFresh(p),
        peekGitStatus: (sessionId) => gitStatusManager.peekCachedStatus(sessionId),
        probeWorktreeGit,
        countDescendants: countDescendantPids,
      },
      // Process kills, then broker reaping, then worktree removal (owner rows untouched).
      executor: new ReapExecutorImpl({
        reapBrokersForWorktree: (worktreePath) => codexBrokerReaper.reapForWorktree(worktreePath),
        pruneWorktree: createWorktreePruner({
          worktreeManager,
          resolveProjectPath: (projectId) => databaseService.getProject(projectId)?.path ?? null,
          clearGitStatusCache: (sessionId) => gitStatusManager.clearSessionCache(sessionId),
        }),
      }),
    }),
  );
  console.log('[Main] monitorReap deps wired');
}
