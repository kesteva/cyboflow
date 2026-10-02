/**
 * designModeComposition — the Design Mode / Custom Views server + gate wiring,
 * extracted from index.ts's initializeServices() (GitHub issue #19, the
 * god-file split, step 25). It builds, in this order: the shared runaway-frame
 * DesignFrameWatchdog, the token-gated DesignPrototypeServerManager (+ its
 * IPC handlers), the Custom Views tier-3 CustomWidgetServerManager,
 * DesignHandoffService, GateSideEffects, and the DesignFeedbackOutbox (+ the
 * sendDesignBatch notifier). The body is index.ts's verbatim, apart from:
 *
 * - The three index.ts module holders it used to ASSIGN
 *   (designPrototypeServerManager, customWidgetServerManager,
 *   designFeedbackOutbox) are locals here, assigned by the SAME verbatim
 *   statements, then RETURNED and assigned at the call site. The watchdog's
 *   getTargets and the batch notifier close over these locals exactly as they
 *   closed over the module holders (same assign-after-construct order); the
 *   holders are never reassigned afterwards, so both always name the same
 *   instances. index.ts's own readers (createContext, the window 'closed'
 *   handler, recoverOnBoot, drainOnQuit) all run after the call site.
 * - One GETTER: `getMainWindow` → index.ts's `mainWindow`, read at call time
 *   by the watchdog's frame/renderer seams and the server-stopped notice. It
 *   MUST be lazy: this runs before createWindow() assigns the window, and the
 *   window is nulled / reassigned over the app's life.
 *
 * Passed by value: `services` (the AppServices bag registerIpcHandlers gets),
 * cyboflowDb, cyboflowLogger (initializeServices() consts), databaseService,
 * sessionManager and customViewsStore (module holders assigned once earlier in
 * initializeServices() and never reassigned).
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports
 * electron + concrete services, so it must stay OUT of
 * main/src/orchestrator/** (the standalone-typecheck invariant scans that
 * tree). No unit test, as there was none over initializeServices(). The lazy
 * `require('./ipc/claudePanel')` resolves identically from here (same
 * directory as index.ts).
 *
 * ORDER IS LOAD-BEARING at the call site: after registerIpcHandlers (the
 * outbox's dispatchTurn needs claudePanelManager) and after ReviewItemRouter /
 * IdeaComponentRouter / FeedbackRouter initialize (GateSideEffects and the
 * outbox capture their getInstance()).
 */

