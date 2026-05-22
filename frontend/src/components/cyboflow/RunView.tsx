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
 * Events are rendered via a typed switch dispatch over StreamEvent.type —
 * each of the five SDK discriminators (system / assistant / user / result /
 * stream_event) routes to a dedicated row component; unrecognized types fall
 * through to the 'unknown' branch with a collapsed payload debug view.
 *
 * TODO(epic-7-trpc-cutover): migrate to trpc.cyboflow.events.onStreamEvent({ runId })
 */
import { useEffect, useRef, type ReactElement } from 'react';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import type { StreamEvent } from '../../utils/cyboflowApi';

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
      ? 'text-green-500'
      : hr.outcome === 'error'
        ? 'text-red-500'
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
    <div className="mb-1 rounded border-l-2 border-pink-400 bg-bg-secondary p-2 text-xs">
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
                <span className="mr-1 rounded bg-red-600 px-1 text-white">error</span>
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
    <div className="mb-1 rounded border-l-4 border-emerald-500 bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-emerald-500">Run started</span>
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
    <div className="mb-1 rounded border border-yellow-500 bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-yellow-500">rate_limit_event</span>
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
    <div className="mb-1 rounded border border-amber-500 bg-bg-secondary p-2 text-xs">
      <span className="font-semibold text-amber-500">Unrecognized event</span>
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
            <div key={idx}>{renderEvent(event)}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
