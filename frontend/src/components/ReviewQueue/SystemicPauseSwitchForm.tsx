/**
 * SystemicPauseSwitchForm — the inline "Switch runtime & retry" control
 * rendered by {@link ../../components/ReviewQueue/ReviewItemCard} for a
 * `gate:systemic-pause:<stepId>` decision item (plan v2: a programmatic
 * step's agent hit a Claude subscription/session limit).
 *
 * Lets the human re-target the blocked agent(s) onto a different
 * runtime/model/effort and retry the paused step immediately, via
 * `runs.switchPausedStepAgents`. Mirrors the runtime/model/effort picker
 * pattern in `WorkflowStepInspector.tsx`'s `AgentConfigSection` /
 * `ProviderAgentModelSelect` (~L1080-1300), but scoped to ONE run's pause
 * rather than a workflow's saved config, and reading provider READINESS
 * (signed in / installed) rather than just the Settings enable toggle — a
 * provider can be enabled but not actually usable on this machine, and
 * offering it here would just trade one stuck pause for another.
 *
 * Deliberately duplicates the small payload-narrowing helper that
 * ReviewItemCard.tsx also has (`isSystemicPauseItem` et al.) instead of
 * importing it: `'systemic-pause'` is not yet a member of
 * {@link DecisionPayload}'s `gate` union (the backend lane adds it alongside
 * this form — plan v2 D2), so each file reads the payload defensively via its
 * own `unknown` cast and compiles independently of when the union lands.
 */
import React from 'react';
import { Button } from '../ui/Button';
import { trpc } from '../../trpc/client';
import { trackEvent } from '../../utils/telemetry';
import { API } from '../../utils/api';
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { RunAgentTarget } from '../../../../shared/types/workflows';
import {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_LABELS,
  WORKFLOW_LAUNCHABLE_RUNTIMES,
  WORKFLOW_AGENT_RUNTIME_LABELS,
  providerForRuntime,
  isWorkflowLaunchableRuntime,
  isAgentProviderEnabled,
  type AgentProvider,
  type WorkflowLaunchableRuntime,
} from '../../../../shared/types/agentRuntime';
import { AGENT_MODEL_ALIASES, AGENT_MODEL_LABELS, type AgentModelAlias } from '../../../../shared/types/agents';
import { effortLevelsForProvider, type ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useCodexModelCatalog } from '../../stores/codexModelCatalogStore';
import { useOmpModelCatalog } from '../../stores/ompModelCatalogStore';
import { useProviderModelCatalog } from '../../stores/providerModelCatalogStore';

interface SystemicPauseSwitchFormProps {
  item: ReviewItem;
  /** Called once the switch is delivered (retried or not) — collapses the form. */
  onDone: () => void;
}

/** The subset of the systemic-pause payload this form reads, parsed defensively. */
interface SystemicPausePayloadFields {
  agentKeys?: string[];
  blockedProvider?: AgentProvider;
  fanOut?: boolean;
}

function pausePayloadFields(item: ReviewItem): SystemicPausePayloadFields {
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return {};
  const p = payload as { agentKeys?: unknown; blockedProvider?: unknown; fanOut?: unknown };
  const agentKeys =
    Array.isArray(p.agentKeys) && p.agentKeys.every((k) => typeof k === 'string')
      ? (p.agentKeys as string[])
      : undefined;
  const blockedProvider =
    typeof p.blockedProvider === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(p.blockedProvider)
      ? (p.blockedProvider as AgentProvider)
      : undefined;
  const fanOut = typeof p.fanOut === 'boolean' ? p.fanOut : undefined;
  return { agentKeys, blockedProvider, fanOut };
}

/** One provider's on-this-machine readiness, as this form cares about it. */
type ProviderReadiness = 'checking' | 'ready' | 'loggedOut' | 'missing' | 'unavailable' | 'disabled';

