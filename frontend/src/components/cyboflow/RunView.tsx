/**
 * RunView — renders the active run's scrollable raw event log.  Shows a
 * placeholder when no run is active.
 *
 * History source: the persisted `raw_events` log via
 * `cyboflow.runs.listRawEvents`, re-queried on runId change AND (debounced)
 * whenever the live `cyboflowStore.streamEvents` buffer grows. This mirrors
 * RunChatView's strategy: the in-memory `streamEvents` buffer is wiped on every
 * `setActiveRun`, so rendering straight from it erased the stream when you
 * clicked away from a run and returned. Re-querying the durable log keeps the
 * full history on return while still reflecting live deltas (≤ debounce lag).
 * `streamEvents.length` is used only as a "new events arrived" change signal.
 *
 * Events are rendered via a typed switch dispatch over StreamEvent.type —
 * each of the five SDK discriminators (system / assistant / user / result /
 * stream_event) routes to a dedicated row component; unrecognized types fall
 * through to the 'unknown' branch with a collapsed payload debug view.
 */
import { useEffect, useRef, useState, useCallback, type ReactElement } from 'react';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { trpc } from '../../trpc/client';
import type { StreamEvent } from '../../utils/cyboflowApi';

/** Debounce window for live re-fetch after a streamEvents delta lands. */
const LIVE_REFETCH_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Row components — one per SDK discriminator
// ---------------------------------------------------------------------------

function SystemEventRow({ event }: { event: Extract<StreamEvent, { type: 'system' }> }): ReactElement {
  const payload = event.payload;

  if (payload.subtype === 'init') {
    const init = payload;
    return (
      <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs">
        <span className="font-semibold text-text-primary">system/init</span>
        <div className="mt-1 flex flex-wrap gap-3 text-text-secondary">
          <span><span className="text-text-primary">model:</span> {init.model}</span>
          <span><span className="text-text-primary">cwd:</span> {init.cwd}</span>
          <span><span className="text-text-primary">session:</span> {init.session_id.slice(0, 8)}…</span>
        </div>
      </div>
    );
  }

  if (payload.subtype === 'compact_boundary') {
    const cb = payload;
    return (
      <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">system/compact_boundary</span>
        {' '}trigger={cb.compact_metadata.trigger} pre-compaction tokens={cb.compact_metadata.pre_tokens}
      </div>
    );
  }

  if (payload.subtype === 'hook_started') {
    const hs = payload;
    return (
      <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">system/hook_started</span>
        {' '}<span className="text-text-primary">{hs.hook_name}</span>
        {' '}({hs.hook_event})
      </div>
    );
  }

  if (payload.subtype === 'hook_response') {
    const hr = payload;
    const outcomeColor = hr.outcome === 'success'
      ? 'text-status-success'
      : hr.outcome === 'error'
        ? 'text-status-error'
        : 'text-text-secondary';
    return (
      <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">system/hook_response</span>
        {' '}<span className="text-text-primary">{hr.hook_name}</span>
        {' '}outcome=<span className={outcomeColor}>{hr.outcome}</span>
        {hr.exit_code !== undefined ? ` exit=${hr.exit_code}` : ''}
      </div>
    );
  }

  if (payload.subtype === 'status') {
    const st = payload;
    return (
      <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">system/status</span>
        {' '}status={st.status ?? 'null'}
        {st.permissionMode ? ` mode=${st.permissionMode}` : ''}
        {st.compact_result ? ` compact=${st.compact_result}` : ''}
      </div>
    );
  }

  // Fallback for unknown system subtypes
  return (
    <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
      <span className="font-semibold text-text-primary">system/</span>
      {(payload as { subtype?: string }).subtype ?? '?'}
    </div>
  );
}

