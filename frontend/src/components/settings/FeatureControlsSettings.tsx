import { AlarmClock, FileText, FolderOpen, Globe, ScanEye, Server, Terminal, ToggleRight } from 'lucide-react';
import { Checkbox } from '../ui/Input';
import { CollapsibleCard } from '../ui/CollapsibleCard';
import { SettingsSection } from '../ui/SettingsSection';
import { trackEvent } from '../../utils/telemetry';

/**
 * The AI tab's "Feature controls" group — the knobs that answer *is this
 * capability available at all*, as opposed to the "Session settings" group's
 * *what does a new session or run start with*.
 *
 * Props-in / callback-out only: every value still lives as lifted state in
 * `Settings.tsx` and is persisted by the shared `handleSubmit` there, so this is
 * a presentation container, not a self-fetching panel like `IntegrationsSettings`.
 */
export interface FeatureControlsSettingsProps {
  interactivePtyOnly: boolean;
  onInteractivePtyOnlyChange: (ptyOnly: boolean) => void;
  computeCostFromRates: boolean;
  onComputeCostFromRatesChange: (enabled: boolean) => void;
  artifactCommitDir: string;
  onArtifactCommitDirChange: (dir: string) => void;
  visualVerifyEnabled: boolean;
  autoBootstrapRunbook: boolean;
  onAutoBootstrapRunbookChange: (value: boolean) => void;
  onVisualVerifyEnabledChange: (enabled: boolean) => void;
  webViewerEnabled: boolean;
  onWebViewerEnabledChange: (enabled: boolean) => void;
  webViewerAgentObserve: boolean;
  onWebViewerAgentObserveChange: (enabled: boolean) => void;
  webViewerAgentDrive: boolean;
  onWebViewerAgentDriveChange: (enabled: boolean) => void;
  webViewerPersistLogin: boolean;
  onWebViewerPersistLoginChange: (enabled: boolean) => void;
  idleReviewEnabled: boolean;
  onIdleReviewEnabledChange: (enabled: boolean) => void;
  /** number | '' so clearing the field shows empty (never value={NaN}). */
  idleReviewThresholdMinutes: number | '';
  onIdleReviewThresholdMinutesChange: (minutes: number | '') => void;
  /** Render the Agents & Environments section at all (main says this is a dev build). Default false. */
  agentsAvailable?: boolean;
  agentsEnabled?: boolean;
  onAgentsEnabledChange?: (enabled: boolean) => void;
  /** CYBOFLOW_DISABLE_PERSISTENT_AGENTS is set: show why it stays off. */
  agentsKillSwitch?: boolean;
}

