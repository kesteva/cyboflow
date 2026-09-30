/**
 * orchSocketComposition — the OrchSocketServer construction + start, extracted
 * from index.ts's initializeServices() (GitHub issue #19, the god-file split,
 * step 21). It stands up the orchestrator-side half of the Cyboflow MCP IPC
 * link with its full McpQueryHandler deps bag (interactive turn-end / question
 * seams, the global-agent proposal store, custom views, assistant folder
 * access, the machine-local runbook store, the live visual-verify / sprint-cap
 * config reads, the web-viewer agent, the workflow/variant config surface, and
 * the ad-hoc eval), then starts it. The body is index.ts's verbatim, apart
 * from its inputs arriving as deps and the server + its start promise being
 * RETURNED (index.ts's later wiring — the socket provider, the MCP lifecycle
 * gate, the shell-approval canceller, OrchestratorHealth — consumes both).
 *
 * No getters: every value read here is either evaluated at construction time
 * in the original too (agentThreadStore, customViewsService,
 * webViewerComposition — each assigned just above the call site) or a holder
 * assigned once in initializeServices() before this runs and never reassigned
 * (configManager, workflowRegistry); interactiveCliManager, verifyRunbookStore,
 * cyboflowDb and cyboflowLogger are initializeServices() consts.
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports
 * concrete services, so it must stay OUT of main/src/orchestrator/** (the
 * standalone-typecheck invariant scans that tree). No unit test, as there was
 * none over initializeServices(); orchSocketServer / mcpQueryHandler carry
 * their own suites.
 *
 * ORDER IS LOAD-BEARING at the call site: VerificationScheduler.initialize()
 * and EvalWorker.initialize() must precede it (handlers reach both singletons
 * via getInstance()), and it must precede the RunLauncher / McpServerLifecycle /
 * CLI-manager wiring that reads its socket path.
 */

import { getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import { OrchSocketServer } from './orchestrator/mcpServer/orchSocketServer';
import { orchSocketEndpoint } from './orchestrator/mcpServer/orchSocketEndpoint';
import { EvalWorker } from './orchestrator/eval/evalWorker';
import { buildBuiltInWorkflows } from './orchestrator/workflows/builtInWorkflows';
import type { InteractiveClaudeManager } from './services/panels/claude/interactiveClaudeManager';
import type { AgentThreadDbStore } from './orchestrator/agentThread/agentThreadDbStore';
import type { CustomViewsServiceLike } from './orchestrator/customViews/customViewsService';
import type { VerifyRunbookStore } from './orchestrator/verify/runbookStore';
import type { composeWebViewer } from './webViewerComposition';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { ConfigManager } from './services/configManager';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface OrchSocketCompositionDeps {
  cyboflowDb: DatabaseLike;
  cyboflowLogger: LoggerLike;
  /** Narrowed to the concrete class at its construction site in initializeServices(). */
  interactiveCliManager: InteractiveClaudeManager;
  agentThreadStore: AgentThreadDbStore;
  customViewsService: CustomViewsServiceLike | null;
  /** From composeVerification() — the SAME store the VerificationScheduler proves against. */
  verifyRunbookStore: VerifyRunbookStore;
  webViewerComposition: ReturnType<typeof composeWebViewer> | undefined;
  configManager: ConfigManager;
  workflowRegistry: WorkflowRegistry;
}

export interface OrchSocketComposition {
  orchSocketServer: OrchSocketServer;
  /** start()'s promise — gates the MCP subprocess on the socket actually listening. */
  orchSocketReady: Promise<void>;
}

export function composeOrchSocketServer(deps: OrchSocketCompositionDeps): OrchSocketComposition {
  const {
    cyboflowDb,
    cyboflowLogger,
    interactiveCliManager,
    agentThreadStore,
    customViewsService,
    verifyRunbookStore,
    webViewerComposition,
    configManager,
    workflowRegistry,
  } = deps;

  // OrchSocketServer — the orchestrator-side half of the Cyboflow MCP IPC link.
  // Stands up the Unix-domain socket under ~/.cyboflow/sockets/orch.sock that the
  // spawned cyboflowMcpServer subprocess(es) connect back to so the cyboflow_*
  // tools are routable.  Started here (before the RunLauncher block) so its
  // socket path is available to the providers, the McpServerLifecycle, and the
  // CLI manager below.  `cyboflowDb`/`cyboflowLogger` are already in scope above.
  // `onInteractiveTurnEnd` wires the Stop-hook turn-end seam (IDEA-030):
  // mcpQueryHandler cannot import main/src/services directly (ORCHESTRATOR
  // LAYERING RULE), so the callback is threaded in here where
  // `interactiveCliManager` is already narrowed to InteractiveClaudeManager
  // (the throw-guard above at its construction site).
  const orchSocketServer = new OrchSocketServer(
    orchSocketEndpoint(getCyboflowSubdirectory('sockets', 'orch.sock')),
    cyboflowDb,
    cyboflowLogger,
    {
      onInteractiveTurnEnd: (runId) => interactiveCliManager.notifyTurnEnd(runId),
      onInteractiveQuestionOpen: (runId) => interactiveCliManager.notifyQuestionOpen(runId),
      // Global-agent proposal writer: the cyboflow_propose_action MCP tool (global
      // scope) inserts agent_proposals rows through this store. Without it the
      // handler fails closed (returns an error) — so it must be the SAME instance
      // the executor + tRPC context read.
      agentThreadStore,
      // Custom-widget-authoring global-agent tools (cyboflow_db_schema /
      // _widget_preview / _widget_save, docs/proposals/CUSTOM-VIEWS.md §9 row
      // S6): the SAME `customViewsService` instance constructed above, so a
      // saved widget draft is visible to the exact service the renderer's
      // tRPC router reads. Absent only if this handler runs before boot
      // wiring completes (never the case in production).
      customViews: customViewsService ?? undefined,
      // Global-agent scoped filesystem tools (cyboflow_fs_read / _list / _grep):
      // the always-included roots are the registered project paths; this dep
      // supplies the user-configured EXTRA folders on top. Absent ⇒ [] (project
      // folders only). The orchestrator handler realpath's + scope-checks every
      // access — this only widens the root set, never bypasses enforcement.
      getAssistantFolderAccess: () => configManager.getAssistantFolderAccess(),
      getAssistantExcludedProjectPaths: () => configManager.getAssistantExcludedProjectPaths(),
      // Phase 2 §5.2 seam 1: the cyboflow_register_verify_runbook tool writes the
      // MACHINE-LOCAL runbook record through this store. Deliberately the SAME
      // instance the VerificationScheduler was initialized with above — the setup
      // flow registers a draft here and the ENGINE proves that exact record on a
      // passing setup-proof run, so the two halves of "derive → prove" must be
      // looking at one store over one DB.
      verifyRunbookStore,
      // The GLOBAL visual-verify config, read LIVE per call — the same accessor
      // the WorkflowRegistry injects into createRun. Only the `__quick__` chat
      // sentinel consults it: its run stamp is minted on the session's first turn
      // and has no UPDATE path, so a quick session resolves its verify posture at
      // CALL time through this closure instead. A closure (not the resolved value)
      // so toggling the master switch in Settings takes effect on the next tool
      // call rather than requiring a restart.
      getVisualVerifyConfig: () => configManager.getVisualVerifyConfig(),
      // The sprint task-cap override, read LIVE for the same reason: the
      // cyboflow_create_sprint_batch backstop must honor the CURRENT setting, not
      // one frozen at launch.
      getSprintMaxTasks: () => configManager.getSprintMaxTasks(),
      // Web-viewer observe tools; consent lives behind the seam (webViewerComposition.ts).
      webViewerAgent: webViewerComposition?.webViewerAgent,
      // Workflow/variant configuration tools (cyboflow_*_workflow / _variant):
      // forward the WorkflowRegistry as the narrow WorkflowConfigLike structural
      // surface so quick sessions can edit flows + variants over MCP without the
      // handler importing the concrete registry. ensureGlobalBuiltIns is a
      // zero-arg closure here (supplying the in-repo built-ins), matching the
      // structural type; every other method forwards 1:1.
      workflowConfig: {
        getById: (id) => workflowRegistry.getById(id),
        listByProject: (projectId) => workflowRegistry.listByProject(projectId),
        ensureGlobalBuiltIns: () => workflowRegistry.ensureGlobalBuiltIns(buildBuiltInWorkflows()),
        getBaselineRotation: (id) => workflowRegistry.getBaselineRotation(id),
        getEffectiveDefinition: (id) => workflowRegistry.getEffectiveDefinition(id),
        updateSpec: (id, def) => workflowRegistry.updateSpec(id, def),
        resetSpec: (id) => workflowRegistry.resetSpec(id),
        createCustom: (params) => workflowRegistry.createCustom(params),
        deleteWorkflow: (id) => workflowRegistry.deleteWorkflow(id),
        listVariants: (id, opts) => workflowRegistry.listVariants(id, opts),
        createVariantFromCurrent: (id, label, opts) =>
          workflowRegistry.createVariantFromCurrent(id, label, opts),
        updateVariant: (variantId, patch) => workflowRegistry.updateVariant(variantId, patch),
        setVariantStatus: (variantId, status) => workflowRegistry.setVariantStatus(variantId, status),
        deleteVariant: (variantId) => workflowRegistry.deleteVariant(variantId),
        setBaselineRotation: (id, patch) => workflowRegistry.setBaselineRotation(id, patch),
      },
      // Ad-hoc code-review eval tool (cyboflow_run_eval): forward to the EvalWorker
      // singleton initialized above, which owns the ONE definition of the snapshot
      // deps (diff closure, app version, config toggles, enqueue) shared with the
      // automatic human-review trigger — so the two mint paths can never drift.
      // Deliberately NOT error-swallowed here (unlike the automatic trigger's
      // snapshot()): an explicit caller must get a reason, and the MCP handler maps
      // a throw to an ok:false reply.
      runAdHocEval: (runId) => EvalWorker.getInstance().runAdHoc(runId),
    },
  );
  // Keep the start promise so the MCP subprocess (below) can be gated on the
  // socket actually listening — it is a pure client and dies with ECONNREFUSED if
  // it connects before the bind completes. The dedicated .catch here keeps a bind
  // failure from surfacing as an unhandled rejection before that gate attaches.
  const orchSocketReady = orchSocketServer.start();
  orchSocketReady.catch((err) => {
    cyboflowLogger.error(
      `[Cyboflow Orch IPC] socket server start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return { orchSocketServer, orchSocketReady };
}
