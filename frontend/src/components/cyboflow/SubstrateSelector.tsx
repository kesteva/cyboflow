/**
 * SubstrateSelector — per-launch agent runtime choice, rendered as TWO
 * segmented controls: **Runtime** (the provider — Claude / Codex / OMP / Pi)
 * and **Mode** (the transport — Chat, i.e. the structured SDK lane, or CLI,
 * the terminal-driven lane). The pair maps 1:1 onto the flat runtime ids the
 * rest of the app speaks (`claude-sdk` … `pi-pty`), so the component's
 * external contract is unchanged: `value`/`onChange` still carry a single
 * {@link LaunchAgentRuntime}. Controlled, but self-locks to the global
 * PTY-only setting (see below).
 *
 * OMP is the one provider whose lanes are install-dependent: the two OMP
 * flavors are ALTERNATIVES, not a stack. A local install offers
 * `omp-sdk`/`omp-pty` (Chat/CLI as usual); an Aria install supervises a
 * REMOTE fleet, so its OMP column holds the single `omp-fleet` lane instead
 * (no Mode row — there is no choice to make) and is offered DISABLED, naming
 * the reason, while the bridge is not configured — hiding it would leave an
 * Aria install with no OMP anywhere while Settings still reads "on".
 *
 * Substrate is honored on BOTH launch paths:
 *   - Workflow runs: threaded into runs.start as the `substrate` param, stamped
 *     onto workflow_runs.substrate and honored by RunExecutor /
 *     SubstrateDispatchFacade.
 *   - Quick sessions: threaded via useQuickSession.start →
 *     CreateSessionRequest.substrate → sessions.substrate (migration 027);
 *     'interactive' spawns a PTY-backed quick session (persistent claude REPL).
 *
 * Global CLI-only lock: when Settings → AI Integration → CLI runtime is set to
 * "Interactive CLI only" (config.interactivePtyOnly), the SDK is disabled and
 * every run is forced onto the interactive substrate. The authoritative pin is
 * the backend ConfigManager.getForcedSubstrate (consumed in
 * WorkflowRegistry.createRun, above the whole resolver ladder); this component
 * reads the same flag from the config store so the picker stays honest — it
 * renders a read-only locked state and syncs the controlled value to
 * 'interactive' so the launch payload matches what will be stamped. Reading the
 * flag HERE (the single shared picker) locks every consumer at once.
 *
 * Shared by WorkflowPicker (legacy modal), ABTestLaunchModal, and
 * SessionStartWizard step 3 so the caveats text + lock behavior are
 * single-sourced (no drift). `runtimeScope` narrows by LAUNCH KIND, not by
 * vendor: the scope test reads `workflowRuntimeForLaunch`, so a runtime joining
 * the launchable set is offered here with no edit — today that means CLI mode
 * is disabled for Codex/OMP/Pi on a workflow launch while Claude's CLI lane
 * (claude-interactive) stays launchable.
 */
import { useEffect } from 'react';
import { cn } from '../../utils/cn';
import {
  AGENT_PROVIDERS,
  AGENT_RUNTIME_LABELS,
  firstEnabledRuntime,
  isRuntimeProviderEnabled,
  providerForRuntime,
  type AgentProvider,
  type AgentProviderAccess,
} from '../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../shared/types/agentCapabilities';
import { useAgentProviderAccess, useSurfacedProviderBaseline } from '../../hooks/useAgentProviderAccess';
import { useForcedSubstrate } from '../../hooks/useForcedSubstrate';
import { useOmpAvailability, type OmpAvailability } from '../../hooks/useOmpAvailability';
import {
  workflowRuntimeForLaunch,
  type LaunchAgentRuntime,
} from './agentRuntimeUi';

/**
 * The v1 limits of the interactive PTY substrate, surfaced when 'interactive' is
 * picked. These are the UNCONDITIONAL caveats — the interactive PreToolUse
 * approval gating DID ship (TASK-810), so the "approval routing unavailable"
 * caveat is intentionally NOT listed.
 */
