/**
 * useQuickSession — shared hook for creating a quick session (no workflow run).
 *
 * Lifecycle:
 *   1. Calls API.sessions.createQuick({ prompt: '', projectId })
 *   2. On success, creates both panels in sequence:
 *      a. Claude panel — SKIPPED when the response carries `claudePanelId`
 *         (interactive sessions: the server eagerly created the panel when it
 *         spawned the persistent PTY REPL)
 *      b. Terminal panel (cwd = worktreePath) — always
 *   3. Calls useCyboflowStore.getState().setActiveQuickSession(sessionId, runId)
 *   4. If `kickoffPrompt` was passed AND a Claude panel was created above (2a),
 *      fires it as that panel's first turn — fire-and-forget, see `start`'s doc.
 *   5. Calls opts.onSuccess?.(sessionId)
 *   6. Clears isStarting (finally)
 *
 * Guards:
 *   - No-ops when projectId is null or a start is already in-flight.
 *
 * This hook replaces the inline handleQuickStart / handlePickQuickMode logic in
 * WorkflowPicker.tsx and CyboflowRoot.tsx, fixing the FIND-SPRINT-037-3 orphan
 * worktree bug where CyboflowRoot skipped panelApi.createPanel and
 * setActiveQuickSession entirely.
 */
import { useState, useCallback } from 'react';
import { API } from '../utils/api';
import { panelApi } from '../services/panelApi';
import { trackEvent } from '../utils/telemetry';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { usePanelStore } from '../stores/panelStore';
import { useConfigStore } from '../stores/configStore';
import { dispatchQuickSessionInput } from './useClaudePanel';
import type { Session } from '../types/session';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { AgentProvider, SessionAgentRuntime } from '../../../shared/types/agentRuntime';
import { isSessionAgentRuntime, providerForRuntime } from '../../../shared/types/agentRuntime';
import { runtimeSupportsEffort } from '../../../shared/types/agentCapabilities';
import { DEFAULT_CODEX_MODEL, isCodexModelSelection } from '../../../shared/types/agentModels';
import type { ReasoningEffort } from '../../../shared/types/reasoningEffort';
import type { RunTypeLaunchGlobals } from '../../../shared/types/sessionDefaults';
import {
  DEFAULT_QUICK_SUBSTRATE,
  DEFAULT_RUN_TYPE_MODEL_FLOORS,
  QUICK_RUN_TYPE_KEY,
  resolveRunTypeLaunchDefaults,
} from '../../../shared/types/sessionDefaults';

interface UseQuickSessionOptions {
  projectId: number | null;
  onSuccess?: (sessionId: string) => void;
}