function toReadiness(state: string): ProviderReadiness {
  if (state === 'detected') return 'ready';
  if (state === 'loggedOut') return 'loggedOut';
  if (state === 'missing') return 'missing';
  return 'unavailable';
}

/** The " — not signed in" / " — not installed" suffix an unready option gets. */
function readinessSuffix(state: ProviderReadiness): string {
  switch (state) {
    case 'loggedOut':
      return ' — not signed in';
    case 'missing':
    case 'unavailable':
      return ' — not installed';
    case 'disabled':
      return ' — turned off in Settings';
    default:
      return '';
  }
}

/** Human copy for every `runs.switchPausedStepAgents` `noOp` reason. */
const NOOP_MESSAGE: Record<string, string> = {
  not_found: 'Run not found.',
  not_programmatic: 'Only programmatic runs can switch agents.',
  no_target: 'Pick a runtime, model or effort to switch to.',
  invalid_target: "That runtime/model/effort combination isn't valid.",
  provider_disabled: 'That provider is switched off in Settings → Integrations.',
  provider_unavailable: "That provider isn't installed or signed in on this machine.",
  item_not_pending: 'This pause has already cleared — the switch was not applied.',
  item_mismatch: "This pause item is no longer the run's current pause; reload and try again.",
  no_agents: 'No agent in this run is on that provider.',
  step_scope_unavailable:
    "Only-these-agents isn't available for a fan-out pause; switch every agent on the provider instead.",
};

