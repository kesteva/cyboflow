/**
 * WorkflowPicker — dropdown of the SoloFlow workflows + Start Run button.
 *
 * Accepts a `projectId` prop; on mount it calls `trpc.cyboflow.workflows.list`
 * and populates a `<select>`.  Clicking "Start Run" calls
 * `trpc.cyboflow.runs.start.mutate` and stores the returned runId in
 * `cyboflowStore`.
 *
 * Also provides a "Quick Session" button that creates a quick session via
 * `sessions:create-quick` IPC, bootstraps both Claude and Terminal panels via
 * `panelApi.createPanel`, and navigates via `setActiveQuickSession`.
 */
import { useState, useEffect } from 'react';
import { trpc } from '../../trpc/client';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useQuickSession } from '../../hooks/useQuickSession';
import type { WorkflowRow } from '../../../../shared/types/workflows';

interface WorkflowPickerProps {
  projectId: number;
  onWorkflowStarted?: (runId: string) => void;
}

export function WorkflowPicker({ projectId, onWorkflowStarted }: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    start: startQuickSession,
    isStarting: isQuickStarting,
    error: quickError,
  } = useQuickSession({
    projectId,
    onSuccess: (sessionId) => {
      onWorkflowStarted?.(sessionId);
    },
  });

  // Load workflows on mount (or when projectId changes)
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    trpc.cyboflow.workflows.list
      .query({ projectId })
      .then((rows) => {
        if (cancelled) return;
        setWorkflows(rows);
        if (rows.length > 0 && selectedId === null) {
          setSelectedId(rows[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load workflows');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // selectedId intentionally excluded — only re-fetch when projectId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleStartRun = async () => {
    if (selectedId === null || isStarting) return;
    setError(null);
    setIsStarting(true);
    try {
      const result = await trpc.cyboflow.runs.start.mutate({ workflowId: selectedId, projectId });
      useCyboflowStore.getState().setActiveRun(result.runId);
      onWorkflowStarted?.(result.runId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start run');
    } finally {
      setIsStarting(false);
    }
  };

  const combinedError = error ?? quickError;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Workflow</h2>

      {isLoading && (
        <p className="text-xs text-text-secondary">Loading workflows…</p>
      )}

      {!isLoading && workflows.length > 0 && (
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full rounded border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
          aria-label="Select workflow"
        >
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name}
            </option>
          ))}
        </select>
      )}

      {combinedError && (
        <p className="text-xs text-red-500" role="alert">
          {combinedError}
        </p>
      )}

      <button
        onClick={handleStartRun}
        disabled={selectedId === null || isLoading || isStarting || isQuickStarting}
        className="rounded bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        Start Run
      </button>

      <div className="mt-2 flex flex-col gap-2 border-t border-border-primary pt-3">
        <p className="text-xs text-text-secondary">Or start without a workflow:</p>
        <button
          onClick={() => void startQuickSession()}
          disabled={isQuickStarting || isStarting}
          className="rounded border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="quick-session-button"
        >
          Quick Session
        </button>
      </div>
    </div>
  );
}
