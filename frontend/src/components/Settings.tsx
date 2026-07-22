import { useState, useEffect } from 'react';
import { NotificationSettings } from './NotificationSettings';
import { UpdateSettings } from './UpdateSettings';
import { useNotifications } from '../hooks/useNotifications';
import { API } from '../utils/api';
import { emitTelemetryChangeEvents, trackEvent } from '../utils/telemetry';
import type { AppConfig } from '../types/config';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import { useConfigStore } from '../stores/configStore';
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  Palette,
  Zap,
  FileText,
  Eye,
  ShieldCheck,
  Terminal,
  FolderOpen,
  ScanEye,
  AlarmClock,
  Compass,
  Bot
} from 'lucide-react';
import { Textarea, Checkbox } from './ui/Input';
import { Button } from './ui/Button';
import { useTheme } from '../contexts/ThemeContext';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { CollapsibleCard } from './ui/CollapsibleCard';
import { SettingsSection } from './ui/SettingsSection';
import { PERMISSION_MODE_OPTIONS } from './cyboflow/AgentPermissionModeSelector';
import { ModelSelector } from './cyboflow/ModelSelector';
import { useOnboardingStore } from '../stores/onboardingStore';
import { IntegrationsSettings } from './settings/IntegrationsSettings';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab to show when the dialog opens (defaults to 'general'). */
  initialTab?: 'general' | 'ai' | 'assistant' | 'integrations' | 'notifications' | 'updates';
}

