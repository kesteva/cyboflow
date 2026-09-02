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
 * than one DEFAULT-ELIGIBLE provider activated (claude/codex — see
 * onboardingStore.defaultAgentCandidates), because with a single agent there is
 * nothing to choose. OMP is activatable on Connect but no launch picker offers
 * its runtimes yet, so it is neither a row here nor a reason to show this step.
 *
 * The question is asked at PROVIDER level — the axis the user just answered on
 * the Connect step — and each row names the runtime the choice resolves to, so
 * the mapping is visible rather than implied. The gate writes the resolved
 * runtime to `AppConfig.defaultAgentRuntime`, the middle rung of
 * `resolveRunTypeLaunchDefaults`, so it seeds quick sessions and flow runs alike
 * and stays overridable per launch and in Settings → Session settings.
 */
interface DefaultRuntimeStepProps {
  /** Default-eligible providers the Connect step left activated, in registry order. */
  providers: ReadonlyArray<'claude' | 'codex'>;
  /** Current selection; null while the gate is still resolving the seed. */
  value: AgentProvider | null;
  onChange: (provider: AgentProvider) => void;
}

export function DefaultRuntimeStep({
  providers,
  value,
  onChange,
}: DefaultRuntimeStepProps): React.JSX.Element {
  return (
    <div className="px-6 pb-3 pt-5">
      <div className="mb-3 text-[12px] leading-[1.6] text-text-primary">
        This will set your agent for the Cyboflow chat and your default for new sessions. You can
        change it per launch or change your default in settings.
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
              <span className="min-w-0 flex-1 text-[12px] font-bold text-text-primary">
                {AGENT_PROVIDER_LABELS[provider]}
              </span>
              <span className="flex-shrink-0 text-[10px] uppercase tracking-[.1em] text-text-secondary">
                {AGENT_RUNTIME_LABELS[PROVIDER_DEFAULT_RUNTIME[provider]]}
              </span>
            </button>
          );
        })}
      </div>

      {/* The one caveat the copy above would otherwise state falsely: the chat
          assistant is hard-wired to ClaudeCodeManager, so "your agent for the
          Cyboflow chat" does not yet follow a Codex default. Shown only when
          Codex is the highlighted choice — with Claude picked there is nothing
          to qualify. */}
      {value === 'codex' && (
        <div className="mt-3 text-[10px] leading-[1.5] text-text-tertiary">
          The Cyboflow chat assistant runs on Claude for now.
        </div>
      )}
    </div>
  );
}