function AssistantEventRow({ event }: { event: Extract<StreamEvent, { type: 'assistant' }> }): ReactElement {
  const payload = event.payload;
  const content = payload.message?.content ?? [];

  return (
    <div className="mb-1 rounded border-l-2 border-interactive bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-text-primary">assistant</span>
      <div className="mt-1">
        {content.map((block, i) => {
          if (block.type === 'text') {
            return (
              <p key={i} className="text-text-primary whitespace-pre-wrap">{block.text}</p>
            );
          }
          if (block.type === 'tool_use') {
            return (
              <div key={i} className="mt-1 rounded border border-border-primary bg-bg-secondary p-1">
                <span className="font-semibold text-text-secondary">tool:</span>{' '}
                <span className="text-text-primary">{block.name}</span>
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-text-secondary">
                  {JSON.stringify(block.input, null, 2)}
                </pre>
              </div>
            );
          }
          if (block.type === 'thinking') {
            return (
              <details key={i} className="mt-1">
                <summary className="cursor-pointer text-text-secondary">thinking…</summary>
                <p className="text-text-secondary whitespace-pre-wrap">{block.thinking}</p>
              </details>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function UserEventRow({ event }: { event: Extract<StreamEvent, { type: 'user' }> }): ReactElement {
  const payload = event.payload;
  const content = payload.message?.content ?? [];

  return (
    <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-text-primary">user</span>
      <div className="mt-1">
        {content.map((block, i) => {
          const shortId = block.tool_use_id.slice(0, 8);
          const bodyText = typeof block.content === 'string'
            ? block.content
            : block.content.map((c) => c.text).join('');
          return (
            <div key={i} className="mt-1">
              {block.is_error && (
                <span className="mr-1 rounded bg-status-error px-1 text-white">error</span>
              )}
              <span className="font-mono text-text-secondary">{shortId}…</span>
              {' '}
              <span className="text-text-primary">{bodyText}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultEventRow({ event }: { event: Extract<StreamEvent, { type: 'result' }> }): ReactElement {
  const payload = event.payload;
  const costStr = payload.total_cost_usd !== undefined
    ? `$${payload.total_cost_usd.toFixed(4)}`
    : 'n/a';

  return (
    <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-text-primary">result</span>
      <div className="mt-1 flex flex-wrap gap-3 text-text-secondary">
        <span><span className="text-text-primary">subtype:</span> {payload.subtype}</span>
        <span><span className="text-text-primary">turns:</span> {payload.num_turns}</span>
        <span><span className="text-text-primary">duration:</span> {payload.duration_ms}ms</span>
        <span><span className="text-text-primary">cost:</span> {costStr}</span>
      </div>
    </div>
  );
}

function StreamEventRow({ event }: { event: Extract<StreamEvent, { type: 'stream_event' }> }): ReactElement {
  const payload = event.payload;
  const inner = payload.event;
  const deltaText =
    inner.delta?.type === 'text_delta' && inner.delta.text
      ? ` "${inner.delta.text.slice(0, 60)}${inner.delta.text.length > 60 ? '…' : ''}"`
      : '';

  return (
    <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
      <span className="font-semibold text-text-primary">stream_event</span>
      {' '}{inner.type}
      {inner.index !== undefined ? ` idx=${inner.index}` : ''}
      {deltaText}
    </div>
  );
}

function SessionInfoEventRow({ event }: { event: Extract<StreamEvent, { type: 'session_info' }> }): ReactElement {
  const payload = event.payload;
  const truncatedPrompt = payload.initial_prompt.length > 120
    ? `${payload.initial_prompt.slice(0, 120)}…`
    : payload.initial_prompt;

  return (
    <div className="mb-1 rounded border-l-4 border-status-success bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-status-success">Run started</span>
      <div className="mt-1 flex flex-wrap gap-3 text-text-secondary">
        <span><span className="text-text-primary">worktree:</span> {payload.worktree_path}</span>
        <span><span className="text-text-primary">model:</span> {payload.model}</span>
        <span><span className="text-text-primary">mode:</span> {payload.permission_mode}</span>
      </div>
      {truncatedPrompt && (
        <p className="mt-1 text-text-secondary italic">{truncatedPrompt}</p>
      )}
    </div>
  );
}

function RateLimitEventRow({ event }: { event: Extract<StreamEvent, { type: 'rate_limit_event' }> }): ReactElement {
  const payload = event.payload;
  const info = payload.rate_limit_info;
  const resetsAtStr = info.resetsAt !== undefined
    ? new Date(info.resetsAt * 1000).toLocaleTimeString()
    : 'n/a';

  return (
    <div className="mb-1 rounded border border-status-warning bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-status-warning">rate_limit_event</span>
      <div className="mt-1 flex flex-wrap gap-3 text-text-secondary">
        <span><span className="text-text-primary">status:</span> {info.status}</span>
        <span><span className="text-text-primary">resets:</span> {resetsAtStr}</span>
        {info.overageStatus && (
          <span><span className="text-text-primary">overage:</span> {info.overageStatus}</span>
        )}
      </div>
    </div>
  );
}

function RunStartedEventRow({ event }: { event: Extract<StreamEvent, { type: 'run_started' }> }): ReactElement {
  const payload = event.payload;
  return (
    <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
      <span className="font-semibold text-text-primary">Starting</span>
      {' '}run{' '}
      <span className="font-mono">{payload.runId.slice(0, 8)}…</span>
      {' '}on branch{' '}
      <span className="font-mono">{payload.branchName}</span>
    </div>
  );
}

function UnknownEventRow({ event }: { event: Extract<StreamEvent, { type: 'unknown' }> }): ReactElement {
  const rawPayload = event.payload;
  return (
    <div className="mb-1 rounded border border-status-warning bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-status-warning">Unrecognized event</span>
      {' '}
      <span className="font-mono text-text-secondary">{event.type}</span>
      <details className="mt-1">
        <summary className="cursor-pointer text-text-secondary">Show payload</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-text-secondary">
          {JSON.stringify(rawPayload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatch helper
// ---------------------------------------------------------------------------

function renderEvent(event: StreamEvent): ReactElement {
  switch (event.type) {
    case 'system':           return <SystemEventRow event={event} />;
    case 'assistant':        return <AssistantEventRow event={event} />;
    case 'user':             return <UserEventRow event={event} />;
    case 'result':           return <ResultEventRow event={event} />;
    case 'stream_event':     return <StreamEventRow event={event} />;
    case 'session_info':     return <SessionInfoEventRow event={event} />;
    case 'rate_limit_event': return <RateLimitEventRow event={event} />;
    case 'run_started':      return <RunStartedEventRow event={event} />;
    case 'unknown':          return <UnknownEventRow event={event} />;
  }
}

// ---------------------------------------------------------------------------
// RunView
// ---------------------------------------------------------------------------

export function RunView() {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  // Live buffer is used ONLY as a change signal — actual rows come from the
  // durable re-query so history survives clicking away and returning.
  const streamEventCount = useCyboflowStore((s) => s.streamEvents.length);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Re-query the durable raw_events log. Result type is INFERRED from AppRouter
  // (StreamEnvelope[]); we attach runId to match the renderer's StreamEvent.
  const loadEvents = useCallback(async (runId: string): Promise<void> => {
    try {
      const result = await trpc.cyboflow.runs.listRawEvents.query({ runId });
      setEvents(result.map((envelope) => ({ ...envelope, runId })));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial / runId-change load.
  useEffect(() => {
    if (!activeRunId) {
      setEvents([]);
      setIsLoading(false);
      return;
    }
    let aborted = false;
    setIsLoading(true);
    setEvents([]);
    void (async () => {
      try {
        const result = await trpc.cyboflow.runs.listRawEvents.query({ runId: activeRunId });
        if (aborted) return;
        setEvents(result.map((envelope) => ({ ...envelope, runId: activeRunId })));
      } finally {
        if (!aborted) setIsLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [activeRunId]);

  // Live re-fetch — debounced re-query whenever this run's streamEvents grow.
  useEffect(() => {
    if (!activeRunId) return;
    if (streamEventCount === 0) return;
    const timer = setTimeout(() => {
      void loadEvents(activeRunId);
    }, LIVE_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [activeRunId, streamEventCount, loadEvents]);

  // Auto-scroll to the bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

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
        {events.length === 0 ? (
          <p className="text-xs text-text-secondary">
            {isLoading ? 'Loading events…' : 'Waiting for events…'}
          </p>
        ) : (
          events.map((event, idx) => (
            <div key={idx}>{renderEvent(event)}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
