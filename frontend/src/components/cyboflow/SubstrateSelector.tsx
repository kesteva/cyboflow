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
 * Global PTY-only lock: when Settings → AI Integration → CLI runtime is set to
 * "Interactive PTY only" (config.interactivePtyOnly), the SDK is disabled and
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
 * controls Codex availability: Codex SDK is launchable for workflows and quick
 * sessions; Codex PTY remains session-only.
 */
import { useEffect } from 'react';
import {
  isSessionAgentRuntime,
  isWorkflowAgentRuntime,
} from '../../../../shared/types/agentRuntime';
import { useForcedSubstrate } from '../../hooks/useForcedSubstrate';
import {
  quickSessionRuntimeForLaunch,
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

function isRuntimeDisabled(runtime: LaunchAgentRuntime, scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): boolean {
  if (scope === 'workflow') return workflowRuntimeForLaunch(runtime) === null;
  if (scope === 'session') return quickSessionRuntimeForLaunch(runtime) === null;
  return (
    workflowRuntimeForLaunch(runtime) === null &&
    quickSessionRuntimeForLaunch(runtime) === null
  );
}

function scopeHelp(scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): string {
  if (scope === 'workflow') {
    return 'Workflows can run on Claude or Codex SDK. Codex PTY remains quick-session-only.';
  }
  if (scope === 'session') {
    return 'Codex SDK runs structured quick-session chat. Codex PTY opens an interactive terminal-style Codex session.';
  }
  return 'Codex SDK can run workflows or quick sessions. Codex PTY starts quick sessions only.';
}

function InteractiveCaveats({ testId }: { testId: string }): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role="note"
      className="mt-1 rounded-input border border-status-warning bg-bg-secondary px-3 py-2 text-xs text-text-secondary"
    >
      <p className="mb-1 font-semibold text-text-primary">Interactive substrate — v1 limits</p>
      <ul className="list-disc space-y-1 pl-4">
        {INTERACTIVE_CAVEATS.map((caveat) => (
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
  // Reactive read so a config fetch resolving AFTER mount still locks the picker.
  const forced = useForcedSubstrate();

  // Under the interactive lock, keep the controlled value consistent so the
  // launch payload matches the backend pin. Scoped to 'interactive' only: demo's
  // 'sdk' pin is left alone so demo's picker behaves as before (cosmetic — the
  // backend forces 'sdk' regardless). After value reaches 'interactive' the
  // guard stops re-firing (safe with an unstable onChange identity).
  useEffect(() => {
    if (forced === 'interactive' && value !== 'claude-interactive') onChange('claude-interactive');
  }, [forced, value, onChange]);

  // Only the user-facing interactive lock gets the read-only locked UI. Demo
  // mode also pins ('sdk'), but it is a throwaway showcase profile — leave the
  // normal select so demo never falsely renders "Interactive (PTY) — locked".
  if (forced === 'interactive') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        <div
          data-testid="substrate-locked"
          aria-label="Agent runtime locked to Claude interactive PTY"
          className="w-full rounded-input border border-border-primary bg-bg-secondary px-2 py-1 text-sm text-text-secondary"
        >
          Claude interactive (PTY) — locked
        </div>
        <p className="text-xs text-text-tertiary">
          Claude SDK is disabled globally (Settings → AI Integration → CLI runtime). Every run uses
          the interactive PTY runtime.
        </p>
        <InteractiveCaveats testId={caveatsTestId} />
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
            (isSessionAgentRuntime(next) || isWorkflowAgentRuntime(next)) &&
            !isRuntimeDisabled(next, runtimeScope)
          ) {
            onChange(next);
          }
        }}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label="Select agent runtime"
      >
        <option value="claude-sdk">Claude SDK (default)</option>
        <option value="claude-interactive">Claude interactive (PTY)</option>
        <option value="codex-sdk" disabled={isRuntimeDisabled('codex-sdk', runtimeScope)}>
          Codex SDK
        </option>
        <option value="codex-pty" disabled={isRuntimeDisabled('codex-pty', runtimeScope)}>
          Codex PTY — quick sessions only
        </option>
      </select>
      <p className="text-xs text-text-tertiary">
        {scopeHelp(runtimeScope)}
      </p>

      {value === 'claude-interactive' && <InteractiveCaveats testId={caveatsTestId} />}
    </div>
  );
}
