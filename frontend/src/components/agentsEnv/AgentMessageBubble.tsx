import { useState } from 'react';
import { Info } from 'lucide-react';
import { deriveSendLabel, type ConnectionState } from '../../../../shared/types/persistentAgents';
import { GhostButton } from '../landing/QueuePrimitives';
import { formatClock, linkParts } from './agentsEnvFormat';
import type { ThreadMessage } from './types';

/**
 * One message in an agent thread.
 *
 * Everything an agent or the relay wrote (body, links, system notes) is UNTRUSTED: it is rendered as an
 * escaped React text child only. Never markdown, never HTML, never auto-linked; link domains are shown and
 * only http(s) links are clickable (and open in the OS browser, never in-app).
 */

const BODY_COLLAPSE_AT = 2000;

const TONE_CLASS = {
  neutral: 'text-text-tertiary',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
} as const;

/** Outbound receipt line: the truthful send state, never "read" or "seen". */
export function ReceiptLabel({
  message,
  connectionState,
  now,
}: {
  message: ThreadMessage;
  connectionState: ConnectionState | null;
  now: number;
}): React.JSX.Element | null {
  const r = deriveSendLabel(message, connectionState, new Date(now));
  if (r.label === '') return null;
  const at = r.at !== null ? formatClock(r.at, new Date(now)) : '';
  return (
    <span
      data-testid={`receipt-${message.id}`}
      title={message.lastError ?? undefined}
      className={TONE_CLASS[r.tone]}
    >
      {at !== '' ? `${r.label} ${at}` : r.label}
    </span>
  );
}

/** Links an agent attached. Shows the domain (punycode for IDN) next to a truncated URL. */
export function LinkList({ links }: { links: ReadonlyArray<{ url: string }> }): React.JSX.Element | null {
  if (links.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {links.map((link, i) => {
        const p = linkParts(link.url);
        return (
          <li key={`${i}:${link.url}`}>
            {p.href !== null ? (
              <button
                type="button"
                title={p.href}
                onClick={() => {
                  const href = p.href;
                  if (href !== null) void window.electronAPI?.openExternal(href);
                }}
                className="flex max-w-full items-baseline gap-2 text-left text-[12px] hover:underline"
              >
                <span className="shrink-0 font-bold text-text-primary">{p.domain}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-text-tertiary">{p.display}</span>
              </button>
            ) : (
              <span className="flex max-w-full items-baseline gap-2 text-[12px]">
                <span className="shrink-0 font-bold text-text-tertiary">{p.domain}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-text-tertiary">{p.display}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A note cyboflow or the Bridge wrote into the thread (swap note, expired-message note). Plain text. */
export function SystemNote({ message }: { message: ThreadMessage }): React.JSX.Element {
  return (
    <div
      data-testid={`message-${message.id}`}
      data-direction={message.direction}
      className="flex items-start justify-center gap-1.5 text-center text-[11px] text-text-tertiary"
    >
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 whitespace-pre-wrap break-words">{message.body}</span>
    </div>
  );
}

export function AgentMessageBubble({
  message,
  agentName,
  connectionState,
  now,
}: {
  message: ThreadMessage;
  agentName: string;
  connectionState: ConnectionState | null;
  now: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  if (message.kind === 'system' || message.direction === 'local') return <SystemNote message={message} />;

  const outbound = message.direction === 'out';
  const shown =
    message.body.length > BODY_COLLAPSE_AT && !expanded ? `${message.body.slice(0, BODY_COLLAPSE_AT)}…` : message.body;
  const links =
    message.delivery !== null && !message.links.some((l) => l.url === message.delivery?.prUrl)
      ? [...message.links, { url: message.delivery.prUrl, domain: message.delivery.prDomain }]
      : message.links;
  const eyebrow = outbound
    ? message.kind === 'brief'
      ? 'Brief'
      : null
    : message.kind === 'delivery_report'
      ? `${agentName} reported a pull request`
      : agentName;

  return (
    <div
      data-testid={`message-${message.id}`}
      data-direction={message.direction}
      className={`max-w-[75%] border border-border-primary px-3 py-2 ${
        outbound ? 'ml-auto bg-surface-secondary' : 'mr-auto bg-surface-primary'
      }`}
    >
      {eyebrow !== null && (
        <div className="mb-0.5 break-words text-[10px] font-bold uppercase tracking-wide text-text-tertiary">
          {eyebrow}
        </div>
      )}
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-primary">{shown}</p>
      {message.body.length > BODY_COLLAPSE_AT && (
        <GhostButton onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : `Show all (${message.body.length} characters)`}
        </GhostButton>
      )}
      {!outbound && <LinkList links={links} />}
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] text-text-tertiary">
        <span>{formatClock(message.createdAt, new Date(now))}</span>
        {outbound && (
          <>
            <span aria-hidden>·</span>
            <ReceiptLabel message={message} connectionState={connectionState} now={now} />
          </>
        )}
      </div>
    </div>
  );
}
