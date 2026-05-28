import { useState, useCallback, useEffect } from 'react';
import { ExternalLink, Copy, Check } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { API } from '../../utils/api';
import { useErrorStore } from '../../stores/errorStore';

interface SessionCreatePrDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
  onSuccess?: () => void;
}

function parseGitHubCompareUrl(remoteUrl: string, branchName: string): string | null {
  // HTTPS: https://github.com/{owner}/{repo}.git or https://github.com/{owner}/{repo}
  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}/compare/${encodeURIComponent(branchName)}?expand=1`;
  }

  // SSH: git@github.com:{owner}/{repo}.git or git@github.com:{owner}/{repo}
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}/compare/${encodeURIComponent(branchName)}?expand=1`;
  }

  return null;
}

type Step = 'confirm' | 'pushing' | 'fallback';

export function SessionCreatePrDialog({ isOpen, onClose, sessionId, sessionName, onSuccess }: SessionCreatePrDialogProps) {
  const [step, setStep] = useState<Step>('confirm');
  const [fallbackBranch, setFallbackBranch] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep('confirm');
      setFallbackBranch(null);
      setCopied(false);
    }
  }, [isOpen]);

  const handleConfirm = useCallback(async () => {
    setStep('pushing');

    try {
      const pushResult = await API.sessions.gitPush(sessionId);
      if (!pushResult.success) {
        useErrorStore.getState().showError({
          title: 'Push failed',
          error: pushResult.error ?? 'Failed to push branch to remote.',
          details: pushResult.details,
        });
        setStep('confirm');
        return;
      }

      const remoteResult = await API.sessions.getRemoteUrl(sessionId);
      if (!remoteResult.success || !remoteResult.data) {
        useErrorStore.getState().showError({
          title: 'Could not get remote URL',
          error: remoteResult.error ?? 'Failed to determine remote URL after push.',
        });
        setStep('confirm');
        return;
      }

      const { remoteUrl, branchName } = remoteResult.data;
      const compareUrl = parseGitHubCompareUrl(remoteUrl, branchName);

      if (compareUrl) {
        await window.electronAPI.openExternal(compareUrl);
        await API.sessions.delete(sessionId);
        onSuccess?.();
        onClose();
      } else {
        setFallbackBranch(branchName);
        setStep('fallback');
      }
    } catch (err) {
      useErrorStore.getState().showError({
        title: 'Create PR failed',
        error: err instanceof Error ? err.message : String(err),
      });
      setStep('confirm');
    }
  }, [sessionId, onSuccess, onClose]);

  const handleFallbackDone = useCallback(async () => {
    try {
      await API.sessions.delete(sessionId);
    } catch { /* best-effort cleanup */ }
    onSuccess?.();
    onClose();
  }, [sessionId, onSuccess, onClose]);

  const handleCopyBranch = useCallback(async () => {
    if (!fallbackBranch) return;
    await navigator.clipboard.writeText(fallbackBranch);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [fallbackBranch]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-text-primary mb-2">Create pull request</h2>
        <p className="text-sm text-text-secondary mb-4">
          Push <span className="font-mono text-text-primary">{sessionName}</span> and open GitHub to create a PR.
        </p>

        {step === 'confirm' && (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void handleConfirm()}>
              <ExternalLink size={14} className="mr-1.5" />
              Push &amp; open GitHub
            </Button>
          </div>
        )}

        {step === 'pushing' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-interactive border-t-transparent" />
            Pushing branch...
          </div>
        )}

        {step === 'fallback' && fallbackBranch && (
          <div>
            <p className="text-sm text-text-secondary mb-3">
              Branch pushed but the remote is not a recognized GitHub URL.
              Create a PR manually using this branch:
            </p>
            <div className="flex items-center gap-2 rounded bg-bg-tertiary px-3 py-2 mb-4">
              <code className="flex-1 text-sm font-mono text-text-primary">{fallbackBranch}</code>
              <button
                onClick={() => void handleCopyBranch()}
                className="text-text-secondary hover:text-text-primary"
                title="Copy branch name"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void handleFallbackDone()}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
