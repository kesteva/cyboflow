/**
 * proposalExecutorQuickSessionDeps — the quick-session closures of
 * {@link ProposalExecutorDeps}, factored out of the boot composition root
 * (main/src/index.ts) next to its launch / workflow / review siblings so
 * index.ts stays under its #19 size ratchet and the brief delivery has a home
 * a unit test can reach.
 *
 * Two proposal kinds mint quick sessions, for two different reasons:
 *   - `launch-run` needs a HOST session for a workflow run. It is infrastructure,
 *     pinned to the SDK substrate so its sentinel never inherits the
 *     quick-session PTY default (`createQuickSession`).
 *   - `start-quick-session` (TASK-295) mints a USER session — the same thing the
 *     launch wizard's "Quick session" creates — so it takes the wizard's
 *     substrate default and worktree toggle, and then delivers the proposal's
 *     brief as the session's FIRST prompt (`startQuickSession` +
 *     `deliverQuickSessionBrief`).
 *
 * Brief delivery mirrors what the app already does for a first message on each
 * substrate, so the session behaves exactly as if the human had typed the brief:
 *   - SDK: create the Chat panel server-side, REGISTER it with the Claude panel
 *     manager (a server-created panel skips the renderer's panels:create
 *     auto-registration, and every later panels:continue would throw "Panel not
 *     registered" without this — the openIdeaSessionCore / kickoffDesignPanel
 *     precedent), persist the user turn, then `startPanel` with the brief.
 *   - PTY (interactive): create the panel (NOT registered — the PTY surface is
 *     driven through the substrate facade, the same asymmetry the eager spawn in
 *     sessions:create-quick documents), seed the facade's runId→panelId
 *     translation BEFORE the spawn, then spawn the REPL with the brief as its
 *     positional prompt — which the CLI reads once it is ready, so there is no
 *     "type into the terminal" race — and the context briefing on the system
 *     prompt. The spawn promise is NEVER awaited: it resolves only when the REPL
 *     exits (persistent-session contract).
 */
import type { CreatePanelRequest, ToolPanel } from '../../../../shared/types/panels';
import type { ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import type { reportEagerSpawnFailure } from '../../ipc/eagerSpawnFailure';
import type {
  createQuickSessionCore,
  stampQuickSessionRuntimeConfig,
  CreateQuickSessionCoreDeps,
} from '../../services/createQuickSessionCore';
import type { LoggerLike } from '../types';
import type { ProposalExecutorDeps, StartQuickSessionCreated } from './proposalExecutor';

/** The SessionManager slice the quick-session closures touch. */
export interface QuickSessionSessionManagerLike {
  /** The session row's legacy permission_mode (threaded into both spawn seams). */
  getDbSession(sessionId: string): { permission_mode?: 'approve' | 'ignore' } | undefined;
  /** Re-map the row + emit session-updated after the runtime stamps land. */
  refreshSessionFromDatabase(sessionId: string): unknown;
  updateSession(sessionId: string, update: { status: 'running' | 'error' }): unknown;
  /** The legacy session-output stream (what sessions:input writes the user turn to). */
  addSessionOutput(sessionId: string, output: { type: 'stdout'; data: string; timestamp: Date }): unknown;
  /** Panel conversation history — what the SDK chat surface renders. */
  addPanelConversationMessage(panelId: string, messageType: 'user', content: string): void;
  /** Writes an error output AND flips the session to 'error' (reportEagerSpawnFailure's surface). */
  addSessionError(sessionId: string, error: string, details?: string): void;
}

/** The Claude panel manager slice an SDK first turn needs (ipc/claudePanel's export). */
export interface QuickSessionClaudePanelManagerLike {
  registerPanel(panelId: string, sessionId: string): void;
  startPanel(panelId: string, worktreePath: string, prompt: string, permissionMode?: 'approve' | 'ignore'): Promise<void>;
}

/** The interactive-REPL seam for a PTY first turn. */
export interface QuickSessionInteractiveLike {
  /** InteractiveClaudeManager.startPanel's positional signature (ipc/session.ts eager spawn). */
  startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    effort?: 'ultracode',
    fastMode?: boolean,
    resumeSessionId?: string,
    reasoningEffort?: ReasoningEffort,
    userAcknowledgedProviderDisabled?: boolean,
    briefing?: string,
  ): Promise<void>;
}

