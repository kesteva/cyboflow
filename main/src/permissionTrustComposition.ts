/**
 * permissionTrustComposition — boot wiring for the migration-127 per-project
 * permission-trust prompt. Builds the one PermissionTrustPrompter shared by
 * `projects:create` (via AppServices) and the launch-time triggers: a
 * `session-created` listener (every new session, quick or otherwise) and a
 * wrapper over the publisher RunLauncher emits `run_started` through (a run
 * launched on an existing session). Together they reach projects that predate
 * migration 127, which no other path ever asked.
 *
 * A SIBLING of index.ts on purpose (GitHub issue #19 file-size ratchet), and
 * kept out of main/src/orchestrator/** because it imports electron's dialog.
 */
import { dialog, type BrowserWindow } from 'electron';
import type { DatabaseService } from './database/database';
import type { SessionManager } from './services/sessionManager';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { StreamEventPublisher } from './orchestrator/runLauncher';
import type { Session } from './types/session';
import { PermissionTrustPrompter, withRunStartedTrustPrompt } from './services/permissionTrustPrompt';

export interface PermissionTrustComposition {
  prompter: PermissionTrustPrompter;
  /** Wrap RunLauncher's publisher so each run launch can trigger the prompt. */
  wrapRunPublisher(publisher: StreamEventPublisher): StreamEventPublisher;
}

export function composePermissionTrust(deps: {
  databaseService: DatabaseService;
  sessionManager: SessionManager;
  workflowRegistry: WorkflowRegistry;
  getMainWindow: () => BrowserWindow | null;
}): PermissionTrustComposition {
  const { databaseService, sessionManager, workflowRegistry, getMainWindow } = deps;
  const prompter = new PermissionTrustPrompter({
    getProject: (projectId) => databaseService.getProject(projectId),
    updateProject: (projectId, updates) => databaseService.updateProject(projectId, updates),
    getMainWindow,
    showMessageBox: (window, options) =>
      window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
  });

  sessionManager.on('session-created', (session: Session) => {
    void prompter.maybePromptForProject(session.projectId);
  });

  return {
    prompter,
    wrapRunPublisher: (publisher) =>
      withRunStartedTrustPrompt(publisher, prompter, (runId) => workflowRegistry.getRunById(runId)?.project_id),
  };
}
