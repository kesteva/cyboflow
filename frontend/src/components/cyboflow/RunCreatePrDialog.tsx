import { useState, useCallback, useEffect } from 'react';
import { ExternalLink, Copy, Check } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';

interface RunCreatePrDialogProps {
  isOpen: boolean;
  onClose: () => void;
  runId: string;
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

/**
 * Run-scoped twin of SessionCreatePrDialog (GAP-B un-defer). Pushes the workflow
 * run's branch to origin via `cyboflow.runs.createPr` (which also marks the run
 * completed server-side) and opens the GitHub compare URL. Falls back to showing
 * the branch name when the remote is not a recognized GitHub URL.
 */
export function RunCreatePrDialog({ isOpen, onClose, runId, onSuccess }: RunCreatePrDialogProps) {
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
      const { remoteUrl, branchName } = await trpc.cyboflow.runs.createPr.mutate({ runId });
      const compareUrl = parseGitHubCompareUrl(remoteUrl, branchName);

      if (compareUrl) {
        await window.electronAPI.openExternal(compareUrl);
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
  }, [runId, onSuccess, onClose]);

  const handleFallbackDone = useCallback(() => {
    onSuccess?.();
    onClose();
  }, [onSuccess, onClose]);

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
          Push this run&apos;s branch and open GitHub to create a PR.
        </p>

        {step === 'confirm' && (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button data-testid="run-create-pr-confirm" onClick={() => void handleConfirm()}>
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
              <Button onClick={handleFallbackDone}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