import { app, ipcMain, type BrowserWindow } from 'electron';
import * as os from 'os';
import { registerDesignPrototypeServerHandlers } from './ipc/designPrototypeServer';
import { DesignPrototypeServerManager } from './services/designPrototypeServer';
import {
  DesignFrameWatchdog,
  DESIGN_PROTO_SERVER_EVENT_CHANNEL,
  type FrameLike,
} from './services/designFrameWatchdog';
import { loadCanonicalPrototypeHtml } from './ipc/artifactHtml';
import { CustomWidgetServerManager } from './services/customWidgetServer';
import { WIDGET_THEME_TOKENS } from '../../shared/customViews/theme';
import { DesignHandoffService } from './orchestrator/design/designHandoffService';
import { GateSideEffects } from './orchestrator/gateSideEffects';
import { IdeaComponentRouter } from './orchestrator/ideaComponents/ideaComponentRouter';
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { FeedbackRouter } from './orchestrator/feedbackRouter';
import {
  DesignFeedbackOutbox,
  setDesignBatchNotifier,
} from './orchestrator/feedback/designFeedbackOutbox';
import { panelManager } from './services/panelManager';
import { getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import type { AppServices } from './ipc/types';
import type { CustomViewsDbStore } from './orchestrator/customViews/customViewsStore';
import type { DatabaseService } from './database/database';
import type { SessionManager } from './services/sessionManager';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface DesignModeCompositionDeps {
  services: AppServices;
  cyboflowDb: DatabaseLike;
  cyboflowLogger: LoggerLike;
  databaseService: DatabaseService;
  sessionManager: SessionManager;
  customViewsStore: CustomViewsDbStore | null;
  /** index.ts's live `mainWindow` binding — null until createWindow(). */
  getMainWindow: () => BrowserWindow | null;
}

/** The module holders index.ts assigns from this block's output. */
export interface DesignModeComposition {
  designPrototypeServerManager: DesignPrototypeServerManager | null;
  customWidgetServerManager: CustomWidgetServerManager | null;
  designFeedbackOutbox: DesignFeedbackOutbox | null;
}

export function composeDesignMode(deps: DesignModeCompositionDeps): DesignModeComposition {
  const { services, cyboflowDb, cyboflowLogger, databaseService, sessionManager, customViewsStore, getMainWindow } =
    deps;

  // Assigned below by the verbatim statements, then returned (see header).
  let designPrototypeServerManager: DesignPrototypeServerManager | null = null;
  let customWidgetServerManager: CustomWidgetServerManager | null = null;
  let designFeedbackOutbox: DesignFeedbackOutbox | null = null;

  // Design Mode v1 (design-mode.md "Process isolation" + "Server lifecycle") —
  // the token-gated loopback prototype server + its runaway-frame watchdog. The
  // watchdog reads the main window's frame subtree, per-process metrics, and cpu
  // count via Electron-backed seams (the service modules stay Electron-free); the
  // manager loads the canonical interactive-prototype bytes fresh per request. The
  // two reference each other (watchdog reads the manager's live targets; the
  // manager start/stops the watchdog), so the watchdog closes over the
  // module-level manager var, which is assigned on the next line.
  const designFrameWatchdog = new DesignFrameWatchdog({
    // Both loopback servers share this ONE watchdog instance — the Custom
    // Views tier-3 widget server (docs/proposals/CUSTOM-VIEWS.md §5.4) is a
    // second, process-global source of scripted frames, so its live target is
    // concatenated onto the design-prototype server's per-run ones.
    getTargets: () => [...(designPrototypeServerManager?.getTargets() ?? []), ...(customWidgetServerManager?.getTargets() ?? [])],
    getFrames: () => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return [];
      try {
        // A killed OOPIF's WebFrameMain throws on property access — the watchdog
        // guards each read; enumerating the subtree itself is guarded here.
        return win.webContents.mainFrame.framesInSubtree as unknown as FrameLike[];
      } catch {
        return [];
      }
    },
    getMetrics: () =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        percentCPUUsage: m.cpu?.percentCPUUsage ?? 0,
        workingSetSizeKB: m.memory?.workingSetSize ?? 0,
      })),
    killPid: (pid: number) => process.kill(pid, 'SIGKILL'),
    sendToRenderer: (event) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(DESIGN_PROTO_SERVER_EVENT_CHANNEL, event);
    },
    cpuCount: os.cpus().length,
    logger: cyboflowLogger,
  });
  designPrototypeServerManager = new DesignPrototypeServerManager({
    loadHtml: (runId: string) => loadCanonicalPrototypeHtml(services, runId, 'interactive-prototype'),
    watchdog: designFrameWatchdog,
    onServerStopped: (runId: string) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(DESIGN_PROTO_SERVER_EVENT_CHANNEL, { runId, kind: 'server-stopped' });
    },
    logger: cyboflowLogger,
  });
  registerDesignPrototypeServerHandlers(ipcMain, designPrototypeServerManager);
  // Custom Views tier-3 widget document server (docs/proposals/CUSTOM-VIEWS.md
  // §5.4) — the SAME watchdog as the prototype server above (its getTargets
  // already concatenates both managers). loadWidget reads the store built in
  // initializeServices(); customViewsStore is non-null by the time a widget
  // frame can request one (it is constructed before this window-bound wiring
  // ever runs), but the closure guards it defensively anyway.
  customWidgetServerManager = new CustomWidgetServerManager({
    loadWidget: (widgetId: string) => customViewsStore?.getWidget(widgetId) ?? null,
    theme: WIDGET_THEME_TOKENS,
    watchdog: designFrameWatchdog,
    logger: cyboflowLogger,
  });
  // No ipcMain.handle registration here — customWidgetServerManager.ensure/stop
  // are exposed as the cyboflow.customWidgetServer tRPC router (ratchet-blocked
  // otherwise: main/src/ipc/__tests__/noNewIpcHandlers.test.ts). Wired into
  // createContext via `customWidgetServer: customWidgetServerManager ?? undefined`
  // below, alongside `customViews`.
  // Design Mode v0 (design-mode.md) — the Approve intent-first state machine. The
  // cyboflow.design tRPC router (standalone-typecheck-clean) reaches this singleton
  // via getInstance(); boot recovery reads its deps bag. The prototype-byte reader
  // + snapshot base dir are injected here (electron-backed) so the service module
  // stays standalone-typecheck-safe. loadPrototypeHtml returns the RAW canonical
  // bytes (live subtree, else committed store); the render path injects the CSP.
  DesignHandoffService.initialize({
    db: cyboflowDb,
    loadPrototypeHtml: (runId: string, atype: string) => loadCanonicalPrototypeHtml(services, runId, atype),
    snapshotBaseDir: getCyboflowSubdirectory('design-snapshots'),
    logger: cyboflowLogger,
  });
  // Design/brief GATE side effects — the one place a human's "approve" at an
  // approve-ideas / approve-design / approve-brief gate becomes durable state:
  // the run's prototype bound to each approved idea as an `approved_designs` row
  // (which survives the run's artifact cascade delete, unlike the artifact
  // itself), the project's solution thoroughness stamped from the brief, and the
  // adversarial reviewer's remaining entries logged as accepted-risk findings.
  //
  // A singleton for the same reason DesignHandoffService is one: three call sites
  // reach it — the programmatic gate opener below, `resolveReviewItem` for the
  // orchestrated plane, and runExecutor's settle — and two of those build their
  // dependency bags in separate files. Threaded as an optional dep instead, it
  // would compile at both and silently do nothing at one.
  //
  // Wired HERE (after DesignHandoffService) so it shares the SAME snapshot tree
  // and prototype-byte reader: a flow-bound design and a Design Mode approval must
  // be readable through one path. It initializes AFTER ReviewItemRouter /
  // IdeaComponentRouter, whose getInstance() it captures.
  GateSideEffects.initialize({
    db: cyboflowDb,
    snapshotBaseDir: getCyboflowSubdirectory('design-snapshots'),
    loadPrototypeHtml: (runId: string, atype: string) => loadCanonicalPrototypeHtml(services, runId, atype),
    ideaComponentRouter: IdeaComponentRouter.getInstance(),
    reviewItemRouter: ReviewItemRouter.getInstance(),
    // Reuses the EXISTING project-changed channel (the same one projects:update
    // emits on) so the renderer refetches a thoroughness stamp with no new
    // listener — and, critically, no new ipcMain.handle, which the
    // noNewIpcHandlers ratchet would freeze.
    emitProjectUpdated: (projectId: number) => {
      const project = databaseService.getProject(projectId);
      if (project) sessionManager.emit('project:updated', project);
    },
    logger: cyboflowLogger,
  });
  // Design Mode v1 (design-mode.md "Design feedback v1 — acknowledged durable
  // outbox") — the delivery pipeline that drives a queued design-feedback batch
  // through guards → 'dispatching' → the SDK revision turn → 'dispatched', and
  // re-delivers whatever a crash left in flight.
  //
  // Wired HERE, after registerIpcHandlers, because `dispatchTurn` goes through
  // ClaudePanelManager.continuePanel, and claudePanelManager only exists once
  // the IPC handlers are registered. The lazy require mirrors taskQueue's
  // continueQueue — index.ts must not take a static import on ipc/claudePanel.
  //
  // The lifecycle guards are the service's DB-backed defaults; only the SDK turn
  // and the clock are host-supplied.
  designFeedbackOutbox = new DesignFeedbackOutbox({
    db: cyboflowDb,
    feedbackRouter: FeedbackRouter.getInstance(),
    dispatchTurn: async ({ sessionId, prompt }): Promise<void> => {
      const session = sessionManager.getSession(sessionId);
      if (!session) throw new Error(`design session ${sessionId} no longer exists`);
      const claudePanel = panelManager
        .getPanelsForSession(sessionId)
        .find((panel) => panel.type === 'claude');
      if (!claudePanel) throw new Error(`design session ${sessionId} has no Claude panel to deliver the turn to`);
      const { claudePanelManager } = require('./ipc/claudePanel') as typeof import('./ipc/claudePanel');
      if (!claudePanelManager) throw new Error('the Claude panel manager is not available yet');
      const conversationHistory = sessionManager.getPanelConversationMessages(claudePanel.id);
      // Resolves once the SDK has ACCEPTED the turn — that acceptance is exactly
      // what the outbox records as 'dispatched'.
      await claudePanelManager.continuePanel(
        claudePanel.id,
        session.worktreePath,
        prompt,
        conversationHistory,
      );
      // Echo the dispatched turn into the panel transcript, as the chat send
      // paths do — without this the host-sent revision turn is invisible in the
      // design session's chat (the "sends missing from transcript" bug class).
      sessionManager.addPanelConversationMessage(claudePanel.id, 'user', prompt);
    },
    logger: cyboflowLogger,
  });
  // The sendDesignBatch mutation's fire-and-track poke (the design analogue of
  // setRevisionLauncher). notifyQueued never rejects, so voiding it is safe.
  setDesignBatchNotifier((batchId: string) => {
    void designFeedbackOutbox?.notifyQueued(batchId);
  });

  return { designPrototypeServerManager, customWidgetServerManager, designFeedbackOutbox };
}