interface UseQuickSessionReturn {
  /**
   * Create the quick session. An optional per-session 4-mode agent-permission
   * override (Session Start Wizard step 3) is threaded into createQuick and
   * persisted on the session; omitted → the session inherits the global default.
   * An optional CLI substrate ('sdk'|'interactive') is likewise threaded and
   * stamped onto sessions.substrate; omitted → SDK (legacy behavior). An optional
   * `effort` ('ultracode') launches the interactive REPL with the ultracode
   * setting (the Ultracode wizard card); omitted → no effort setting.
   *
   * `model` (the Configure model dropdown, e.g. 'opus') and `fastMode` (the
   * fast-mode toggle, default off) are persisted on the claude panel — directly
   * for the frontend-created SDK panel, and via the createQuick request for the
   * interactive eager spawn — so the per-turn respawn (sessions:input) applies them.
   *
   * `worktreeMode` ('worktree' | 'in-place') threads the wizard's Workspace choice
   * into createQuick; omitted → the server floors to the global default. 'in-place'
   * skips worktree creation and works directly in the project checkout (both
   * substrates — the interactive gate needs no checkout writes).
   *
   * `reasoningEffort` (IDEA-029, the wizard's effort select / the in-composer
   * EffortPill) rides claudeConfig alongside model/fastMode for the interactive
   * eager spawn, and is persisted on the frontend-created panel the same way model
   * is — for Claude SDK AND every structured non-Claude runtime with no eager
   * server spawn of its own (codex-sdk, omp-sdk): each has its panel
   * frontend-created here, and its turn-start seam reads the persisted effort
   * per turn. A runtime whose RUNTIME_CAPABILITIES.supportsEffort is false is
   * excluded — codex-pty/omp-pty emit no effort flag and their panels are
   * server-eager-created, so neither reaches the persistence branch. The
   * claudeConfig ride stays Claude-only (create-quick reads it for
   * `quickAgentProvider === 'claude'`); codex-sdk and omp-sdk rely solely on the
   * setEffort persistence below.
   *
   * `designIdeaId` (Design Mode, design-mode.md): the idea a design session
   * binds to, threaded into createQuick so the server can validate the idea
   * (exists, owned by the project, not decomposed) and stamp
   * sessions.design_idea_id. Only sent by the wizard's Design arm, which also
   * forces `substrate`/`agentProvider`/`agentRuntime` to 'sdk'/'claude'/
   * 'claude-sdk' regardless of the caller's other params (a security boundary
   * — the MCP scope mechanism that limits a design session's toolset exists
   * only on the SDK path). Omitted for every non-design launch.
   *
   * `kickoffPrompt` (Design Mode v0.5, "Auto-start"): an optional canonical
   * first-turn message sent as the session's first panel input immediately
   * after the Claude panel is created and setActiveQuickSession has run —
   * NOT via createQuick's `prompt` field, which the SDK path ignores entirely
   * (createQuickSessionCore hardcodes `prompt: ''`). Uses the same dispatch
   * the chat composer uses (`dispatchQuickSessionInput`), so it renders as a
   * real, visible, restart-safe first user turn — deliberately not a
   * synthetic/hidden one. Only fires when a Claude panel was created on THIS
   * client call (the `claudePanelId === undefined` branch below) — an
   * eagerly server-spawned panel (interactive substrate) has no seam here,
   * and design sessions are SDK-pinned regardless. Dispatched
   * fire-and-forget: a failed kickoff send is logged and must never fail
   * session creation. Omitted for every non-design launch (every existing
   * caller keeps its current behavior unchanged).
   */
  start: (
    agentPermissionMode?: PermissionMode,
    substrate?: CliSubstrate,
    effort?: 'ultracode',
    model?: string,
    fastMode?: boolean,
    disabledMcpServers?: string[],
    enabledPlugins?: string[],
    worktreeMode?: QuickSessionWorktreeMode,
    agentProvider?: AgentProvider,
    agentRuntime?: SessionAgentRuntime,
    reasoningEffort?: ReasoningEffort,
    designIdeaId?: string,
    kickoffPrompt?: string,
    baseBranch?: string,
    /** Launch into this project instead of the hook's `projectId`. */
    projectIdOverride?: number,
  ) => Promise<void>;
  /**
   * Zero-arg-friendly entry point for launches that only know a run-type key
   * (e.g. the synthetic global `'quick'` key used by the ⌘-shortcut / "New
   * quick session" affordance) — NOT a `start` replacement. Delegates the
   * whole ladder (stored per-type default → global config default → floor) to
   * the canonical `resolveRunTypeLaunchDefaults`, then threads every resolved
   * field — model, permissionMode, substrate, agentRuntime, reasoningEffort —
   * into `start`'s existing positional args, so a saved Quick Session default
   * (Settings → "Run type defaults") is honored rather than write-only.
   *
   * `reasoningEffort` resolves off the `'quick'` key even when the caller
   * passes a workflow key: this seam always creates a quick session, and v1
   * never writes effort under any other key (see RunTypeDefaults).
   *
   * Added by TASK-153 as a NEW, additive method — `start`'s 13-positional-
   * param signature is unchanged; do not expand it further.
   */
  startWithDefaults: (key: string) => Promise<void>;
  /**
   * Launch a quick session in `projectId` whose first turn is `kickoffPrompt`
   * (the Queue page's human-task "Verify complete" / "Help me with it"). Takes
   * the saved Quick Session defaults for model / permission mode / effort but
   * PINS the Claude SDK substrate — the kickoff only fires on a
   * frontend-created panel, which an interactive or non-Claude eager spawn never
   * gives it — and takes the workspace from `worktreeMode`.
   */
  startWithKickoff: (args: {
    projectId: number;
    kickoffPrompt: string;
    worktreeMode: QuickSessionWorktreeMode;
  }) => Promise<void>;
  isStarting: boolean;
  error: string | null;
}

