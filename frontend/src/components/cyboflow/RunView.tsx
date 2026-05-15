/**
 * RunView — subscribes to the active run's stream-event feed and renders a
 * scrollable event log.  Shows a placeholder when no run is active.
 */
import { useEffect, useRef } from 'react';
import { cyboflowApi } from '../../utils/cyboflowApi';
import { useCyboflowStore } from '../../stores/cyboflowStore';

export function RunView() {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Subscribe to stream events whenever activeRunId changes.
  // tRPC migration note: replace with trpc.cyboflow.events.onStreamEvent({ runId })
  useEffect(() => {
    if (!activeRunId) return;

    const unsubscribe = cyboflowApi.subscribeToStreamEvents({
      runId: activeRunId,
      onEvent: (event) => {
        useCyboflowStore.getState().appendStreamEvent(event);
      },
    });

    return unsubscribe;
  }, [activeRunId]);

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
