/**
 * SubstrateSelector — per-launch agent runtime choice. Claude runtimes still
 * project onto the legacy CLI substrate choice (SDK | Interactive PTY); Codex
 * runtimes are provider/runtime choices and do not carry a substrate value.
 * Controlled (value/onChange), but self-locks to the global PTY-only setting
 * (see below).
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
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * caveats text + lock behavior are single-sourced (no drift). `runtimeScope`
 * narrows by LAUNCH KIND, not by vendor: every structured runtime is launchable
 * for workflows and quick sessions alike, while the terminal runtimes
 * (`codex-pty`, `omp-pty`) stay session-only — the scope test reads
 * `workflowRuntimeForLaunch`, so a runtime joining the launchable set is offered
 * here with no edit.
 */
import { useEffect } from 'react';
import {
  AGENT_RUNTIME_LABELS,
  firstEnabledRuntime,
  isRuntimeProviderEnabled,
  isSessionAgentRuntime,
  isWorkflowLaunchableRuntime,
  type AgentProviderAccess,
} from '../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../shared/types/agentCapabilities';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';
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
 * The last two were added after the 2026-08-16 release smoke returned RED on
 * this lane with exactly these two app-owned findings. Both are deliberate v1
 * gaps rather than defects — the `task` deny is the unconditional rule 2 in
 * `gate/ompGateExtension.ts` (OMP subagents run forced-yolo and whether the
 * gating hook is even installed inside one is unverified), and the dialog
 * cancel is `OmpApprovalBridge`'s no-question-bridge path. What the old wording
 * got wrong was the SEVERITY: "No question gate yet — approvals land in the
 * review queue" describes the approval prompt, which the bridge answers fine,
 * and says nothing about the agent's own `ask` tool, which is cancelled and
 * ENDS THE TURN ("Tool call denied by user" upstream). A user should know both
 * before choosing this lane, not after a run stops mid-task.
 */
export const OMP_SDK_CAVEATS: readonly string[] = [
  'Slow approvals (over 25s) are blocked and can be retried.',
  'Subagents are unavailable — OMP’s task tool is refused, so the agent cannot delegate.',
];

/** The v1 limits of the OMP CLI (omp-pty) lane. */
export const OMP_PTY_CAVEATS: readonly string[] = [
  'Approvals stay in the OMP CLI — no Cyboflow review-queue integration.',
];

/**
 * The v1 limits of the Pi structured (pi-sdk) lane. Headless and ungated:
 * pi has no sandbox or approval-mode surface, so workflow steps run tools
 * without a gate until the extension tool_call bridge ships.
 */
export const PI_SDK_CAVEATS: readonly string[] = [
  'Tools run WITHOUT an approval gate in workflow steps (no sandbox yet) — run on worktrees you are watching.',
  'No mid-turn steering: the next message queues until the current turn finishes.',
  'Tool activity is not shown in the transcript; only final text per turn.',
];

/** The v1 limits of the Pi CLI (pi-pty) lane. */
export const PI_PTY_CAVEATS: readonly string[] = [
  'Approvals stay inside the pi TUI — no Cyboflow review-queue integration.',
];

interface SubstrateSelectorProps {
  value: LaunchAgentRuntime;
  onChange: (runtime: LaunchAgentRuntime) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
  /** data-testid for the caveats panel (per-surface to keep existing selectors stable). */
  caveatsTestId?: string;
  /** Which launch surface owns the runtime choice. Codex PTY is session-only. */
  runtimeScope?: 'workflow' | 'session' | 'mixed';
}

/**
 * Every runtime this picker knows a row for, in display order.
 *
 * The NAME half comes from the shared {@link AGENT_RUNTIME_LABELS} so it cannot
 * drift from the Settings runtime list or the wizard's launch summary; only the
 * scope suffix — which is this picker's own concern — is added here.
 */