export const INTERACTIVE_CAVEATS: readonly string[] = [
  'AskUserQuestion is native-TUI-only — multiple-choice questions surface in the terminal, not the structured panel.',
  'Subagent gating is limited — only the main session reports step transitions; subagent tool calls are gated but not separately surfaced.',
  'Streaming is coarser — output arrives at turn-level granularity, not token-level deltas.',
];

/**
 * The v1 limits of the OMP structured (omp-sdk) lane, mirroring
 * INTERACTIVE_CAVEATS' style.
 *
 * The subagent caveat that used to sit here ("Subagents are unavailable —
 * OMP's task tool is refused") was retired when `buildOmpGateConfig` flipped
 * `denyTaskTool` to false: the 2026-08-23 live probe showed a `task`
 * subagent's tool calls ARE gated (see the builder's doc comment in
 * `main/src/services/panels/omp/ompGateConfigBuilder.ts`), so `task` is now
 * allowed on every well-formed config and only the fail-closed
 * malformed-config default still denies it.
 */
export const OMP_SDK_CAVEATS: readonly string[] = [
  'Slow approvals (over 25s) are blocked and can be retried.',
];

/** The v1 limits of the OMP CLI (omp-pty) lane. */
export const OMP_PTY_CAVEATS: readonly string[] = [
  'Approvals stay in the OMP CLI — no Cyboflow review-queue integration.',
];

/**
 * The v1 limits of the Pi structured (pi-sdk) lane. A tool_call gate enforces
 * the session's permission mode inside the spawned process (read-only tools
 * pass under default/acceptEdits/auto; everything passes only in dontAsk),
 * but there is no interactive approval prompt yet — gated writes are BLOCKED,
 * not queued for review.
 */
export const PI_SDK_CAVEATS: readonly string[] = [
  'Write-tier tools are blocked unless the session permission mode is dontAsk — no interactive approval prompt yet.',
  'No mid-turn steering: the next message queues until the current turn finishes.',
  'Tool activity is not shown in the transcript; only final text per turn.',
];

/** The v1 limits of the Pi CLI (pi-pty) lane. */
export const PI_PTY_CAVEATS: readonly string[] = [
  'Approvals stay inside the pi TUI — no Cyboflow review-queue integration.',
];

/** The v1 limits of the Antigravity structured (agy-sdk) lane. */
export const AGY_SDK_CAVEATS: readonly string[] = [
  'Auto-approves tool requests when session permission mode is dontAsk (--dangerously-skip-permissions).',
  'No mid-turn steering: the next message queues until the current turn finishes.',
  'Tool activity is not shown in the transcript; only final text per turn.',
];

/** The v1 limits of the Antigravity CLI (agy-pty) lane. */
export const AGY_PTY_CAVEATS: readonly string[] = [
  'Approvals stay inside the Antigravity TUI — no Cyboflow review-queue integration.',
];

interface SubstrateSelectorProps {
  value: LaunchAgentRuntime;
  onChange: (runtime: LaunchAgentRuntime) => void;
  /** id/testid base for the two radiogroups (`<id>-provider-*` / `<id>-mode-*`). */
  id?: string;
  /** Heading text above the provider segments. */
  label?: string;
  /** data-testid for the caveats panel (per-surface to keep existing selectors stable). */
  caveatsTestId?: string;
  /** Which launch surface owns the runtime choice. Codex/OMP/Pi CLI are session-only. */
  runtimeScope?: 'workflow' | 'session' | 'mixed';
}

type RuntimeMode = 'chat' | 'cli';

/** One provider column's lanes. `cli` is absent for the Aria-mode OMP column,
 *  whose single `omp-fleet` lane leaves no transport choice to render. */