export function Settings({ isOpen, onClose, initialTab }: SettingsProps) {
  const [_config, setConfig] = useState<AppConfig | null>(null);
  const [verbose, setVerbose] = useState(false);
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState('');
  const [claudeExecutablePath, setClaudeExecutablePath] = useState('');
  const [devMode, setDevMode] = useState(false);
  // DEV-ONLY: forces the next AskUserQuestion gate to fail so the durable recovery
  // gate can be exercised live. Hidden in the stable DMG; inert in packaged builds.
  const [forceAskUserQuestionGateFailure, setForceAskUserQuestionGateFailure] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  // demoMode is read once at app startup, so the saved value only takes effect
  // after a relaunch — track the loaded value to detect a toggle on save.
  const [initialDemoMode, setInitialDemoMode] = useState(false);
  // Build channel: 'stable' (stable DMG) | 'dev' (dev DMG) | undefined (dev server).
  // Demo mode is hidden in the stable DMG (it's a dev/internal affordance).
  const [buildVariant, setBuildVariant] = useState<'stable' | 'dev' | undefined>(undefined);
  const [additionalPathsText, setAdditionalPathsText] = useState('');
  const [enableCyboflowFooter, setEnableCyboflowFooter] = useState(true);
  // Model alias for the global cyboflow assistant (the agent-rail chat). '' =
  // follow the app's default model (defaultModel / getDefaultModel()).
  const [assistantModel, setAssistantModel] = useState('');
  // Global assistant on/off (default ON). Off hides the agent rail and blocks
  // the server-side kill switch, so no turn (including the auto-digest) spawns.
  const [assistantEnabled, setAssistantEnabled] = useState(true);
  // Extra folders (one per line) the assistant may read, beyond the app's
  // registered project folders (always readable regardless of this list).
  const [assistantFolderPathsText, setAssistantFolderPathsText] = useState('');
  const [defaultAgentPermissionMode, setDefaultAgentPermissionMode] = useState<PermissionMode>('default');
  // Global CLI runtime: false = allow SDK (per-run picker available, default
  // 'sdk'); true = force the interactive PTY substrate everywhere (SDK disabled).
  const [interactivePtyOnly, setInteractivePtyOnly] = useState(false);
  // Global default execution model for new SDK runs: 'programmatic' (default · the
  // in-process WorkflowController host walks the run's DAG) or 'orchestrated' (the
  // classic orchestrator agent drives the steps).
  const [defaultExecutionModel, setDefaultExecutionModel] = useState<ExecutionModel>('programmatic');
  // Default workspace for NEW quick sessions: 'worktree' (default · isolated git
  // worktree) or 'in-place' (work directly in the project checkout). A per-session
  // override lives in the launch wizard's Advanced options.
  const [quickSessionWorktreeMode, setQuickSessionWorktreeMode] = useState<QuickSessionWorktreeMode>('worktree');
  // Global default CLI substrate for NEW quick sessions: 'interactive' (default ·
  // live PTY terminal) or 'sdk'. Seeds the launch wizard's substrate picker for
  // quick/ultracode cards; a per-launch override still wins.
  const [quickSessionDefaultSubstrate, setQuickSessionDefaultSubstrate] = useState<CliSubstrate>('interactive');
  // Global code-review-eval toggle (default ON) — the K=3 Opus jury pass fired at
  // a built-in flow's human-review step. A per-run Configure override outranks it.
  const [codeReviewEvalEnabled, setCodeReviewEvalEnabled] = useState(true);
  // Run-summary cost display mode: false (default) uses the provider-reported
  // cost; true computes it from the run's token breakdown and model rates.
  const [computeCostFromRates, setComputeCostFromRates] = useState(false);
  // A/B testing slice C sub-toggle: auto-grade variant/experiment-arm runs
  // (per-arm rubric eval + the pairwise judge) on top of the global eval toggle
  // above. Absent/undefined = ENABLED.
  const [autoGradeVariantRuns, setAutoGradeVariantRuns] = useState(true);
  // Telemetry is opt-out (default on). These flags take effect after a restart
  // since the SDKs are initialized once at boot.
  const [errorReportingEnabled, setErrorReportingEnabled] = useState(true);
  const [usageMetricsEnabled, setUsageMetricsEnabled] = useState(true);
  // Where committed-artifact manifests are written on disk. Empty = use the
  // default ('.cyboflow/artifacts', resolved against each project's root).
  const [artifactCommitDir, setArtifactCommitDir] = useState('');
  // Layered visual verification master switch (default OFF). MVP exposes only the
  // master toggle; advanced numeric fields stay config-only for now.
  const [visualVerifyEnabled, setVisualVerifyEnabled] = useState(false);
  // Auto-surface idle PTY quick sessions into the human review queue (default ON).
  // A blocking human_task is minted for an interactive quick session that finished
  // a turn and has sat unviewed longer than idleReviewThresholdMinutes.
  const [idleReviewEnabled, setIdleReviewEnabled] = useState(true);
  // number | '' so clearing the field shows empty (never value={NaN}); the save
  // path floors a non-finite/empty value back to 5.
  const [idleReviewThresholdMinutes, setIdleReviewThresholdMinutes] = useState<number | ''>(5);
  const [notificationSettings, setNotificationSettings] = useState({
    enabled: true,
    playSound: true,
    notifyOnStatusChange: true,
    notifyOnWaiting: true,
    notifyOnComplete: true
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'ai' | 'assistant' | 'integrations' | 'notifications' | 'updates'>(initialTab ?? 'general');
  const { updateSettings } = useNotifications();
  const { theme, setTheme } = useTheme();
  const { fetchConfig: refreshConfigStore } = useConfigStore();

  useEffect(() => {
    if (isOpen) {
      fetchConfig();
      // Resolve the build channel so the stable DMG can hide dev-only toggles.
      API.getVersionInfo()
        .then((result) => {
          if (result.success) setBuildVariant(result.data.variant);
        })
        .catch(() => {
          // Non-fatal: if we can't resolve the variant, leave demo mode visible.
        });
      // Honor a requested tab each time the dialog is (re)opened.
      if (initialTab) {
        setActiveTab(initialTab);
      }
    }
  }, [isOpen, initialTab]);

  const fetchConfig = async () => {
    try {
      const response = await API.config.get();
      if (!response.success) throw new Error(response.error || 'Failed to fetch config');
      const data = response.data;
      setConfig(data);
      setVerbose(data.verbose || false);
      setGlobalSystemPrompt(data.systemPromptAppend || '');
      setClaudeExecutablePath(data.claudeExecutablePath || '');
      setDevMode(data.devMode || false);
      setForceAskUserQuestionGateFailure(data.forceAskUserQuestionGateFailure ?? false);
      setDemoMode(data.demoMode || false);
      setInitialDemoMode(data.demoMode || false);
      setEnableCyboflowFooter(data.enableCyboflowFooter !== false); // Default to true
      setAssistantModel(data.assistantModel ?? '');
      setAssistantEnabled(data.assistantEnabled !== false);
      setAssistantFolderPathsText((data.assistantFolderAccess ?? []).join('\n'));
      setDefaultAgentPermissionMode(data.defaultAgentPermissionMode ?? 'default');
      setInteractivePtyOnly(data.interactivePtyOnly ?? false);
      setDefaultExecutionModel(data.defaultExecutionModel ?? 'programmatic');
      setQuickSessionWorktreeMode(data.quickSessionWorktreeMode ?? 'worktree');
      setQuickSessionDefaultSubstrate(data.quickSessionDefaultSubstrate ?? 'interactive');
      setCodeReviewEvalEnabled(data.codeReviewEvalEnabled ?? true);
      setComputeCostFromRates(data.computeCostFromRates ?? false);
      setAutoGradeVariantRuns(data.autoGradeVariantRuns ?? true);
      setErrorReportingEnabled(data.telemetry?.errorReportingEnabled ?? true);
      setUsageMetricsEnabled(data.telemetry?.usageMetricsEnabled ?? true);
      setArtifactCommitDir(data.artifactCommitDir ?? '');
      setVisualVerifyEnabled(data.visualVerify?.enabled ?? false);
      setIdleReviewEnabled(data.idleSessionReview?.enabled ?? true);
      setIdleReviewThresholdMinutes(data.idleSessionReview?.thresholdMinutes ?? 5);

      // Load additional paths
      const paths = data.additionalPaths || [];
      setAdditionalPathsText(paths.join('\n'));
      
      // Load notification settings
      if (data.notifications) {
        setNotificationSettings(data.notifications);
        // Update the useNotifications hook with loaded settings
        updateSettings(data.notifications);
      }
    } catch (err) {
      setError('Failed to load configuration');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      // Parse the additional paths text into an array
      const parsedPaths = additionalPathsText
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);

      // Explicit array (possibly empty), never undefined — mirrors
      // additionalPaths below: updateConfig merges partials, so undefined
      // would fail to clear a previously-set list.
      const parsedAssistantFolderPaths = assistantFolderPathsText
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);

      const response = await API.config.update({
        verbose,
        systemPromptAppend: globalSystemPrompt,
        claudeExecutablePath,
        devMode,
        forceAskUserQuestionGateFailure,
        demoMode,
        enableCyboflowFooter,
        // Empty ('App default') → undefined so getAssistantModel() floors to
        // getDefaultModel() and config.json stays free of the key.
        assistantModel: assistantModel.trim() ? assistantModel.trim() : undefined,
        // Explicit boolean, never undefined — updateConfig merges partials, so
        // an undefined value would fail to overwrite a stored `false`.
        assistantEnabled: assistantEnabled,
        assistantFolderAccess: parsedAssistantFolderPaths,
        defaultAgentPermissionMode,
        interactivePtyOnly,
        defaultExecutionModel,
        quickSessionWorktreeMode,
        quickSessionDefaultSubstrate,
        codeReviewEvalEnabled,
        computeCostFromRates,
        autoGradeVariantRuns,
        // Empty field → undefined → the getter floors to the default (config.json
        // stays free of the key). A set value is trimmed before persisting.
        artifactCommitDir: artifactCommitDir.trim() ? artifactCommitDir.trim() : undefined,
        // Preserve any advanced visualVerify fields the user set in config.json
        // (the UI exposes only the master switch); overwrite just `enabled`.
        visualVerify: { ..._config?.visualVerify, enabled: visualVerifyEnabled },
        // Idle-session auto-review. A non-positive/NaN threshold floors to 5 on
        // the main side too, but clamp here so the persisted value stays sane.
        idleSessionReview: {
          enabled: idleReviewEnabled,
          thresholdMinutes:
            typeof idleReviewThresholdMinutes === 'number' &&
            Number.isFinite(idleReviewThresholdMinutes) &&
            idleReviewThresholdMinutes > 0
              ? idleReviewThresholdMinutes
              : 5,
        },
        additionalPaths: parsedPaths,
        notifications: notificationSettings,
        // Spread the existing telemetry first so the persisted installId is
        // preserved; fall back to '' (never undefined) if it was never set.
        telemetry: {
          installId: _config?.telemetry?.installId ?? '',
          ..._config?.telemetry,
          errorReportingEnabled,
          usageMetricsEnabled
        }
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to update configuration');
      }

      // Diff the saved telemetry flags against the pre-save baseline (captured
      // from `_config`, still holding the value loaded at fetch time — fetchConfig()
      // below overwrites it) via the shared helper — one event per channel that
      // actually changed value, fired only after a successful save, keeping the
      // event semantics identical to the onboarding Telemetry step.
      emitTelemetryChangeEvents(
        {
          errorReportingEnabled: _config?.telemetry?.errorReportingEnabled ?? true,
          usageMetricsEnabled: _config?.telemetry?.usageMetricsEnabled ?? true,
        },
        { errorReportingEnabled, usageMetricsEnabled },
      );

      // Update the useNotifications hook with new settings
      updateSettings(notificationSettings);

      // Refresh config from server
      await fetchConfig();

      // Also refresh the global config store
      await refreshConfigStore();

      // Demo mode is applied at boot — offer a relaunch when it was toggled.
      if (demoMode !== initialDemoMode) {
        const restartNow = window.confirm(
          demoMode
            ? 'Demo mode saved. Cyboflow needs to restart to enter the demo environment. Restart now?'
            : 'Demo mode disabled. Cyboflow needs to restart to return to your real workspace. Restart now?'
        );
        if (restartNow) {
          await window.electronAPI.relaunch();
          return;
        }
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update configuration');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" showCloseButton={false}>
      <ModalHeader 
        title="Cyboflow Settings"
        icon={<SettingsIcon className="w-5 h-5" />}
        onClose={onClose}
      />

      <ModalBody>
        {/* Tabs */}
        <div className="flex border-b border-border-primary mb-8">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'general'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'ai'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            AI
          </button>
          <button
            onClick={() => setActiveTab('assistant')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'assistant'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Assistant
          </button>
          <button
            onClick={() => setActiveTab('integrations')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'integrations'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Integrations
          </button>
          <button
            onClick={() => setActiveTab('notifications')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'notifications'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Notifications
          </button>
          <button
            onClick={() => setActiveTab('updates')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'updates'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Updates
          </button>
        </div>

        {activeTab === 'general' && (
          <form id="settings-form" onSubmit={handleSubmit} className="space-y-6">
            {/* Appearance */}
            <CollapsibleCard
              title="Appearance & Theme"
              subtitle="Customize how Cyboflow looks and feels"
              icon={<Palette className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Theme"
                description="Choose your color theme"
                icon={<Palette className="w-4 h-4" />}
              >
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: 'paper', label: 'Paper', Icon: FileText, hint: 'Warm paper · default' },
                    { id: 'dark', label: 'Dark', Icon: Moon, hint: 'Classic dark' },
                    { id: 'light', label: 'Light', Icon: Sun, hint: 'Lilac light' },
                  ] as const).map(({ id, label, Icon, hint }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setTheme(id);
                        trackEvent('theme_changed', { theme: id });
                      }}
                      aria-pressed={theme === id}
                      className={`flex flex-col items-start gap-1 px-3 py-3 rounded-button border transition-colors text-left ${
                        theme === id
                          ? 'border-interactive bg-interactive-surface'
                          : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                      }`}
                    >
                      <Icon className={`w-5 h-5 ${theme === id ? 'text-interactive' : 'text-text-tertiary'}`} />
                      <span className="text-text-primary font-medium">{label}</span>
                      <span className="text-xs text-text-tertiary">{hint}</span>
                    </button>
                  ))}
                </div>
              </SettingsSection>
            </CollapsibleCard>

            {/* Demo Mode — hidden in the stable DMG (dev/internal affordance) */}
            {buildVariant !== 'stable' && (
            <CollapsibleCard
              title="Demo Mode"
              subtitle="Tour Cyboflow with a sandbox project and scripted agents"
              icon={<Eye className="w-5 h-5" />}
              defaultExpanded={false}
              variant="subtle"
            >
              <SettingsSection
                title="Demo Mode"
                description="Explore every flow without touching your real projects"
                icon={<Eye className="w-4 h-4" />}
              >
                <Checkbox
                  label="Enable demo mode"
                  checked={demoMode}
                  onChange={(e) => setDemoMode(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  Restarts Cyboflow into a throwaway demo environment: add a sample project, run a
                  scripted Planner and Sprint (with every kind of human approval), try a quick
                  session, open a PR, and merge back to main. Your real projects, sessions, and
                  settings are untouched; demo data is discarded when you turn this off.
                </p>
              </SettingsSection>
            </CollapsibleCard>
            )}

            {/* Onboarding — replay the first-run walkthrough on demand */}
            <CollapsibleCard
              title="Onboarding"
              subtitle="First-run walkthrough"
              icon={<Compass className="w-5 h-5" />}
              defaultExpanded={false}
              variant="subtle"
            >
              <SettingsSection
                title="Onboarding"
                description="First-run walkthrough"
                icon={<Compass className="w-4 h-4" />}
              >
                <Button
                  variant="secondary"
                  onClick={() => {
                    useOnboardingStore.getState().restart();
                    onClose();
                  }}
                >
                  Replay walkthrough
                </Button>
              </SettingsSection>
            </CollapsibleCard>

            {/* Privacy & Telemetry */}
            <CollapsibleCard
              title="Privacy & Telemetry"
              subtitle="Help improve Cyboflow with anonymized diagnostics"
              icon={<ShieldCheck className="w-5 h-5" />}
              defaultExpanded={false}
              variant="subtle"
            >
              <SettingsSection
                title="Anonymized Diagnostics"
                description="Telemetry is fully anonymized — no source code, prompts, project or repository names, or file paths are ever sent."
                icon={<ShieldCheck className="w-4 h-4" />}
              >
                <Checkbox
                  label="Send anonymized crash & error reports"
                  checked={errorReportingEnabled}
                  onChange={(e) => setErrorReportingEnabled(e.target.checked)}
                />
                <div className="mt-4">
                  <Checkbox
                    label="Send anonymized feature usage metrics"
                    checked={usageMetricsEnabled}
                    onChange={(e) => setUsageMetricsEnabled(e.target.checked)}
                  />
                </div>
                <p className="text-xs text-text-tertiary mt-3">
                  Changes take effect after restarting the app.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {/* Advanced Options */}
            <CollapsibleCard
              title="Advanced Options"
              subtitle="Technical settings for power users"
              icon={<Eye className="w-5 h-5" />}
              defaultExpanded={false}
              variant="subtle"
            >
              <SettingsSection
                title="Debugging"
                description="Enable detailed logging for troubleshooting"
                icon={<FileText className="w-4 h-4" />}
              >
                <Checkbox
                  label="Enable verbose logging"
                  checked={verbose}
                  onChange={(e) => setVerbose(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  Shows detailed logs for session creation and Claude Code execution. Useful for debugging issues.
                </p>
                
                <div className="mt-4">
                  <Checkbox
                    label="Enable dev mode"
                    checked={devMode}
                    onChange={(e) => setDevMode(e.target.checked)}
                  />
                  <p className="text-xs text-text-tertiary mt-1">
                    Adds a "Messages" tab to each session showing raw JSON responses from Claude Code. Useful for debugging and development.
                  </p>
                </div>

                {/* Dev-only: force the AskUserQuestion gate-failure path so the
                    durable recovery gate can be verified live. Hidden in the
                    stable DMG; only takes effect in dev (unpackaged) runs. */}
                {buildVariant !== 'stable' && (
                  <div className="mt-4">
                    <Checkbox
                      label="Force AskUserQuestion gate failure"
                      checked={forceAskUserQuestionGateFailure}
                      onChange={(e) => setForceAskUserQuestionGateFailure(e.target.checked)}
                    />
                    <p className="text-xs text-text-tertiary mt-1">
                      Testing only: fails the next AskUserQuestion gate on purpose and mints a durable
                      recovery card in the review queue — so the "Stream closed" recovery flow can be
                      exercised without waiting for a real drop. Only takes effect in dev (<code>pnpm dev</code>);
                      never fires in a packaged release.
                    </p>
                  </div>
                )}
              </SettingsSection>

              <SettingsSection
                title="Additional PATH Directories"
                description="Add custom directories to the PATH environment variable"
                icon={<FileText className="w-4 h-4" />}
              >
                <Textarea
                  label=""
                  value={additionalPathsText}
                  onChange={(e) => setAdditionalPathsText(e.target.value)}
                  placeholder="/opt/homebrew/bin\n/usr/local/bin\n~/bin\n~/.cargo/bin"
                  rows={4}
                  fullWidth
                  helperText="Enter one directory path per line. These will be added to PATH for all tools.\nUse forward slashes (/path). The tilde (~) expands to your home directory.\nNote: Changes require restarting Cyboflow to take full effect."
                />
              </SettingsSection>

              <SettingsSection
                title="Custom Claude Installation"
                description="Override the default Claude executable path"
                icon={<FileText className="w-4 h-4" />}
              >
                <div className="flex gap-2">
                  <input
                    id="claudeExecutablePath"
                    type="text"
                    value={claudeExecutablePath}
                    onChange={(e) => setClaudeExecutablePath(e.target.value)}
                    className="flex-1 px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary"
                    placeholder="/usr/local/bin/claude"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      const result = await API.dialog.openFile({
                        title: 'Select Claude Executable',
                        buttonLabel: 'Select',
                        properties: ['openFile'],
                        filters: [
                          { name: 'Executables', extensions: ['*'] }
                        ]
                      });
                      if (result.success && result.data) {
                        setClaudeExecutablePath(result.data);
                      }
                    }}
                  >
                    Browse
                  </Button>
                </div>
                <p className="text-xs text-text-tertiary mt-1">
                  Leave empty to use the 'claude' command from your system PATH.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {error && (
              <div className="text-status-error text-sm bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                {error}
              </div>
            )}
          </form>
        )}

        {activeTab === 'ai' && (
          <form id="settings-form" onSubmit={handleSubmit} className="space-y-6">
            {/* AI Integration */}
            <CollapsibleCard
              title="AI Integration"
              subtitle="Configure Claude integration and smart features"
              icon={<Zap className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Global Instructions"
                description="Add custom instructions that apply to all your projects"
                icon={<FileText className="w-4 h-4" />}
              >
                <Textarea
                  label="Global System Prompt"
                  value={globalSystemPrompt}
                  onChange={(e) => setGlobalSystemPrompt(e.target.value)}
                  placeholder="Always use TypeScript... Follow our team's coding standards..."
                  rows={3}
                  fullWidth
                  helperText="These instructions will be added to every Claude session across all projects."
                />
              </SettingsSection>

              <SettingsSection
                title="Cyboflow Attribution"
                description="Add Cyboflow branding to commit messages"
                icon={<FileText className="w-4 h-4" />}
              >
                <Checkbox
                  label="Include Cyboflow footer in commits"
                  checked={enableCyboflowFooter}
                  onChange={(e) => setEnableCyboflowFooter(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  When enabled, commits made through Cyboflow will include a footer crediting Cyboflow. This helps others know you're using Cyboflow for AI-powered development.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Agent Permission Mode"
                description="How workflow agents handle tool use that touches your files"
                icon={<ShieldCheck className="w-4 h-4" />}
              >
                <div className="flex flex-col gap-1.5">
                  {PERMISSION_MODE_OPTIONS.map(({ id, label, hint }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setDefaultAgentPermissionMode(id);
                        trackEvent('permission_mode_changed', { mode: id });
                      }}
                      aria-pressed={defaultAgentPermissionMode === id}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                        defaultAgentPermissionMode === id
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
                  Applies to workflow runs on both CLI substrates. "Auto" uses Claude's native permission classifier; "Don't ask" skips all permission prompts.
                </p>
              </SettingsSection>

              <SettingsSection
                title="CLI Runtime"
                description="How Cyboflow runs the Claude agent — the SDK or the live interactive terminal"
                icon={<Terminal className="w-4 h-4" />}
              >
                <div className="flex flex-col gap-1.5">
                  {([
                    { ptyOnly: false, label: 'Allow SDK', hint: 'Default · pick per run' },
                    { ptyOnly: true, label: 'Interactive PTY only', hint: 'Force the live terminal' },
                  ] as const).map(({ ptyOnly, label, hint }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setInteractivePtyOnly(ptyOnly);
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
                  "Interactive PTY only" forces every new run and quick session onto the live terminal
                  substrate and hides the per-run picker. Pause/Resume (SDK-only) become unavailable, and
                  the interactive substrate carries v1 limits. Only affects runs started after you save;
                  demo mode always uses the SDK.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Workflow Orchestration"
                description="Who walks a flow run's steps — the classic orchestrator or the programmatic host loop"
                icon={<Zap className="w-4 h-4" />}
              >
                <div className="flex flex-col gap-1.5">
                  {([
                    { model: 'programmatic', label: 'Programmatic', hint: 'Default · in-process host walks the DAG' },
                    { model: 'orchestrated', label: 'Orchestrated', hint: 'Classic orchestrator-driven steps' },
                  ] as const).map(({ model, label, hint }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setDefaultExecutionModel(model);
                        trackEvent('execution_model_default_changed', { executionModel: model });
                      }}
                      aria-pressed={defaultExecutionModel === model}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                        defaultExecutionModel === model
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
                  "Programmatic" hands new SDK flow runs to the in-process host loop, which walks the
                  run's steps deterministically instead of the classic orchestrator. Every programmatic
                  run always includes a chat supervisor you can query mid-run; escalations always go to
                  the human review queue and are also surfaced in chat. Only affects SDK runs started
                  after you save — the interactive terminal substrate always runs orchestrated.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Quick Sessions"
                description="Where a new quick session works — an isolated git worktree or your project checkout"
                icon={<FolderOpen className="w-4 h-4" />}
              >
                <div className="flex flex-col gap-1.5">
                  {([
                    { mode: 'worktree', label: 'Own worktree (default)', hint: 'Isolated git worktree' },
                    { mode: 'in-place', label: 'Project checkout (in place)', hint: 'Work directly in your checkout' },
                  ] as const).map(({ mode, label, hint }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setQuickSessionWorktreeMode(mode);
                        trackEvent('quick_worktree_mode_default_changed', { mode });
                      }}
                      aria-pressed={quickSessionWorktreeMode === mode}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                        quickSessionWorktreeMode === mode
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
                  "Project checkout (in place)" starts new quick sessions directly in your working copy —
                  no worktree, no isolation. It works with both the SDK and interactive terminal runtimes,
                  commit automation stays off, and a workflow launched from an in-place session opens in a
                  separate worktree-backed session. Only affects sessions created after you save; you can
                  override this per session in the launch wizard's Advanced options.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Quick Session Runtime"
                description="Which CLI substrate a new quick session starts on — the live terminal or the SDK"
                icon={<Terminal className="w-4 h-4" />}
              >
                <div className="flex flex-col gap-1.5">
                  {([
                    { substrate: 'interactive', label: 'Interactive terminal (default)', hint: 'Live PTY — full REPL' },
                    { substrate: 'sdk', label: 'SDK', hint: 'In-process Agent SDK' },
                  ] as const).map(({ substrate, label, hint }) => (
                    <button
                      key={substrate}
                      type="button"
                      onClick={() => {
                        setQuickSessionDefaultSubstrate(substrate);
                        trackEvent('quick_substrate_default_changed', { substrate });
                      }}
                      aria-pressed={quickSessionDefaultSubstrate === substrate}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                        quickSessionDefaultSubstrate === substrate
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
                  Sets which runtime a new quick session starts on. The interactive terminal is the default —
                  a full live REPL. This seeds the launch wizard's substrate picker; you can still switch it
                  per session. The global "Interactive PTY only" lock and demo mode override this. Workflow
                  runs use the separate default above and are unaffected.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Code Review Eval"
                description="Automatic LLM-jury quality assessment of a flow's diff at the review step"
                icon={<ShieldCheck className="w-4 h-4" />}
              >
                <div className="flex flex-col gap-1.5">
                  {([
                    { enabled: true, label: 'On', hint: 'Default · grade every built-in flow run' },
                    { enabled: false, label: 'Off', hint: 'Skip the jury pass — no eval cost' },
                  ] as const).map(({ enabled, label, hint }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setCodeReviewEvalEnabled(enabled)}
                      aria-pressed={codeReviewEvalEnabled === enabled}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                        codeReviewEvalEnabled === enabled
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
                  When a built-in flow (Sprint / Ship) reaches its human-review step, Cyboflow can run a
                  Three-slot jury pass (two Opus + one Codex) over the run's diff and file any findings into the review queue. Each
                  eval uses real model calls. Turn it off to skip it globally; a per-run "Quality
                  eval" override in the launch wizard's Advanced options can force it on or off for a single
                  run. Only affects runs started after you save.
                </p>

                <div className="mt-4 border-t border-border-secondary pt-4">
                  <Checkbox
                    label="Auto-grade variant & experiment runs"
                    checked={autoGradeVariantRuns}
                    onChange={(e) => setAutoGradeVariantRuns(e.target.checked)}
                  />
                  <p className="text-xs text-text-tertiary mt-1">
                    Extends the jury pass to workflow-variant runs (rotation) and side-by-side A/B
                    experiment arms — a per-arm rubric score plus, for experiments, a pairwise judge
                    verdict. Default on. Turning it off stops the extra judge cost from activating
                    variants or running an A/B test, without touching the global toggle above.
                  </p>
                </div>
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
                      onClick={() => setComputeCostFromRates(enabled)}
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
                  onChange={(e) => setArtifactCommitDir(e.target.value)}
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
                  onChange={(e) => setVisualVerifyEnabled(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1">
                  When enabled, workflow runs can request a visual check of a UI deliverable: Cyboflow
                  captures a screenshot (offscreen render, headless browser, or the live app) and a
                  vision model judges it against the stated intent. Off by default; no captures run
                  while disabled.
                </p>
              </SettingsSection>

              <SettingsSection
                title="Idle Session Review"
                description="Surface quiet PTY quick sessions in the human review queue"
                icon={<AlarmClock className="w-4 h-4" />}
              >
                <Checkbox
                  label="Surface idle quick sessions for review"
                  checked={idleReviewEnabled}
                  onChange={(e) => setIdleReviewEnabled(e.target.checked)}
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
                    setIdleReviewThresholdMinutes(e.target.value === '' ? '' : e.target.valueAsNumber)
                  }
                  className="w-28 px-3 py-2 border border-border-primary rounded-md focus:outline-none focus:ring-2 focus:ring-interactive text-text-primary bg-surface-secondary disabled:opacity-50"
                />
                <p className="text-xs text-text-tertiary mt-2">
                  How long a session may sit finished-and-unviewed before it's surfaced. Defaults to 5.
                </p>
              </SettingsSection>
            </CollapsibleCard>

            {error && (
              <div className="text-status-error text-sm bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                {error}
              </div>
            )}
          </form>
        )}

        {activeTab === 'assistant' && (
          <form id="settings-form" onSubmit={handleSubmit} className="space-y-6">
            <CollapsibleCard
              title="Assistant"
              subtitle="The cyboflow assistant in the rail"
              icon={<Bot className="w-5 h-5" />}
              defaultExpanded={true}
            >
              <SettingsSection
                title="Assistant"
                description="The cyboflow assistant in the rail. Unset uses the app default model."
                icon={<Bot className="w-4 h-4" />}
              >
                <Checkbox
                  label="Enable assistant"
                  checked={assistantEnabled}
                  onChange={(e) => setAssistantEnabled(e.target.checked)}
                />
                <p className="text-xs text-text-tertiary mt-1 mb-3">
                  When off, the assistant rail is hidden and uses no tokens.
                </p>
                <div className={!assistantEnabled ? 'opacity-50 pointer-events-none' : undefined}>
                  <ModelSelector
                    id="assistant-model"
                    label=""
                    value={assistantModel}
                    onChange={setAssistantModel}
                    allowDefaultOption={{ label: 'App default' }}
                  />
                </div>
              </SettingsSection>

              <SettingsSection
                title="Folder Access"
                description="Extra folders the assistant may read"
                icon={<FolderOpen className="w-4 h-4" />}
              >
                <div className={!assistantEnabled ? 'opacity-50 pointer-events-none' : undefined}>
                  <Textarea
                    label=""
                    value={assistantFolderPathsText}
                    onChange={(e) => setAssistantFolderPathsText(e.target.value)}
                    placeholder="/path/to/extra/folder"
                    rows={3}
                    fullWidth
                    helperText="Extra folders the assistant may read (one per line). Your project folders are always readable. Secret files (.env, keys) are always denied."
                  />
                </div>
              </SettingsSection>
            </CollapsibleCard>

            {error && (
              <div className="text-status-error text-sm bg-status-error/10 border border-status-error/30 rounded-lg p-4">
                {error}
              </div>
            )}
          </form>
        )}

        {activeTab === 'integrations' && (
          <IntegrationsSettings />
        )}

        {activeTab === 'notifications' && (
          <NotificationSettings
            settings={notificationSettings}
            onUpdateSettings={(updates) => {
              setNotificationSettings(prev => ({ ...prev, ...updates }));
            }}
          />
        )}

        {/* Updates apply immediately (channel persists on change; check/download/
            install are imperative), so this tab has no Save footer. */}
        {activeTab === 'updates' && <UpdateSettings />}
      </ModalBody>

      {/* Footer */}
      {(activeTab === 'general' || activeTab === 'ai' || activeTab === 'assistant' || activeTab === 'notifications') && (
        <ModalFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type={activeTab === 'general' || activeTab === 'ai' || activeTab === 'assistant' ? 'submit' : 'button'}
            form={activeTab === 'general' || activeTab === 'ai' || activeTab === 'assistant' ? 'settings-form' : undefined}
            onClick={activeTab === 'notifications' ? (e) => handleSubmit(e as React.FormEvent) : undefined}
            disabled={isSubmitting}
            loading={isSubmitting}
            variant="primary"
          >
            Save Changes
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
}
