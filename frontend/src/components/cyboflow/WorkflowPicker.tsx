/**
 * WorkflowPicker — dropdown of the 5 SoloFlow workflows + Start Run button.
 *
 * Accepts a `projectId` prop; on mount it calls `cyboflowApi.listWorkflows`
 * and populates a `<select>`.  Clicking "Start Run" calls
 * `cyboflowApi.startRun` and stores the returned runId in `cyboflowStore`.
 */
import { useState, useEffect } from 'react';
import { cyboflowApi } from '../../utils/cyboflowApi';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import type { WorkflowRow } from '../../../../shared/types/workflows';

interface WorkflowPickerProps {
  projectId: number;
}

export function WorkflowPicker({ projectId }: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load workflows on mount (or when projectId changes)
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    cyboflowApi
      .listWorkflows({ projectId })
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
    if (selectedId === null) return;
    setError(null);
    try {
      const result = await cyboflowApi.startRun({ workflowId: selectedId, projectId });
      useCyboflowStore.getState().setActiveRun(result.runId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start run');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Workflow</h2>

      {isLoading && (
        <p className="text-xs text-text-secondary">Loading workflows…</p>
      )}

      {!isLoading && workflows.length > 0 && (
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(Number(e.target.value))}
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

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      <button
        onClick={handleStartRun}
        disabled={selectedId === null || isLoading}
        className="rounded bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        Start Run
      </button>
    </div>
  );
}
