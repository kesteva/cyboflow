/**
 * designSessionLaunchComposition — the design-mode-fork launch deps, extracted
 * from index.ts's app.whenReady() dep-wiring block (GitHub issue #19, the
 * god-file split, step 18). It hands QuestionRouter.setDesignSessionLaunchDeps()
 * the idea-link validation, the SDK-pinned design-session create (pre-flight
 * ladder, createQuickSessionCore, the design_idea_id / origin_idea_id stamp,
 * compensation, the ui-prototype stub), the Chat-panel kickoff, the full
 * dismiss, and the launch-failure review item. The body is index.ts's
 * verbatim, apart from its inputs arriving as deps; the
 * DESIGN_FORK_PREFLIGHT_MESSAGES wording table (read only here) moved with it.
 *
 * No getters: every module-level holder the closures read (configManager,
 * taskQueue, sessionManager, workflowRegistry, databaseService) is assigned
 * exactly once in initializeServices(), which app.whenReady() awaits before
 * this runs, and none is ever reassigned — so passing the values is identical
 * to index.ts reading the live bindings. dismissSessionFully and loggerLike are
 * whenReady-local consts.
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports
 * concrete services, so it must stay OUT of main/src/orchestrator/** (the
 * standalone-typecheck invariant scans that tree). No unit test, as there was
 * none over the inline block; designSessionLaunch.ts's own suite covers the
 * saga. The lazy `require('./ipc/claudePanel')` resolves identically from here
 * (same directory as index.ts).
 */

import { QuestionRouter } from './orchestrator/questionRouter';
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { ArtifactRouter } from './orchestrator/artifactRouter';
import { panelManager } from './services/panelManager';
import { createQuickSessionCore } from './services/createQuickSessionCore';
import type { ClaudePanelState } from '../../shared/types/panels';
import {
  DESIGN_MODE_KICKOFF_PROMPT,
  finishDesignSessionCreate,
  type DesignSessionLaunchDeps,
} from './orchestrator/designSessionLaunch';
import { validateDesignIdeaLink } from './services/designIdeaValidation';
import {
  runClaudeSdkSessionPreflights,
  type ClaudeSdkPreflightFailure,
} from './services/claudeSdkSessionPreflight';
import { findIdeaBusyReason } from './orchestrator/ideaBusy';
import type { TaskQueue } from './services/taskQueue';
import type { SessionManager } from './services/sessionManager';
import type { DatabaseService } from './database/database';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { ConfigManager } from './services/configManager';
import type { LoggerLike } from './orchestrator/types';

/**
 * Design-mode-FORK wording for each rung of the shared SDK-pinned pre-flight
 * ladder (services/claudeSdkSessionPreflight.ts). Deliberately terser than the
 * `sessions:create-quick` handler's copy — this fork has no renderer client, so
 * the text lands in a review-queue finding rather than a toast. Kept
 * byte-identical to what createDesignSession threw before the ladder was
 * extracted.
 */
const DESIGN_FORK_PREFLIGHT_MESSAGES: Readonly<Record<ClaudeSdkPreflightFailure, string>> = {
  provider_disabled: 'Design sessions require Claude, which is turned off in Settings → Integrations.',
  claude_not_detected:
    'Design sessions require the Claude SDK substrate — Claude credentials/binary not detected.',
  interactive_pty_only:
    'Design sessions cannot run on the interactive substrate, but this app is locked to interactive-PTY-only mode.',
};

export interface DesignSessionLaunchCompositionDeps {
  loggerLike: LoggerLike;
  /** The FULL safe session-dismiss path (also the compensation primitive). */
  dismissSessionFully: (sessionId: string) => Promise<void>;
  configManager: ConfigManager;
  taskQueue: TaskQueue | null;
  sessionManager: SessionManager;
  workflowRegistry: WorkflowRegistry;
  databaseService: DatabaseService;
}

