import {
  AGENT_PROVIDER_LABELS,
  AGENT_RUNTIME_LABELS,
  PROVIDER_DEFAULT_RUNTIME,
  type AgentProvider,
} from '../../../../../shared/types/agentRuntime';

/**
 * Step 2 — "which agent should new sessions use by default?"
 *
 * CONDITIONAL: the gate only renders this step when the Connect step left more
 * than one provider activated (see onboardingStore.isStepSkipped), because with
 * a single agent there is nothing to choose.
 *
 * The question is asked at PROVIDER level — the axis the user just answered on
 * the Connect step — and each row names the runtime the choice resolves to, so
 * the mapping is visible rather than implied. The gate writes the resolved
 * runtime to `AppConfig.defaultAgentRuntime`, the middle rung of
 * `resolveRunTypeLaunchDefaults`, so it seeds quick sessions and flow runs alike
 * and stays overridable per launch and in Settings → Session settings.
 */
interface DefaultRuntimeStepProps {
  /** Providers the Connect step left activated, in registry order. */
  providers: readonly AgentProvider[];
  /** Current selection; null while the gate is still resolving the seed. */
  value: AgentProvider | null;
  onChange: (provider: AgentProvider) => void;
}

/** One-line reason to pick this agent, in the vocabulary the tour has used. */
const PROVIDER_BLURBS: Record<AgentProvider, string> = {
  claude: 'Structured SDK sessions with full approval routing and step tracking.',
  codex: 'ChatGPT-authenticated runtime, billed against your existing plan.',
  omp: 'Multi-provider runtime — see its v1 limits in the launch wizard.',
  pi: 'The terminal coding agent OMP forked from — multi-provider models via its own accounts.',
};

export function DefaultRuntimeStep({
  providers,
  value,
  onChange,
}: DefaultRuntimeStepProps): React.JSX.Element {
  return (
    <div className="px-6 pb-3 pt-5">
      <div className="mb-3 text-[12px] leading-[1.6] text-text-primary">
        You connected more than one agent. Pick the one new sessions and flow runs should start on
        — you can still change it per launch, or later in Settings → Session settings.
      </div>

      <div
        role="radiogroup"
        aria-label="Default agent for new sessions"
        className="flex flex-col gap-2"
      >
        {providers.map((provider) => {
          const selected = value === provider;
          return (
            <button
              key={provider}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(provider)}
              className={`flex items-center gap-3 border px-[15px] py-3 text-left transition-colors ${
                selected
                  ? 'border-border-emphasized bg-surface-primary'
                  : 'border-border-primary bg-surface-primary hover:border-border-emphasized'
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-[1.4px] ${
                  selected ? 'border-interactive' : 'border-border-primary'
                }`}
              >
                {selected && <span className="h-[8px] w-[8px] rounded-full bg-interactive" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-bold text-text-primary">
                  {AGENT_PROVIDER_LABELS[provider]}
                </span>
                <span className="mt-px block text-[10px] leading-[1.5] text-text-tertiary">
                  {PROVIDER_BLURBS[provider]}
                </span>
              </span>
              <span className="flex-shrink-0 text-[10px] uppercase tracking-[.1em] text-text-secondary">
                {AGENT_RUNTIME_LABELS[PROVIDER_DEFAULT_RUNTIME[provider]]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 text-[10px] leading-[1.5] text-text-tertiary">
        This sets the default runtime only. The interactive CLI runtimes stay available in the
        launch wizard for quick sessions.
      </div>
    </div>
  );
}
