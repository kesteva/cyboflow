/**
 * RunView — renders the active run's scrollable event log.  Shows a
 * placeholder when no run is active.
 *
 * Stream-event subscription is managed by the cyboflowStore (module-level
 * singleton started in setActiveRun / torn down in clearActiveRun).  This
 * component is subscription-free and re-renders only when the store state
 * changes.  The previous useEffect-based subscription was vulnerable to
 * React Strict Mode's double-invoke tearing down the listener mid-run
 * (TASK-667: confirmed H2).
 *
 * TODO(epic-7-trpc-cutover): migrate to trpc.cyboflow.events.onStreamEvent({ runId })
 */
import { useEffect, useRef } from 'react';
import { useCyboflowStore } from '../../stores/cyboflowStore';

export function RunView() {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamEvents.length]);

  if (!activeRunId) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary text-sm">
        No active run
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Run</h2>
        <span className="font-mono text-xs text-text-secondary">{activeRunId}</span>
      </div>

      <div className="flex-1 overflow-auto rounded border border-border-primary bg-bg-secondary p-2">
        {streamEvents.length === 0 ? (
          <p className="text-xs text-text-secondary">Waiting for events…</p>
        ) : (
          streamEvents.map((event, idx) => (
            <pre
              key={idx}
              className="mb-1 whitespace-pre-wrap break-all font-mono text-xs text-text-primary"
            >
              {JSON.stringify(event, null, 2)}
            </pre>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