export function composeDesignSessionLaunchDeps(deps: DesignSessionLaunchCompositionDeps): void {
  const {
    loggerLike,
    dismissSessionFully,
    configManager,
    taskQueue,
    sessionManager,
    workflowRegistry,
    databaseService,
  } = deps;

  // Design-mode-fork launch saga (QuestionRouter.launchDesignModeOnFork /
  // designSessionLaunch.ts). A HUMAN answering the planner's approve-idea gate
  // with "Approve → design mode" launches a Design Mode session — the SAME
  // three-layer belt sessions:create-quick's design branch drives
  // (ipc/session.ts ~787-1091: validateDesignIdeaLink, createQuickSessionCore
  // with requireSdkSubstrate, the design_idea_id stamp + ui-prototype stub),
  // replayed here since this launch has no renderer client. Compensation
  // (dismissSessionFully) and the review-item failure report reuse the SAME
  // primitives proposalExecutorDeps wires just above.
  QuestionRouter.getInstance().setDesignSessionLaunchDeps({
    validateIdeaLink: (ideaId, projectId) => {
      const result = validateDesignIdeaLink(databaseService.getDb(), ideaId, projectId);
      if (!result.ok) return { ok: false, error: result.error };
      // Max-one-running-per-idea (idea sessions plan, Stage 1): the design
      // fork is one of the doors the hard rule guards. Same rejection channel
      // as a dead idea link — the saga reports either as "could not launch".
      const busy = findIdeaBusyReason(databaseService.getDb(), ideaId);
      return busy === null ? { ok: true } : { ok: false, error: busy.message };
    },
    createDesignSession: async ({ projectId, ideaId, nameHint }) => {
      // Fail-closed Claude/SDK availability pre-flight — the SHARED ladder
      // (services/claudeSdkSessionPreflight.ts) the design branch of
      // sessions:create-quick and the open-idea-session door also run: a
      // design session is hard-pinned to the Claude SDK substrate, so an
      // unavailable Claude login/binary must reject BEFORE any worktree is
      // cut, rather than let substrate resolution silently fall through. Only
      // the wording is local — this fork's messages are terser than the IPC
      // handler's (no "Enable Claude to start a design session." tail) and
      // stay byte-identical to what it threw before the extraction.
      const designPreflight = await runClaudeSdkSessionPreflights(configManager);
      if (!designPreflight.ok) {
        throw new Error(DESIGN_FORK_PREFLIGHT_MESSAGES[designPreflight.reason]);
      }

      const { session, runId, resolvedSubstrate } = await createQuickSessionCore(
        {
          taskQueue: taskQueue!,
          sessionManager,
          workflowRegistry,
          getDb: () => databaseService.getDb(),
        },
        {
          projectId,
          nameHint,
          agentProvider: 'claude',
          agentRuntime: 'claude-sdk',
          requestedSubstrate: 'sdk',
          requireSdkSubstrate: true,
        },
      );
      // From here down, createQuickSessionCore has ALREADY minted a real
      // session + sentinel run + git worktree — anything that throws past
      // this point must compensate via a full dismiss before propagating,
      // because launchDesignSessionForFork (designSessionLaunch.ts) only
      // records `created.sessionId` once THIS callback resolves; a throw
      // from inside it leaves the saga's own catch block with no id to
      // dismiss, orphaning the session/run/worktree. finishDesignSessionCreate
      // (designSessionLaunch.ts) owns that internal compensation — see its
      // JSDoc for why this is NOT redundant with the saga's own dismiss (the
      // two only ever apply in mutually exclusive windows): do NOT also add
      // a dismiss to the saga's catch for this failure mode.
      await finishDesignSessionCreate({
        sessionId: session.id,
        resolvedSubstrate,
        stampDesignIdeaId: () => {
          const dbHandle = databaseService.getDb();
          dbHandle.prepare(`UPDATE sessions SET design_idea_id = ? WHERE id = ?`).run(ideaId, session.id);
          // `origin_idea_id` (migration 114): a design session IS a session
          // launched from the idea, and the sidebar nests children by that
          // column. Lineage, not a claim — no unique index. Kept a SEPARATE
          // statement, mirroring the sessions:create-quick design branch.
          dbHandle.prepare(`UPDATE sessions SET origin_idea_id = ? WHERE id = ?`).run(ideaId, session.id);
        },
        refreshSession: (sessionId) => {
          sessionManager.refreshSessionFromDatabase(sessionId);
        },
        dismissSession: dismissSessionFully,
        onCompensationFailure: (dismissErr) => {
          loggerLike.warn('[Main] design-mode fork: compensating dismiss failed after mid-create error', {
            sessionId: session.id,
            error: dismissErr instanceof Error ? dismissErr.message : String(dismissErr),
          });
        },
      });

      // v0.5 re-entry stub (mirrors ipc/session.ts ~1064-1090) — fail-soft: a
      // stub failure must never fail session creation. Deliberately called
      // AFTER finishDesignSessionCreate rather than folded into it — this
      // failure mode is intentionally NOT compensating.
      try {
        await ArtifactRouter.getInstance().apply(projectId, {
          op: 'create',
          runId,
          atype: 'ui-prototype',
          label: 'Prototype',
          payloadJson: null,
          sourceRef: ideaId,
          sessionId: session.id,
          isNew: true,
          actor: 'orchestrator',
        });
      } catch (stubErr) {
        loggerLike.warn('[Main] design-mode fork: prototype stub creation failed (non-fatal)', {
          sessionId: session.id,
          error: stubErr instanceof Error ? stubErr.message : String(stubErr),
        });
      }

      return { sessionId: session.id, runId, worktreePath: session.worktreePath };
    },
    kickoffDesignPanel: async ({ sessionId, worktreePath }) => {
      // Mirrors useQuickSession.ts's post-create sequence: create the Chat
      // panel, register it with the Claude runtime, then fire the canonical
      // design kickoff prompt as its first turn via startPanel — a FRESH
      // panel has no running process and no claude_session_id yet, so this is
      // the 'panels:continue' first-message branch (ipc/session.ts ~2783-2797),
      // never continuePanel/resume.
      const panel = await panelManager.createPanel({ sessionId, type: 'claude', title: 'Chat' });
      const { claudePanelManager } = require('./ipc/claudePanel') as typeof import('./ipc/claudePanel');
      if (!claudePanelManager) throw new Error('the Claude panel manager is not available yet');
      // We just created this panel with type 'claude', so its customState IS a
      // ClaudePanelState — but ToolPanel's `state.customState` is a union across
      // every panel kind with no discriminant tying it to `panel.type`, so TS
      // cannot see that. The parallel call in ipc/panels.ts:36 passes it
      // unnarrowed only because its `require` is untyped; narrow here rather
      // than giving up the typed import.
      claudePanelManager.registerPanel(
        panel.id,
        panel.sessionId,
        panel.type === 'claude'
          ? (panel.state.customState as ClaudePanelState | undefined)
          : undefined,
      );

      const kickoffPrompt = DESIGN_MODE_KICKOFF_PROMPT;
      sessionManager.addPanelConversationMessage(panel.id, 'user', kickoffPrompt);
      const dbSession = sessionManager.getDbSession(sessionId);
      await claudePanelManager.startPanel(panel.id, worktreePath, kickoffPrompt, dbSession?.permission_mode);
    },
    dismissSession: dismissSessionFully,
    reportLaunchFailure: ({ projectId, ideaId, runId, error }) => {
      void ReviewItemRouter.getInstance()
        .applyReviewItem(projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'finding',
          title: 'Design mode launch failed',
          body:
            `The approve-idea gate's design-mode fork could not launch a design session ` +
            `for idea ${ideaId} (run ${runId}): ${error}\n\nOpen the idea's prototype from the ` +
            `backlog and start a design session manually, or re-run the planner and pick ` +
            `"Approve → design mode" again.`,
          blocking: false,
          severity: 'error',
          entityType: 'idea',
          entityId: ideaId,
          runId,
          payload: { kind: 'finding', category: 'design-mode-launch' },
        })
        .catch((err) => {
          loggerLike.error('[Main] design-mode fork: failed to report launch failure', {
            ideaId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  } satisfies DesignSessionLaunchDeps);
  console.log('[Main] design-mode-fork launch deps wired');
}