export function useQuickSession(opts: UseQuickSessionOptions): UseQuickSessionReturn {
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (
      agentPermissionMode?: PermissionMode,
      substrate?: CliSubstrate,
      effort?: 'ultracode',
      model?: string,
      fastMode?: boolean,
      disabledMcpServers?: string[],
      enabledPlugins?: string[],
      worktreeMode?: QuickSessionWorktreeMode,
      agentProvider?: AgentProvider,
      agentRuntime?: SessionAgentRuntime,
      reasoningEffort?: ReasoningEffort,
      designIdeaId?: string,
      kickoffPrompt?: string,
      baseBranch?: string,
      projectIdOverride?: number,
    ): Promise<void> => {
      const projectId = projectIdOverride ?? opts.projectId;
      if (projectId === null || isStarting) return;

      setError(null);
      setIsStarting(true);

      try {
        // OMP follows Codex's path here: no claudeConfig blob, model persisted
        // via agentModel/setModel like Codex's, no eager server spawn to
        // receive claudeConfig on the interactive substrate (Codex/OMP have no
        // "interactive" substrate of their own — each names its transport in
        // the runtime id). Structural check (providerForRuntime) rather than a
        // per-runtime literal list, so a future non-Claude runtime is covered
        // automatically instead of needing its own arm here.
        const runtimeProvider = agentRuntime !== undefined ? providerForRuntime(agentRuntime) : undefined;
        const isNonClaudeRuntime =
          (agentProvider !== undefined && agentProvider !== 'claude') ||
          (runtimeProvider !== undefined && runtimeProvider !== 'claude');
        // model + fastMode + reasoningEffort ride the request as claudeConfig so the
        // INTERACTIVE eager spawn (server-side) receives them; the SDK panel is
        // created on the frontend below and persisted there. Sending both ways is
        // harmless — the SDK create-quick path ignores claudeConfig (no panel to
        // start yet).
        const claudeConfig =
          !isNonClaudeRuntime && (model !== undefined || fastMode === true || reasoningEffort !== undefined)
            ? {
                ...(model !== undefined ? { model } : {}),
                fastMode: fastMode === true,
                ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
              }
            : undefined;

        const result = await API.sessions.createQuick({
          prompt: '',
          projectId,
          ...(agentPermissionMode ? { agentPermissionMode } : {}),
          ...(substrate ? { substrate } : {}),
          ...(agentProvider ? { agentProvider } : {}),
          ...(agentRuntime ? { agentRuntime } : {}),
          ...(isNonClaudeRuntime && model !== undefined ? { agentModel: model } : {}),
          ...(effort ? { effort } : {}),
          ...(claudeConfig ? { claudeConfig } : {}),
          // Per-session MCP deny / plugin selection chosen in the wizard's Advanced
          // section, persisted before the first spawn. MCP is a DENY list → only
          // sent when non-empty (empty = inherit all servers). Plugins are
          // EXCLUSIVE and reflect the current enabled set → the wizard passes
          // `undefined` when unchanged (inherit) and an explicit array otherwise,
          // INCLUDING `[]` ("disable everything"); forward that distinction as-is.
          ...(disabledMcpServers && disabledMcpServers.length > 0 ? { disabledMcpServers } : {}),
          ...(enabledPlugins !== undefined ? { enabledPlugins } : {}),
          // Workspace choice (wizard Advanced) → sessions.in_place (migration 047).
          // Only sent when explicitly chosen; omitted → the server floors to the
          // global quickSessionWorktreeMode default.
          ...(worktreeMode ? { worktreeMode } : {}),
          // Design Mode (design-mode.md "Idea link"): the idea this design
          // session binds to. Only sent by the wizard's Design arm; every other
          // launch omits it.
          ...(designIdeaId !== undefined ? { designIdeaId } : {}),
          // Base branch for the session worktree (wizard Advanced) — omitted →
          // the project checkout's HEAD.
          ...(baseBranch !== undefined ? { baseBranch } : {}),
        });

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to create quick session');
        }

        const { sessionId, worktreePath, runId, claudePanelId } = result.data;

        // Agent panel first (unless the server eagerly created it — interactive
        // PTY sessions spawn during create-quick and return their panel id),
        // then Terminal.
        let createdClaudePanelId: string | undefined;
        if (claudePanelId === undefined) {
          const claudePanel = await panelApi.createPanel({
            sessionId,
            type: 'claude',
            title: 'Chat',
          });
          createdClaudePanelId = claudePanel.id;
          // Register the panel in the frontend store IMMEDIATELY (addPanel dedups
          // by id): nothing else pushes panels created here into panelStore — no
          // panel:created store listener exists — so a consumer mounting right
          // after onSuccess (the v0.5 DesignModeSurface) would otherwise see no
          // Claude panel and mint a DUPLICATE via its ensure fallback.
          usePanelStore.getState().addPanel(claudePanel);
          // Persist the launch model + fast-mode on the SDK panel so the first
          // (and every) sessions:input turn spawns with them — the request's
          // claudeConfig only reaches the interactive eager spawn, never this
          // frontend-created SDK panel.
          if (model !== undefined) await API.claudePanels.setModel(claudePanel.id, model);
          // fastMode is Claude-only (no Codex or OMP analogue).
          if (!isNonClaudeRuntime) {
            await API.claudePanels.setFastMode(claudePanel.id, fastMode === true);
          }
          // Reasoning effort persists for every effort-capable runtime that owns a
          // frontend-created panel: Claude SDK AND codex-sdk (startCodexSdkTurn reads
          // it per turn → buildCodexAppServerTurnOptions maps it onto the app-server
          // turn). A runtime whose RUNTIME_CAPABILITIES.supportsEffort is false is
          // excluded — codex-pty is server-eager-created (so it never reaches this
          // frontend branch) and emits no effort flag regardless.
          if (
            reasoningEffort !== undefined &&
            (agentRuntime === undefined || runtimeSupportsEffort(agentRuntime))
          ) {
            await API.claudePanels.setEffort(claudePanel.id, reasoningEffort);
          }
        }
        // NOTE: deliberately NOT store-added — addPanel stamps its panel as the
        // session's active one, and the active tab must stay Chat.
        await panelApi.createPanel({
          sessionId,
          type: 'terminal',
          title: 'Terminal',
          initialState: { cwd: worktreePath },
        });

        useCyboflowStore.getState().setActiveQuickSession(sessionId, runId);
        trackEvent('session_created', { kind: 'quick', substrate });

        // Design Mode auto-start kickoff — see `start`'s doc above. Fired
        // fire-and-forget so a kickoff-send failure never fails session
        // creation; the composer's own dispatch path handles UI reflection of
        // the sent turn once loaded.
        if (kickoffPrompt !== undefined && kickoffPrompt.length > 0 && createdClaudePanelId !== undefined) {
          const kickoffSession: Session = {
            id: sessionId,
            name: sessionId,
            worktreePath,
            prompt: '',
            status: 'ready',
            createdAt: new Date().toISOString(),
            output: [],
            jsonMessages: [],
            agentRuntime: agentRuntime ?? 'claude-sdk',
          };
          // Mode MUST be 'continue', not 'initial': 'initial' routes through
          // panels:send-input, which records the user message FIRST and then
          // reaches continuePanel on the resume path — which throws ("Cannot
          // resume: no Claude session_id stored") on a fresh session.
          // panels:continue has the explicit first-message branch (!isRunning &&
          // !hasClaudeSessionId → startPanel, a clean fresh spawn) — the same
          // path the composer's first typed message takes.
          dispatchQuickSessionInput(kickoffSession, createdClaudePanelId, kickoffPrompt, 'continue').catch(
            (err: unknown) => {
              console.error('[useQuickSession] Failed to send design kickoff turn:', err);
            },
          );
        }

        opts.onSuccess?.(sessionId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create quick session');
      } finally {
        setIsStarting(false);
      }
    },
    // opts.projectId and opts.onSuccess are the only external deps; isStarting is
    // read from closure and intentionally excluded to avoid re-creating the callback
    // every time isStarting flips — the guard (`isStarting`) still holds because
    // setIsStarting is synchronous within the render cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.projectId, opts.onSuccess],
  );

  const startWithDefaults = useCallback(
    (key: string): Promise<void> => {
      const config = useConfigStore.getState().config;
      const runTypeDefaults = config?.runTypeDefaults;
      // The GLOBAL launch model (`config.defaultLaunchModel`), normalized the
      // same way main's `configManager.getGlobalLaunchModel` normalizes it —
      // trimmed, and blank ⇒ unset — so the renderer and main cannot resolve a
      // hand-edited config.json differently.
      const globalLaunchModel = config?.defaultLaunchModel?.trim() || undefined;
      // The GLOBAL agent runtime, taken ONLY when it is launchable as a quick
      // session. `codex-exec` (never offered by any picker, reachable via a
      // hand-edited config) is dropped here rather than sent as an unlaunchable
      // runtime; every other member of the union is a valid quick session,
      // including `codex-pty`.
      const globalAgentRuntime = config?.defaultAgentRuntime;
      // This seam always creates a QUICK session, so the quick-kind floors
      // apply even when the caller hands over a workflow key — pin them here
      // rather than let the key pick the (workflow) floor table. The global
      // model sits BETWEEN the stored per-type value and that floor.
      //
      // `agentRuntime` is the rung a GENUINE user-set global runtime rides, and
      // nothing else: a resolved runtime OWNS its implied substrate, so a
      // runtime synthesized from `quickSessionDefaultSubstrate` here would
      // outrank a stored substrate carrying no runtime of its own. The
      // substrate preference therefore stays on the SUBSTRATE rung below, where
      // a stored substrate still beats it.
      const globals: RunTypeLaunchGlobals = {
        model: globalLaunchModel ?? DEFAULT_RUN_TYPE_MODEL_FLOORS.quick,
        permissionMode: config?.defaultAgentPermissionMode,
        substrate: config?.quickSessionDefaultSubstrate ?? DEFAULT_QUICK_SUBSTRATE,
        ...(isSessionAgentRuntime(globalAgentRuntime) ? { agentRuntime: globalAgentRuntime } : {}),
      };
      const resolved = resolveRunTypeLaunchDefaults(key, runTypeDefaults, globals);
      // Effort always resolves off the quick key — see the doc above.
      const { reasoningEffort } = resolveRunTypeLaunchDefaults(
        QUICK_RUN_TYPE_KEY,
        runTypeDefaults,
        globals,
      );
      // `start` takes the session-scoped runtime union; a 'codex-exec' (never
      // written by the settings UI, but reachable via a hand-edited config) is
      // dropped rather than sent as an unlaunchable runtime. The global rung is
      // already filtered above, so this now only guards a STORED value.
      const agentRuntime = isSessionAgentRuntime(resolved.agentRuntime)
        ? resolved.agentRuntime
        : undefined;
      // Keep the model in the resolved runtime's family. `resolved.model` can be
      // a Claude value with a Codex runtime whenever the model rung falls
      // through to a global or floor that knows nothing about the runtime — the
      // quick floor is always Claude — which would launch Codex with e.g.
      // 'opus'. Only the Codex direction needs this: every Claude-family floor
      // is already valid under a Claude runtime.
      const model =
        agentRuntime !== undefined &&
        providerForRuntime(agentRuntime) === 'codex' &&
        !isCodexModelSelection(resolved.model)
          ? DEFAULT_CODEX_MODEL
          : resolved.model;

      return start(
        resolved.permissionMode,
        resolved.substrate,
        undefined,
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        agentRuntime,
        reasoningEffort,
      );
    },
    [start],
  );

  const startWithKickoff = useCallback(
    ({
      projectId,
      kickoffPrompt,
      worktreeMode,
    }: {
      projectId: number;
      kickoffPrompt: string;
      worktreeMode: QuickSessionWorktreeMode;
    }): Promise<void> => {
      const config = useConfigStore.getState().config;
      const globalLaunchModel = config?.defaultLaunchModel?.trim() || undefined;
      const globals: RunTypeLaunchGlobals = {
        model: globalLaunchModel ?? DEFAULT_RUN_TYPE_MODEL_FLOORS.quick,
        permissionMode: config?.defaultAgentPermissionMode,
        substrate: 'sdk',
      };
      const resolved = resolveRunTypeLaunchDefaults(QUICK_RUN_TYPE_KEY, config?.runTypeDefaults, globals);
      // Pinned to Claude SDK (see the interface doc), so a model saved for a
      // Codex default would launch Claude with a Codex id — fall back to the floor.
      const model = isCodexModelSelection(resolved.model) ? DEFAULT_RUN_TYPE_MODEL_FLOORS.quick : resolved.model;
      return start(
        resolved.permissionMode,
        'sdk',
        undefined,
        model,
        undefined,
        undefined,
        undefined,
        worktreeMode,
        'claude',
        'claude-sdk',
        resolved.reasoningEffort,
        undefined,
        kickoffPrompt,
        undefined,
        projectId,
      );
    },
    [start],
  );

  return { start, startWithDefaults, startWithKickoff, isStarting, error };
}