/** The collaborators the quick-session closures delegate to. */
export interface ProposalExecutorQuickSessionCollaborators {
  /** The two createQuickSessionCore.ts functions, injected (orchestrator/** never imports a service value). */
  createQuickSessionCore: typeof createQuickSessionCore;
  stampQuickSessionRuntimeConfig: typeof stampQuickSessionRuntimeConfig;
  /** ipc/eagerSpawnFailure — Sentry seam + the user-facing session error for a late PTY spawn failure. */
  reportEagerSpawnFailure: typeof reportEagerSpawnFailure;
  /** createQuickSessionCore's own bag (taskQueue / sessionManager / workflowRegistry / getDb / dismiss). */
  quickSessionCore: CreateQuickSessionCoreDeps;
  /** The wizard's adjective-noun-date name minter (ipc/session generateQuickWorktreeBranchName). */
  newSessionName: () => string;
  sessionManager: QuickSessionSessionManagerLike;
  panelManager: { createPanel(request: CreatePanelRequest): Promise<ToolPanel> };
  /** Resolved LAZILY — ipc/claudePanel assigns the export at boot, after this wiring runs. */
  getClaudePanelManager: () => QuickSessionClaudePanelManagerLike | undefined;
  /** SubstrateDispatchFacade — the at-spawn runId→panelId seed for a PTY session. */
  substrateFacade: { registerInteractivePanel(runId: string, panelId: string): void };
  /** InteractiveClaudeManager — the persistent-REPL spawn seam. */
  interactiveReplManager: QuickSessionInteractiveLike;
  /** QUICK_PTY_BRIEFING — the PTY session's context briefing (system prompt, not a user turn). */
  ptyBriefing: string;
  logger: Pick<LoggerLike, 'error'>;
}

export type ProposalExecutorQuickSessionDeps = Pick<
  ProposalExecutorDeps,
  'createQuickSession' | 'startQuickSession' | 'deliverQuickSessionBrief'
>;

/** The `> brief` line sessions:input writes into the legacy output stream for every user turn. */
function userTurnOutput(brief: string): { type: 'stdout'; data: string; timestamp: Date } {
  return { type: 'stdout', data: `> ${brief.trim()}\n`, timestamp: new Date() };
}