interface ProviderLanes {
  chat: LaunchAgentRuntime;
  cli?: LaunchAgentRuntime;
}

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  omp: 'OMP',
  pi: 'Pi',
  agy: 'Antigravity',
};

const MODE_LABELS: Record<RuntimeMode, string> = {
  chat: 'Chat',
  cli: 'CLI',
};

/**
 * THE provider × mode grid for one install — every cell is a runtime id the
 * launch seams accept. Chat is the structured lane (SDK managers, structured
 * events/usage/MCP); CLI is the terminal-driven lane. `claude-interactive`
 * sits in the CLI column because it is user-facing "Claude (CLI)" even though
 * it is workflow-launchable, unlike the other CLI cells. The OMP column is the
 * flavor-dependent one (see the file header): Aria mode swaps its two local
 * lanes for the single `omp-fleet` lane.
 */
function lanesForProvider(provider: AgentProvider, omp: OmpAvailability): ProviderLanes {
  switch (provider) {
    case 'claude':
      return { chat: 'claude-sdk', cli: 'claude-interactive' };
    case 'codex':
      return { chat: 'codex-sdk', cli: 'codex-pty' };
    case 'omp':
      return omp.ariaMode ? { chat: 'omp-fleet' } : { chat: 'omp-sdk', cli: 'omp-pty' };
    case 'pi':
      return { chat: 'pi-sdk', cli: 'pi-pty' };
    case 'agy':
      return { chat: 'agy-sdk', cli: 'agy-pty' };
  }
}

/** The mode a flat runtime id sits in — the inverse of {@link lanesForProvider}. */
function modeForRuntime(runtime: LaunchAgentRuntime, omp: OmpAvailability): RuntimeMode {
  return lanesForProvider(providerForRuntime(runtime), omp).cli === runtime ? 'cli' : 'chat';
}

/**
 * Scope-level unavailability — the lane exists but not on THIS launch surface
 * (e.g. Codex CLI, or the fleet supervisor, on a workflow launch). Provider
 * access is a separate axis: a switched-off provider's column is hidden
 * outright (see visibleProviders), because it isn't available anywhere until
 * the toggle goes back on.
 */
function isRuntimeDisabled(runtime: LaunchAgentRuntime, scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): boolean {
  if (scope === 'workflow') return workflowRuntimeForLaunch(runtime) === null;
  return false;
}

/**
 * Why a VISIBLE lane cannot be chosen right now, or null when it can.
 *
 * Distinct from {@link isRuntimeDisabled}, which is about SCOPE ("this launch
 * surface can't run it"). This is about the machine's current configuration —
 * the runtime is right for the surface, but something outside the picker has to
 * be set up first. Rendering the reason beats removing the column: a user who
 * turned Aria mode on needs to learn the bridge is missing, not watch OMP
 * disappear from a picker whose provider toggle still says it is enabled.
 */
function unavailableReason(runtime: LaunchAgentRuntime, omp: OmpAvailability): string | null {
  if (runtime === 'omp-fleet' && !omp.launchable) return 'bridge not configured';
  return null;
}

/** Whether a lane may actually be chosen (capability + scope + availability). */
function isCellOfferable(
  runtime: LaunchAgentRuntime,
  scope: NonNullable<SubstrateSelectorProps['runtimeScope']>,
  omp: OmpAvailability,
): boolean {
  return (
    isRuntimeSelectableInPickers(runtime) &&
    !isRuntimeDisabled(runtime, scope) &&
    unavailableReason(runtime, omp) === null
  );
}

/** The provider columns a picker may show, given the provider toggles. A
 *  column stays visible even when its lanes are currently unpickable (the
 *  Aria-mode bridge gap) — that state renders as a disabled segment with the
 *  reason, never as a silent hole. */