export function FeatureControlsSettings({
  interactivePtyOnly,
  onInteractivePtyOnlyChange,
  computeCostFromRates,
  onComputeCostFromRatesChange,
  artifactCommitDir,
  onArtifactCommitDirChange,
  visualVerifyEnabled,
  autoBootstrapRunbook,
  onAutoBootstrapRunbookChange,
  onVisualVerifyEnabledChange,
  webViewerEnabled,
  onWebViewerEnabledChange,
  webViewerAgentObserve,
  onWebViewerAgentObserveChange,
  webViewerAgentDrive,
  onWebViewerAgentDriveChange,
  webViewerPersistLogin,
  onWebViewerPersistLoginChange,
  idleReviewEnabled,
  onIdleReviewEnabledChange,
  idleReviewThresholdMinutes,
  onIdleReviewThresholdMinutesChange,
  agentsAvailable = false,
  agentsEnabled = false,
  onAgentsEnabledChange,
  agentsKillSwitch = false,
}: FeatureControlsSettingsProps): React.JSX.Element {
  return (
    <section data-testid="settings-feature-controls">
      <CollapsibleCard
        title="Feature controls"
        subtitle="Which capabilities are available in Cyboflow at all"
        icon={<ToggleRight className="w-5 h-5" />}
        defaultExpanded={true}
      >
        {/* A Feature control, not a session default: this answers "is the SDK
            substrate available in this app at all". Locking it to the CLI also
            hides the Session settings group's per-session runtime picker — the
            note below spells that dependency out. */}
        <SettingsSection
          title="CLI Runtime"
          description="How Cyboflow runs the Claude agent — the SDK or the live interactive terminal"
          icon={<Terminal className="w-4 h-4" />}
        >
          <div className="flex flex-col gap-1.5">
            {([
              { ptyOnly: false, label: 'Allow SDK', hint: 'Default · pick per run' },
              { ptyOnly: true, label: 'Interactive CLI only', hint: 'Force the live terminal' },
            ] as const).map(({ ptyOnly, label, hint }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  onInteractivePtyOnlyChange(ptyOnly);
                  trackEvent('substrate_default_changed', {
                    substrate: ptyOnly ? 'interactive' : 'sdk',
                  });
                }}
                aria-pressed={interactivePtyOnly === ptyOnly}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                  interactivePtyOnly === ptyOnly
                    ? 'border-interactive bg-interactive-surface'
                    : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="text-text-primary font-medium text-sm">{label}</span>
                <span className="text-xs text-text-tertiary">{hint}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-text-tertiary mt-2">
            "Interactive CLI only" forces every new run and quick session onto the live terminal
            substrate and hides the per-run picker. Pause/Resume (SDK-only) become unavailable, and
            the interactive substrate carries v1 limits. Only affects runs started after you save;
            demo mode always uses the SDK.
          </p>
        </SettingsSection>

        <SettingsSection
          title="Computed Run Cost"
          description="Choose how run-summary cards determine their displayed cost"
          icon={<FileText className="w-4 h-4" />}
        >
          <div className="flex flex-col gap-1.5">
            {([
              { enabled: false, label: 'Off', hint: 'Default · show provider-reported cost' },
              { enabled: true, label: 'On', hint: 'Compute from token usage and model rates' },
            ] as const).map(({ enabled, label, hint }) => (
              <button
                key={label}
                type="button"
                data-testid={`computed-run-cost-${enabled ? 'on' : 'off'}`}
                onClick={() => onComputeCostFromRatesChange(enabled)}
                aria-pressed={computeCostFromRates === enabled}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                  computeCostFromRates === enabled
                    ? 'border-interactive bg-interactive-surface'
                    : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                }`}
              >
                <span className="text-text-primary font-medium text-sm">{label}</span>
                <span className="text-xs text-text-tertiary">{hint}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-text-tertiary mt-2">
            When enabled, run-summary cards estimate cost from the run&apos;s token breakdown
            and resolved model pricing. Leave it off to show the cost reported by the provider.
            This setting applies globally to every run summary.
          </p>
        </SettingsSection>

        <SettingsSection
          title="Artifact Commit Location"
          description="Where committed artifacts are written on disk"
          icon={<FolderOpen className="w-4 h-4" />}
        >
          <input
            id="artifactCommitDir"
            type="text"
            value={artifactCommitDir}
            onChange={(e) => onArtifactCommitDirChange(e.target.value)}
            className="w-full px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary"
            placeholder=".cyboflow/artifacts"
          />
          <p className="text-xs text-text-tertiary mt-2">
            Directory for the on-disk copy written when you explicitly commit an artifact. A
            relative path resolves against each project's root (so it survives the worktree being
            torn down); an absolute path is used as-is. Leave empty to use the default
            (<code>.cyboflow/artifacts</code>).
          </p>
        </SettingsSection>

        <SettingsSection
          title="Visual Verification"
          description="Automatically screenshot and judge UI deliverables produced by workflow runs"
          icon={<ScanEye className="w-4 h-4" />}
        >
          <Checkbox
            label="Enable visual verification"
            checked={visualVerifyEnabled}
            onChange={(e) => onVisualVerifyEnabledChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1 mb-3">
            When enabled, workflow runs can request a visual check of a UI deliverable: Cyboflow
            captures a screenshot (offscreen render, headless browser, the iOS Simulator, or the
            live app) and a vision model judges it against the stated intent. Off by default; no
            captures run while disabled.
          </p>
          <Checkbox
            label="Let runs set up verification themselves"
            checked={autoBootstrapRunbook}
            disabled={!visualVerifyEnabled}
            onChange={(e) => onAutoBootstrapRunbookChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1">
            A check that has to build or serve your project is skipped unless the project has a
            verification runbook that was proven by an actual run — which today only the Verify
            Setup flow produces. With this on, a sprint or ship run that hits that wall derives a
            runbook itself, commits it to its own branch, and proves it before verifying; if the
            proof fails, the run advances exactly as it does now. On by default (unlike the switch
            above): without it, every project except one that already has a proven runbook stays
            permanently unverifiable. Turn it off if you don't want a run committing to your branch
            on its own.
          </p>
        </SettingsSection>

        <SettingsSection
          title="Web Viewer"
          description="Open links from chat as tabs inside Cyboflow, and what agents may do with them"
          icon={<Globe className="w-4 h-4" />}
        >
          <Checkbox
            label="Enable the web viewer"
            checked={webViewerEnabled}
            onChange={(e) => onWebViewerEnabledChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1 mb-3">
            Links in chat and transcripts open as a tab in the center pane instead of your OS
            browser (Cmd-click still goes to the browser). On by default. Turning this off is the
            master kill switch — it disables everything below too, and no page is loaded.
          </p>
          <Checkbox
            label="Let agents read web tabs"
            checked={webViewerAgentObserve}
            disabled={!webViewerEnabled}
            onChange={(e) => onWebViewerAgentObserveChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1 mb-3">
            Agents can pull console output, network activity, errors, page text and screenshots —
            the point being to debug a page you are both looking at. Off by default. Tabs an agent
            opened itself are read freely; reading a tab <em>you</em> opened, or one you have typed
            into, asks you first.
          </p>
          <Checkbox
            label="Let agents drive web tabs"
            checked={webViewerAgentDrive}
            disabled={!webViewerEnabled}
            onChange={(e) => onWebViewerAgentDriveChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1 mb-3">
            Agents can navigate, click, type and evaluate JavaScript in a tab. Off by default, and
            every tab asks you once before the first drive — re-asking if the page navigates
            somewhere else.
          </p>
          <Checkbox
            label="Stay signed in between launches"
            checked={webViewerPersistLogin}
            disabled={!webViewerEnabled}
            onChange={(e) => onWebViewerPersistLoginChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1">
            Keeps cookies for tabs you opened, so you do not sign in to the same site every
            launch. Agent-opened tabs always use a throwaway cookie jar that is wiped on quit and
            never shares your logins, whatever this is set to.
          </p>
        </SettingsSection>

        <SettingsSection
          title="Idle Session Review"
          description="Surface quiet CLI quick sessions in the human review queue"
          icon={<AlarmClock className="w-4 h-4" />}
        >
          <Checkbox
            label="Surface idle quick sessions for review"
            checked={idleReviewEnabled}
            onChange={(e) => onIdleReviewEnabledChange(e.target.checked)}
          />
          <p className="text-xs text-text-tertiary mt-1 mb-3">
            When an interactive quick session finishes its turn and sits unviewed past the
            threshold below, Cyboflow adds a blocking item to Human review — so a session waiting
            on you shows up even if the agent never filed a finding. The item clears itself once
            you reopen the session or it starts a new turn.
          </p>
          <label htmlFor="idleReviewThreshold" className="block text-sm text-text-secondary mb-1">
            Idle threshold (minutes)
          </label>
          <input
            id="idleReviewThreshold"
            type="number"
            min={1}
            step={1}
            disabled={!idleReviewEnabled}
            value={idleReviewThresholdMinutes}
            onChange={(e) =>
              onIdleReviewThresholdMinutesChange(e.target.value === '' ? '' : e.target.valueAsNumber)
            }
            className="w-28 px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary disabled:opacity-50"
          />
          <p className="text-xs text-text-tertiary mt-2">
            How long a session may sit finished-and-unviewed before it's surfaced. Defaults to 5.
          </p>
        </SettingsSection>

        {agentsAvailable && (
          <SettingsSection
            title="Agents & Environments"
            description="Persistent agents you message from cyboflow (dev builds only)"
            icon={<Server className="w-4 h-4" />}
          >
            <Checkbox
              data-testid="settings-agents-toggle"
              label="Enable Agents & Environments"
              checked={agentsEnabled}
              onChange={(e) => onAgentsEnabledChange?.(e.target.checked)}
            />
            <p className="text-xs text-text-tertiary mt-1">
              Adds the Agents &amp; Environments pane, the Persistent agents rail section and the cyboflow cloud
              card in Integrations. Connect agents that live with other vendors and message them here. Off by
              default. Turning it off stops agent messaging but keeps your agents, threads and sign-in.
            </p>
            {agentsKillSwitch && (
              <p className="text-xs text-status-warning mt-1">
                Turned off on this computer by CYBOFLOW_DISABLE_PERSISTENT_AGENTS.
              </p>
            )}
          </SettingsSection>
        )}
      </CollapsibleCard>
    </section>
  );
}