export function buildProposalExecutorQuickSessionDeps(
  c: ProposalExecutorQuickSessionCollaborators,
): ProposalExecutorQuickSessionDeps {
  return {
    createQuickSession: async ({ projectId, nameHint }) => {
      const { session } = await c.createQuickSessionCore(
        c.quickSessionCore,
        // Pin 'sdk': an agent-launched host session backs a workflow run, not a user
        // quick session, so its sentinel must not inherit the quick-session PTY default.
        { projectId, nameHint, requestedSubstrate: 'sdk' },
      );
      return { sessionId: session.id, worktreePath: session.worktreePath };
    },

    startQuickSession: async ({ projectId, name, substrate, inPlace }): Promise<StartQuickSessionCreated> => {
      const nameHint = name ?? c.newSessionName();
      const { session, runId, resolvedSubstrate } = await c.createQuickSessionCore(c.quickSessionCore, {
        projectId,
        nameHint,
        // undefined → the sentinel's substrate ladder applies the quick-session
        // default, exactly as a wizard launch with no explicit pick.
        requestedSubstrate: substrate,
        agentProvider: 'claude',
        inPlace,
      });
      // Stamp parity with sessions:create-quick: the RESOLVED substrate lands on
      // the session row (the sessions:input relay branch and the renderer's
      // substrate gates read it), then the active cache is refreshed so the
      // renderer never sees the INSERT defaults.
      try {
        c.stampQuickSessionRuntimeConfig(c.quickSessionCore.getDb(), session.id, { resolvedSubstrate });
        c.sessionManager.refreshSessionFromDatabase(session.id);
      } catch (err) {
        // The core has already persisted the session + worktree + sentinel. A
        // throw here would reject before the executor learns the session id, so
        // its saga could never compensate — dismiss what the core built first.
        await c.quickSessionCore.dismissHalfCreatedSession?.(session.id).catch(() => {});
        throw err;
      }
      return {
        sessionId: session.id,
        runId,
        worktreePath: session.worktreePath,
        name: session.name ?? nameHint,
        substrate: resolvedSubstrate,
      };
    },

    deliverQuickSessionBrief: async ({ sessionId, runId, worktreePath, substrate, brief }) => {
      const permissionMode = c.sessionManager.getDbSession(sessionId)?.permission_mode;
      const panel = await c.panelManager.createPanel({ sessionId, type: 'claude', title: 'Chat' });
      c.sessionManager.addSessionOutput(sessionId, userTurnOutput(brief));

      if (substrate === 'interactive') {
        c.substrateFacade.registerInteractivePanel(runId, panel.id);
        // ⚠️ NEVER await: the interactive spawn promise resolves only when the
        // REPL EXITS. Two failure windows, handled differently:
        //   - EARLY (before `settled`): a cached "not available" probe rejects on
        //     the next tick. One macrotask of settling catches it, and the throw
        //     below lets the executor compensate (dismiss the session) instead of
        //     finalizing "Session started" over a terminal that never emits a byte.
        //   - LATE: the wizard's fail-soft-but-VISIBLE contract (ipc/session.ts
        //     eager spawn): report the seam error, write the session error, flip
        //     the status to 'error'. The 'running' write below always precedes a
        //     late catch, so the catch's 'error' is never clobbered.
        let settled = false;
        let earlyFailure: { err: unknown } | undefined;
        void c.interactiveReplManager
          .startPanel(
            panel.id,
            sessionId,
            worktreePath,
            brief, // positional first prompt — the spawn starts the turn
            permissionMode,
            undefined, // model — the session's default
            undefined, // effort — no ultracode card here
            false, // fastMode
            undefined, // resumeSessionId — a fresh spawn
            undefined, // reasoningEffort
            undefined, // userAcknowledgedProviderDisabled — not a resume prompt
            c.ptyBriefing, // session context, NOT a user turn
          )
          .catch((err: unknown) => {
            if (!settled) {
              earlyFailure = { err };
              return;
            }
            c.logger.error('[proposalExecutor] interactive REPL spawn failed for a proposed quick session', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            c.reportEagerSpawnFailure(err, 'interactive', 'claude', { sessionManager: c.sessionManager, sessionId });
            void c.sessionManager.updateSession(sessionId, { status: 'error' });
          });
        await new Promise<void>((resolve) => setImmediate(resolve));
        settled = true;
        if (earlyFailure !== undefined) {
          const { err } = earlyFailure;
          throw new Error(`interactive REPL spawn rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
        c.sessionManager.updateSession(sessionId, { status: 'running' });
        return { claudePanelId: panel.id };
      }

      const claudePanelManager = c.getClaudePanelManager();
      if (!claudePanelManager) throw new Error('the Claude panel manager is not available yet');
      claudePanelManager.registerPanel(panel.id, sessionId);
      c.sessionManager.addPanelConversationMessage(panel.id, 'user', brief);
      await claudePanelManager.startPanel(panel.id, worktreePath, brief, permissionMode);
      c.sessionManager.updateSession(sessionId, { status: 'running' });
      return { claudePanelId: panel.id };
    },
  };
}