const RUNTIME_SCOPE_SUFFIXES: Partial<Record<LaunchAgentRuntime, string>> = {
  'claude-sdk': ' (default)',
  'codex-pty': ' — quick sessions only',
  'omp-fleet': ' — quick sessions only',
  'pi-pty': ' — quick sessions only',
};

const RUNTIME_OPTIONS: readonly { runtime: LaunchAgentRuntime; label: string }[] = (
  [
    'claude-sdk',
    'claude-interactive',
    'codex-sdk',
    'codex-pty',
    'omp-sdk',
    'omp-pty',
    'omp-fleet',
    'pi-sdk',
    'pi-pty',
  ] as const
).map((runtime) => ({
  runtime,
  label: `${AGENT_RUNTIME_LABELS[runtime]}${RUNTIME_SCOPE_SUFFIXES[runtime] ?? ''}`,
}));

/**
 * The rows the picker may render at all, before the provider toggles narrow them
 * further. Gated on `RUNTIME_CAPABILITIES.selectableInPickers` rather than on
 * membership of the list above, so a runtime declared ahead of its managers can
 * carry its row and label here from the start and stay invisible until that one
 * flag flips — the alternative is a second list to remember, and a row added to
 * only one of them.
 *
 * Everything downstream (the option list, the disabled-provider fallback, the
 * "some are hidden" note) counts against THIS, never against RUNTIME_OPTIONS.
 */
const SELECTABLE_RUNTIME_OPTIONS = RUNTIME_OPTIONS.filter((o) =>
  isRuntimeSelectableInPickers(o.runtime),
);

/**
 * Scope-level unavailability — rendered as a DISABLED option so the user can
 * see the runtime exists but not here (e.g. Codex PTY on a workflow launch).
 * Provider access is a separate axis: a switched-off provider's runtimes are
 * hidden outright (see enabledRuntimeOptions), because they aren't available
 * anywhere until the toggle goes back on.
 */
function isRuntimeDisabled(runtime: LaunchAgentRuntime, scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): boolean {
  if (scope === 'workflow') return workflowRuntimeForLaunch(runtime) === null;
  if (scope === 'session') return false;
  return false;
}

/** The LOCAL OMP runtimes — an OMP process this machine runs. */
const LOCAL_OMP_RUNTIMES: ReadonlySet<LaunchAgentRuntime> = new Set<LaunchAgentRuntime>(['omp-sdk', 'omp-pty']);

/**
 * The options a picker may show, given the provider toggles + OMP availability.
 *
 * The two OMP flavors are ALTERNATIVES, not a stack: a panel is either a local
 * OMP process or a supervised remote worker. Aria mode picks which one this
 * install runs, so exactly one of them is ever offered — showing both would
 * imply a choice the runtime does not actually support, and `omp-fleet` needs a
 * configured bridge the local runtimes do not.
 */
function flavorVisibleOptions(
  omp: OmpAvailability,
): readonly { runtime: LaunchAgentRuntime; label: string }[] {
  return SELECTABLE_RUNTIME_OPTIONS.filter((o) => {
    // Visible on ARIA MODE ALONE, not on availability. Hiding it when the
    // bridge is missing removed the last OMP row from an Aria install — the
    // local runtimes are hidden precisely BECAUSE Aria is on — so the picker
    // showed no OMP at all while Settings → Integrations still read "on", with
    // no note explaining it (the hidden-runtimes note counts against THIS
    // list, so a row removed here is invisible by construction). It is offered
    // and DISABLED instead: see unavailableReason.
    if (o.runtime === 'omp-fleet') return omp.ariaMode;
    if (LOCAL_OMP_RUNTIMES.has(o.runtime)) return !omp.ariaMode;
    return true;
  });
}

