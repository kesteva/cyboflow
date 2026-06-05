import { useState, useEffect } from 'react';
import { NotificationSettings } from './NotificationSettings';
import { useNotifications } from '../hooks/useNotifications';
import { API } from '../utils/api';
import type { AppConfig } from '../types/config';
import type { PermissionMode } from '../../../shared/types/workflows';
import { useConfigStore } from '../stores/configStore';
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  Palette,
  Zap,
  FileText,
  Eye,
  ShieldCheck
} from 'lucide-react';
import { Textarea, Checkbox } from './ui/Input';
import { Button } from './ui/Button';
import { useTheme } from '../contexts/ThemeContext';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { CollapsibleCard } from './ui/CollapsibleCard';
import { SettingsSection } from './ui/SettingsSection';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Settings({ isOpen, onClose }: SettingsProps) {
  const [_config, setConfig] = useState<AppConfig | null>(null);
  const [verbose, setVerbose] = useState(false);
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState('');
  const [claudeExecutablePath, setClaudeExecutablePath] = useState('');
  const [devMode, setDevMode] = useState(false);
  const [additionalPathsText, setAdditionalPathsText] = useState('');
  const [enableCyboflowFooter, setEnableCyboflowFooter] = useState(true);
  const [defaultAgentPermissionMode, setDefaultAgentPermissionMode] = useState<PermissionMode>('default');
  const [notificationSettings, setNotificationSettings] = useState({
    enabled: true,
    playSound: true,
    notifyOnStatusChange: true,
    notifyOnWaiting: true,
    notifyOnComplete: true
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'notifications'>('general');
  const { updateSettings } = useNotifications();
  const { theme, setTheme } = useTheme();
  const { fetchConfig: refreshConfigStore } = useConfigStore();

  useEffect(() => {
    if (isOpen) {
      fetchConfig();
    }
  }, [isOpen]);

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
      setEnableCyboflowFooter(data.enableCyboflowFooter !== false); // Default to true
      setDefaultAgentPermissionMode(data.defaultAgentPermissionMode ?? 'default');
      
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
      
      const response = await API.config.update({
        verbose,
        systemPromptAppend: globalSystemPrompt,
        claudeExecutablePath,
        devMode,
        enableCyboflowFooter,
        defaultAgentPermissionMode,
        additionalPaths: parsedPaths,
        notifications: notificationSettings
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to update configuration');
      }

      // Update the useNotifications hook with new settings
      updateSettings(notificationSettings);

      // Refresh config from server
      await fetchConfig();

      // Also refresh the global config store
      await refreshConfigStore();

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
            onClick={() => setActiveTab('notifications')}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'notifications'
                ? 'text-interactive border-b-2 border-interactive bg-interactive/5'
                : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Notifications
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
                      onClick={() => setTheme(id)}
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
                  {([
                    { id: 'default', label: 'Ask before edits', hint: 'Prompt for each edit' },
                    { id: 'acceptEdits', label: 'Allow edits', hint: 'Auto-allow file edits' },
                    { id: 'auto', label: 'Auto', hint: 'Native Claude classifier' },
                    { id: 'dontAsk', label: "Don't ask", hint: 'No prompts · skip permissions' },
                  ] as const).map(({ id, label, hint }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setDefaultAgentPermissionMode(id)}
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
        
        {activeTab === 'notifications' && (
          <NotificationSettings
            settings={notificationSettings}
            onUpdateSettings={(updates) => {
              setNotificationSettings(prev => ({ ...prev, ...updates }));
            }}
          />
        )}
      </ModalBody>

      {/* Footer */}
      {(activeTab === 'general' || activeTab === 'notifications') && (
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
            type={activeTab === 'general' ? 'submit' : 'button'}
            form={activeTab === 'general' ? 'settings-form' : undefined}
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