function visibleProviders(access: AgentProviderAccess, omp: OmpAvailability): readonly AgentProvider[] {
  return AGENT_PROVIDERS.filter((p) => {
    const lanes = lanesForProvider(p, omp);
    const anySelectable =
      isRuntimeSelectableInPickers(lanes.chat) ||
      (lanes.cli !== undefined && isRuntimeSelectableInPickers(lanes.cli));
    return anySelectable && isRuntimeProviderEnabled(access, lanes.chat);
  });
}

function scopeHelp(scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): string {
  if (scope === 'workflow') {
    return 'Workflows run on any structured runtime — Claude, Codex SDK, or OMP. The CLI runtimes remain quick-session-only.';
  }
  if (scope === 'session') {
    return 'The structured runtimes run quick-session chat; the CLI runtimes open an interactive terminal-style session instead.';
  }
  return 'A structured runtime can run workflows or quick sessions. The CLI runtimes start quick sessions only.';
}

/** Shared caveats-block rendering — the interactive PTY and the OMP/Pi rows use
 *  the same "v1 limits" panel, differing only in title + item list. */
function CaveatsPanel({
  testId,
  title,
  items,
}: {
  testId: string;
  title: string;
  items: readonly string[];
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role="note"
      className="mt-1 rounded-input border border-status-warning bg-bg-secondary px-3 py-2 text-xs text-text-secondary"
    >
      <p className="mb-1 font-semibold text-text-primary">{title}</p>
      <ul className="list-disc space-y-1 pl-4">
        {items.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

/** Segment styling matched to the AgentPermissionModeSelector rows so the
 *  Configure step's button controls read as one family. */
function segmentClass(selected: boolean, segmentDisabled: boolean): string {
  return cn(
    'flex flex-1 items-center justify-center rounded-button border px-3 py-2 text-sm font-medium transition-colors',
    segmentDisabled
      ? 'cursor-not-allowed border-border-secondary bg-surface-secondary text-text-tertiary opacity-50'
      : selected
        ? 'border-interactive bg-interactive-surface text-text-primary'
        : 'border-border-secondary bg-surface-secondary text-text-primary hover:bg-surface-hover',
  );
}

export function SubstrateSelector({
  value,
  onChange,
  id = 'substrate-select',
  label = 'Runtime',
  caveatsTestId = 'substrate-caveats',
  runtimeScope = 'workflow',
}: SubstrateSelectorProps): React.JSX.Element {
  // Global forced-substrate pin (see file header), mirroring the backend
  // precedence: demo → 'sdk', else interactivePtyOnly → 'interactive', else null.
  // Reactive read so a config fetch resolving AFTER mount still locks the picker.
  const forced = useForcedSubstrate();
  // Provider toggles (Settings → Integrations / onboarding). A switched-off
  // provider's column leaves the picker entirely and can never be submitted.
  const providerAccess = useAgentProviderAccess();
  const surfacedBaseline = useSurfacedProviderBaseline();
  const omp = useOmpAvailability();
  const providers = visibleProviders(providerAccess, omp);
  const claudeEnabled = isRuntimeProviderEnabled(providerAccess, 'claude-sdk');

  const selectedProvider = providerForRuntime(value);
  const selectedMode = modeForRuntime(value, omp);
  const selectedLanes = lanesForProvider(selectedProvider, omp);

  // Under the interactive lock, keep the controlled value consistent so the
  // launch payload matches the backend pin. Scoped to 'interactive' only: demo's
  // 'sdk' pin is left alone so demo's picker behaves as before (cosmetic — the
  // backend forces 'sdk' regardless). After value reaches 'interactive' the
  // guard stops re-firing (safe with an unstable onChange identity).
  // Skipped when Claude is switched off — the lock names a Claude runtime, so
  // forcing the value there would hand the launch seam a provider it rejects;
  // the conflict is surfaced in the locked branch below instead.
  useEffect(() => {
    if (forced === 'interactive' && claudeEnabled && value !== 'claude-interactive') {
      onChange('claude-interactive');
    }
  }, [forced, claudeEnabled, value, onChange]);

  // Snap a selection whose provider was switched off (e.g. the user disabled
  // Codex in Settings while a Codex runtime sat in this picker) back to the
  // first still-available runtime, so the rendered value and the launch payload
  // always name a provider the backend will accept. An unavailable lane (the
  // unconfigured fleet bridge) is never a fallback target.
  const fallbackRuntime = firstEnabledRuntime(
    providerAccess,
    AGENT_PROVIDERS.flatMap((p) => {
      const lanes = lanesForProvider(p, omp);
      return lanes.cli !== undefined ? [lanes.chat, lanes.cli] : [lanes.chat];
    }).filter((r) => isCellOfferable(r, runtimeScope, omp)),
  );
  useEffect(() => {
    if (isRuntimeProviderEnabled(providerAccess, value)) return;
    if (fallbackRuntime !== null && fallbackRuntime !== value) onChange(fallbackRuntime);
  }, [providerAccess, value, fallbackRuntime, onChange]);

  // Only the user-facing interactive lock gets the read-only locked UI. Demo
  // mode also pins ('sdk'), but it is a throwaway showcase profile — leave the
  // normal picker so demo never falsely renders "Interactive (CLI) — locked".
  if (forced === 'interactive' && !claudeEnabled) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        <div
          data-testid="substrate-provider-conflict"
          role="alert"
          className="w-full rounded-input border border-status-error bg-bg-secondary px-2 py-1 text-sm text-text-secondary"
        >
          No runtime available
        </div>
        <p className="text-xs text-text-tertiary">
          This app is locked to interactive-CLI-only mode, which runs on Claude — but Claude is
          turned off in Settings → Integrations. Enable Claude, or lift the CLI-only lock, to launch.
        </p>
      </div>
    );
  }

  if (forced === 'interactive') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        <div
          data-testid="substrate-locked"
          aria-label="Agent runtime locked to Claude Interactive (CLI)"
          className="w-full rounded-input border border-border-primary bg-bg-secondary px-2 py-1 text-sm text-text-secondary"
        >
          {AGENT_RUNTIME_LABELS['claude-interactive']} — locked
        </div>
        <p className="text-xs text-text-tertiary">
          Claude SDK is disabled globally (Settings → AI Integration → CLI runtime). Every run uses
          the interactive CLI runtime.
        </p>
        <CaveatsPanel testId={caveatsTestId} title="Interactive substrate — v1 limits" items={INTERACTIVE_CAVEATS} />
      </div>
    );
  }

  // Compared against what this install COULD surface, not a flat all-on map:
  // an Aria-gated provider is not "turned off in Settings → Integrations" (it
  // has no row there), so counting it would make the notice permanent and send
  // the user looking for a toggle that is not rendered.
  const hiddenProviders = providers.length !== visibleProviders(surfacedBaseline, omp).length;
  // The Aria-mode bridge gap for the SELECTED provider — rendered as a note so
  // the user learns what to configure instead of meeting an inert segment.
  const selectedChatReason = unavailableReason(selectedLanes.chat, omp);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Runtime" id={`${id}-provider`}>
          {providers.map((provider) => {
            const lanes = lanesForProvider(provider, omp);
            // A provider none of whose lanes is currently pickable (scope +
            // availability) renders DISABLED with the reason in its tooltip —
            // visible-but-unpickable, exactly like the old fleet option row.
            const anyOfferable =
              isCellOfferable(lanes.chat, runtimeScope, omp) ||
              (lanes.cli !== undefined && isCellOfferable(lanes.cli, runtimeScope, omp));
            const reason = unavailableReason(lanes.chat, omp);
            const selected = provider === selectedProvider;
            return (
              <button
                key={provider}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!anyOfferable}
                data-testid={`${id}-provider-${provider}`}
                title={!anyOfferable && reason !== null ? reason : undefined}
                onClick={() => {
                  // Keep the current mode where the target lane offers it;
                  // otherwise fall to the other lane (e.g. CLI → Chat when
                  // switching Claude→Codex on a workflow launch).
                  const preferred =
                    selectedMode === 'cli' && lanes.cli !== undefined ? lanes.cli : lanes.chat;
                  const alternate = preferred === lanes.chat ? lanes.cli : lanes.chat;
                  const next = isCellOfferable(preferred, runtimeScope, omp)
                    ? preferred
                    : alternate !== undefined && isCellOfferable(alternate, runtimeScope, omp)
                      ? alternate
                      : null;
                  if (next !== null && isRuntimeProviderEnabled(providerAccess, next)) {
                    onChange(next);
                  }
                }}
                className={segmentClass(selected, !anyOfferable)}
              >
                {PROVIDER_LABELS[provider]}
              </button>
            );
          })}
        </div>
      </div>

      {/* The Mode row exists only when the selected provider genuinely offers a
          choice here: on a workflow launch Codex/OMP/Pi have no launchable CLI
          lane — and the Aria-mode OMP column has no CLI lane at all — so a
          permanently-greyed CLI segment would just beg the question; hide the
          whole row instead (the scope help below still names the rule). */}
      {selectedLanes.cli !== undefined && isCellOfferable(selectedLanes.cli, runtimeScope, omp) && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">Mode</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Mode" id={`${id}-mode`}>
            {(['chat', 'cli'] as const).map((mode) => {
              const runtime = mode === 'cli' ? selectedLanes.cli : selectedLanes.chat;
              if (runtime === undefined) return null;
              const selected = mode === selectedMode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`${id}-mode-${mode}`}
                  onClick={() => {
                    if (
                      isCellOfferable(runtime, runtimeScope, omp) &&
                      isRuntimeProviderEnabled(providerAccess, runtime)
                    ) {
                      onChange(runtime);
                    }
                  }}
                  className={segmentClass(selected, false)}
                >
                  {MODE_LABELS[mode]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedChatReason !== null && (
        <p className="text-xs text-status-warning" data-testid={`${id}-unavailable-note`}>
          {AGENT_RUNTIME_LABELS[selectedLanes.chat]} is not launchable yet — {selectedChatReason}.
        </p>
      )}

      <p className="text-xs text-text-tertiary">
        {hiddenProviders
          ? `${scopeHelp(runtimeScope)} Runtimes for providers turned off in Settings → Integrations are hidden.`
          : scopeHelp(runtimeScope)}
      </p>

      {value === 'claude-interactive' && (
        <CaveatsPanel testId={caveatsTestId} title="Interactive substrate — v1 limits" items={INTERACTIVE_CAVEATS} />
      )}
      {value === 'omp-sdk' && (
        <CaveatsPanel testId={caveatsTestId} title="OMP — v1 limits" items={OMP_SDK_CAVEATS} />
      )}
      {value === 'omp-pty' && (
        <CaveatsPanel testId={caveatsTestId} title="OMP (CLI) — v1 limits" items={OMP_PTY_CAVEATS} />
      )}
      {value === 'pi-sdk' && (
        <CaveatsPanel testId={caveatsTestId} title="Pi — v1 limits" items={PI_SDK_CAVEATS} />
      )}
      {value === 'pi-pty' && (
        <CaveatsPanel testId={caveatsTestId} title="Pi (CLI) — v1 limits" items={PI_PTY_CAVEATS} />
      )}
      {value === 'agy-sdk' && (
        <CaveatsPanel testId={caveatsTestId} title="Antigravity — v1 limits" items={AGY_SDK_CAVEATS} />
      )}
      {value === 'agy-pty' && (
        <CaveatsPanel testId={caveatsTestId} title="Antigravity (CLI) — v1 limits" items={AGY_PTY_CAVEATS} />
      )}
    </div>
  );
}