/**
 * Why a VISIBLE runtime cannot be chosen right now, or null when it can.
 *
 * Distinct from {@link isRuntimeDisabled}, which is about SCOPE ("this launch
 * surface can't run it"). This is about the machine's current configuration —
 * the runtime is right for the surface, but something outside the picker has to
 * be set up first. Rendering the reason beats removing the row: a user who
 * turned Aria mode on needs to learn the bridge is missing, not watch OMP
 * disappear from a picker whose provider toggle still says it is enabled.
 */
function unavailableReason(runtime: LaunchAgentRuntime, omp: OmpAvailability): string | null {
  if (runtime === 'omp-fleet' && !omp.launchable) return 'bridge not configured';
  return null;
}

function enabledRuntimeOptions(
  access: AgentProviderAccess,
  omp: OmpAvailability,
): readonly { runtime: LaunchAgentRuntime; label: string }[] {
  return flavorVisibleOptions(omp).filter((o) => isRuntimeProviderEnabled(access, o.runtime));
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

/** Shared caveats-block rendering — the interactive PTY and both OMP rows use
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

export function SubstrateSelector({
  value,
  onChange,
  id = 'substrate-select',
  label = 'Agent runtime',
  caveatsTestId = 'substrate-caveats',
  runtimeScope = 'workflow',
}: SubstrateSelectorProps): React.JSX.Element {
  // Global forced-substrate pin (see file header), mirroring the backend
  // precedence: demo → 'sdk', else interactivePtyOnly → 'interactive', else null.
  const forced = useForcedSubstrate();
  // Provider toggles (Settings → Integrations / onboarding). A switched-off
  // provider's runtimes leave the picker entirely and can never be submitted.
  const providerAccess = useAgentProviderAccess();
  const omp = useOmpAvailability();
  const options = enabledRuntimeOptions(providerAccess, omp);
  // Baseline for the "…are hidden" note: the rows this OMP FLAVOR can show, not
  // every selectable runtime. Aria mode always hides one flavor, so counting
  // against the full list would fire the note permanently and blame the provider
  // toggles for a row the flavor removed.
  const flavorOptionCount = flavorVisibleOptions(omp).length;
  const claudeEnabled = isRuntimeProviderEnabled(providerAccess, 'claude-sdk');

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
  // always name a provider the backend will accept.
  const fallbackRuntime = firstEnabledRuntime(
    providerAccess,
    SELECTABLE_RUNTIME_OPTIONS.filter(
      (o) => !isRuntimeDisabled(o.runtime, runtimeScope) && unavailableReason(o.runtime, omp) === null,
    ).map((o) => o.runtime),
  );
  useEffect(() => {
    if (isRuntimeProviderEnabled(providerAccess, value)) return;
    if (fallbackRuntime !== null && fallbackRuntime !== value) onChange(fallbackRuntime);
  }, [providerAccess, value, fallbackRuntime, onChange]);

  // Only the user-facing interactive lock gets the read-only locked UI. Demo
  // mode also pins ('sdk'), but it is a throwaway showcase profile — leave the
  // normal select so demo never falsely renders "Interactive (PTY) — locked".
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

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (
            (isSessionAgentRuntime(next) || isWorkflowLaunchableRuntime(next)) &&
            !isRuntimeDisabled(next, runtimeScope) &&
            unavailableReason(next, omp) === null &&
            isRuntimeProviderEnabled(providerAccess, next)
          ) {
            onChange(next);
          }
        }}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label="Select agent runtime"
      >
        {options.map(({ runtime, label: optionLabel }) => {
          const reason = unavailableReason(runtime, omp);
          return (
            <option
              key={runtime}
              value={runtime}
              disabled={isRuntimeDisabled(runtime, runtimeScope) || reason !== null}
            >
              {reason === null ? optionLabel : `${optionLabel} (${reason})`}
            </option>
          );
        })}
      </select>
      <p className="text-xs text-text-tertiary">
        {options.length === flavorOptionCount
          ? scopeHelp(runtimeScope)
          : `${scopeHelp(runtimeScope)} Runtimes for providers turned off in Settings → Integrations are hidden.`}
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
    </div>
  );
}