export function SystemicPauseSwitchForm({ item, onDone }: SystemicPauseSwitchFormProps): React.ReactElement {
  const providerAccess = useAgentProviderAccess();
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  // Resolve the run's own provider/runtime/model — mirrors RunActionBar.tsx:64-80
  // (search every tracked project; the rail is project-keyed but the run id is
  // unique). Falls back to Claude defaults when the run isn't in the store yet.
  let runProvider: AgentProvider | undefined;
  let runRuntimeRaw: string | undefined;
  for (const runs of Object.values(runsByProject)) {
    const found = item.run_id === null ? undefined : runs.find((r) => r.id === item.run_id);
    if (found) {
      runProvider = found.agent_provider;
      runRuntimeRaw = found.agent_runtime;
      break;
    }
  }
  const fields = pausePayloadFields(item);
  const blockedProvider: AgentProvider = fields.blockedProvider ?? runProvider ?? 'claude';
  const fallbackRuntime: WorkflowLaunchableRuntime = isWorkflowLaunchableRuntime(runRuntimeRaw)
    ? runRuntimeRaw
    : 'claude-sdk';

  // -- Readiness probe (once per mount) -------------------------------------

  const [readiness, setReadiness] = React.useState<Record<AgentProvider, ProviderReadiness>>(() => {
    const initial = {} as Record<AgentProvider, ProviderReadiness>;
    for (const p of AGENT_PROVIDERS) {
      initial[p] = isAgentProviderEnabled(providerAccess, p) ? 'checking' : 'disabled';
    }
    return initial;
  });

  React.useEffect(() => {
    let cancelled = false;
    const toProbe = AGENT_PROVIDERS.filter((p) => isAgentProviderEnabled(providerAccess, p));
    void Promise.all(
      toProbe.map(async (p): Promise<readonly [AgentProvider, ProviderReadiness]> => {
        try {
          const result = await API.providers.detect(p);
          return [p, result.success && result.data ? toReadiness(result.data.state) : 'unavailable'];
        } catch {
          return [p, 'unavailable'];
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setReadiness((prev) => {
        const next = { ...prev };
        for (const [p, state] of entries) next[p] = state;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // Probed once per mount — this is a one-shot dialog, not a live picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stillChecking = AGENT_PROVIDERS.some((p) => readiness[p] === 'checking');

  // -- Scope --------------------------------------------------------------

  const canScopeStep = fields.fanOut !== true && (fields.agentKeys?.length ?? 0) > 0;
  const [scope, setScope] = React.useState<'provider' | 'step'>('provider');

  // -- Runtime (default recomputes live as readiness resolves, until touched) --

  const [runtimeChoice, setRuntimeChoice] = React.useState<WorkflowLaunchableRuntime | null>(null);
  const defaultRuntime = React.useMemo<WorkflowLaunchableRuntime>(() => {
    const readyOther = WORKFLOW_LAUNCHABLE_RUNTIMES.find(
      (r) => readiness[providerForRuntime(r)] === 'ready' && providerForRuntime(r) !== blockedProvider,
    );
    return readyOther ?? fallbackRuntime;
  }, [readiness, blockedProvider, fallbackRuntime]);
  const selectedRuntime = runtimeChoice ?? defaultRuntime;
  const selectedProvider = providerForRuntime(selectedRuntime);

  // -- Model / effort (reset whenever the selected provider changes) --------

  const [modelAlias, setModelAlias] = React.useState<AgentModelAlias | ''>('');
  const [providerModelId, setProviderModelId] = React.useState('');
  const [effort, setEffort] = React.useState<ReasoningEffort | ''>('');
  // A model/effort chosen for the PREVIOUS provider is meaningless on the new
  // one (a Claude alias isn't a Codex model id, and the effort scales differ)
  // — reset to inherit/default whenever the selected provider changes, rather
  // than silently forwarding a stale value into the submit payload.
  React.useEffect(() => {
    setModelAlias('');
    setProviderModelId('');
    setEffort('');
  }, [selectedProvider]);

  const codexCatalog = useCodexModelCatalog(selectedProvider === 'codex');
  const ompCatalog = useOmpModelCatalog(selectedProvider === 'omp');
  const piCatalog = useProviderModelCatalog('pi', selectedProvider === 'pi');

  // -- Submit ---------------------------------------------------------------

  const [submitting, setSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [noteMessage, setNoteMessage] = React.useState<string | null>(null);

  const handleSubmit = (): void => {
    if (item.run_id === null || submitting || stillChecking) return;
    setSubmitting(true);
    setErrorMessage(null);
    setNoteMessage(null);
    const target: RunAgentTarget = {
      runtime: selectedRuntime,
      model: selectedProvider === 'claude' ? (modelAlias === '' ? null : modelAlias) : null,
      providerModel: selectedProvider !== 'claude' ? (providerModelId === '' ? null : providerModelId) : null,
      effort: effort === '' ? null : effort,
    };
    void trpc.cyboflow.runs.switchPausedStepAgents
      .mutate({ runId: item.run_id, reviewItemId: item.id, scope, target })
      .then((result) => {
        if ('delivered' in result) {
          // TelemetryEventMap['review_item_resolved']['action'] (shared/types/
          // telemetry.ts — owned by a concurrent lane in this worktree, not
          // editable here) has no 'switch_agents' member yet: reuses the
          // generic 'resolve' tag, which is what this ultimately is
          // server-side (switchPausedStepAgents resolves the pause item once
          // the override is written). A future telemetry-union addition can
          // split this into its own action if the distinction earns its keep.
          trackEvent('review_item_resolved', { kind: item.kind, action: 'resolve', blocking: item.blocking });
          if (result.retried === false) {
            setNoteMessage(
              result.note ?? "The pause had already cleared; the switch applies from the run's next spawn.",
            );
          }
          onDone();
        } else {
          setErrorMessage(NOOP_MESSAGE[result.noOp] ?? "Could not switch the run's agents.");
        }
      })
      .catch(() => {
        setErrorMessage("Could not switch the run's agents — please try again.");
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const providerModelOptions =
    selectedProvider === 'omp'
      ? ompCatalog.options
      : selectedProvider === 'pi'
        ? (piCatalog.catalog?.models ?? [])
        : codexCatalog.options;

  const selectStyle =
    'rounded border border-border-primary bg-bg-secondary px-2 py-1 text-xs text-text-primary';

  return (
    <div
      className="flex flex-col gap-2 rounded border border-border-primary bg-bg-primary p-2"
      data-testid="pause-switch-form"
    >
      {/* -- Scope -- */}
      <div className="flex flex-col gap-1 text-xs text-text-primary">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`pause-switch-scope-${item.id}`}
            checked={scope === 'provider'}
            onChange={() => setScope('provider')}
            data-testid="pause-switch-scope-provider"
          />
          Every agent on {AGENT_PROVIDER_LABELS[blockedProvider]}
        </label>
        {canScopeStep && (
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`pause-switch-scope-${item.id}`}
              checked={scope === 'step'}
              onChange={() => setScope('step')}
              data-testid="pause-switch-scope-step"
            />
            Only {fields.agentKeys?.join(', ')}
          </label>
        )}
      </div>

      {/* -- Runtime -- */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-text-tertiary" htmlFor={`pause-switch-runtime-${item.id}`}>
          runtime
        </label>
        <select
          id={`pause-switch-runtime-${item.id}`}
          value={selectedRuntime}
          onChange={(e) => setRuntimeChoice(e.target.value as WorkflowLaunchableRuntime)}
          className={selectStyle}
          disabled={submitting}
          data-testid="pause-switch-runtime"
        >
          {WORKFLOW_LAUNCHABLE_RUNTIMES.map((runtime) => {
            const provider = providerForRuntime(runtime);
            const state = readiness[provider];
            return (
              <option key={runtime} value={runtime} disabled={state !== 'ready'}>
                {WORKFLOW_AGENT_RUNTIME_LABELS[runtime]}
                {readinessSuffix(state)}
              </option>
            );
          })}
        </select>
        {selectedProvider === blockedProvider && (
          <p className="text-[10px] text-status-warning" data-testid="pause-switch-same-provider">
            Still on {AGENT_PROVIDER_LABELS[blockedProvider]} — if the whole provider is rate-limited, a
            different model on the same provider may hit the same limit.
          </p>
        )}
      </div>

      {/* -- Model -- */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-text-tertiary" htmlFor={`pause-switch-model-${item.id}`}>
          model
        </label>
        {selectedProvider === 'claude' ? (
          <select
            id={`pause-switch-model-${item.id}`}
            value={modelAlias}
            onChange={(e) => setModelAlias(e.target.value as AgentModelAlias | '')}
            className={selectStyle}
            disabled={submitting}
            data-testid="pause-switch-model"
          >
            <option value="">(inherit)</option>
            {AGENT_MODEL_ALIASES.map((alias) => (
              <option key={alias} value={alias}>
                {AGENT_MODEL_LABELS[alias]}
              </option>
            ))}
          </select>
        ) : (
          <select
            id={`pause-switch-model-${item.id}`}
            value={providerModelId}
            onChange={(e) => setProviderModelId(e.target.value)}
            className={selectStyle}
            disabled={submitting}
            data-testid="pause-switch-model"
          >
            <option value="">(provider default)</option>
            {providerModelOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* -- Effort -- */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-text-tertiary" htmlFor={`pause-switch-effort-${item.id}`}>
          reasoning effort
        </label>
        <select
          id={`pause-switch-effort-${item.id}`}
          value={effort}
          onChange={(e) => setEffort(e.target.value as ReasoningEffort | '')}
          className={selectStyle}
          disabled={submitting}
          data-testid="pause-switch-effort"
        >
          <option value="">(inherit)</option>
          {effortLevelsForProvider(selectedProvider).map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={submitting || stillChecking || item.run_id === null}
          onClick={handleSubmit}
          data-testid="pause-switch-submit"
        >
          {stillChecking ? 'Checking providers…' : 'Switch & retry'}
        </Button>
      </div>

      {errorMessage && (
        <p className="text-xs text-status-error" role="alert" data-testid="pause-switch-error">
          {errorMessage}
        </p>
      )}
      {noteMessage && (
        <p className="text-xs text-text-tertiary" data-testid="pause-switch-note">
          {noteMessage}
        </p>
      )}
    </div>
  );
}
