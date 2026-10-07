import { useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import type { BridgeTransport, PersistentAgentVendor, VerifyFact } from '../../../../shared/types/persistentAgents';
import { useNow } from '../../hooks/useNow';
import { CopyButton } from './CopyButton';
import { formatClock, formatCountdown, pairingRemainingMs } from './agentsEnvFormat';
import { VENDOR_META } from './agentsVocabulary';
import type { AgentViewT, ConnectionViewT, PairingPayloadT } from './types';

export interface BridgePairingCardProps {
  /** Live from the store (pairedClient, verify facts, state). */
  agent: AgentViewT | null;
  connectionId: string;
  vendor: PersistentAgentVendor;
  transport: BridgeTransport;
  mode: 'connect' | 'reconnect';
  /** null in resume mode until "Get a pairing code". */
  pairing: PairingPayloadT | null;
  busy: 'repair' | 'verify' | 'cancel' | null;
  error: { code: string; message: string } | null;
  onNewCode: () => void;
  onSendTestMessage: () => void;
  onCancelReconnect: () => void;
}

/** The connection this card is about: matched by id, else by mode (pending switch vs current). */
function pickConnection(agent: AgentViewT | null, connectionId: string, mode: 'connect' | 'reconnect'): ConnectionViewT | null {
  if (agent === null) return null;
  const candidates = [agent.pendingSwitch?.connection ?? null, agent.connection];
  const byId = candidates.find((c) => c !== null && c.id === connectionId);
  if (byId) return byId;
  return mode === 'reconnect' ? (agent.pendingSwitch?.connection ?? agent.connection) : agent.connection;
}

function FactIcon({ status, spin }: { status: VerifyFact['status']; spin: boolean }): React.JSX.Element {
  if (status === 'done') return <Check className="h-3.5 w-3.5 shrink-0 text-status-success" aria-hidden />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden />;
  if (spin) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-tertiary" aria-hidden />;
  return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-full border border-text-tertiary" />;
}

export function BridgePairingCard(props: BridgePairingCardProps): React.JSX.Element {
  const { agent, connectionId, vendor, transport, mode, pairing, busy, error } = props;
  const connection = pickConnection(agent, connectionId, mode);
  const verified = connection?.state === 'verified';
  const paired = connection?.pairedClient ?? null;
  const facts = connection?.verifyFacts ?? [];
  const mcp = transport === 'relay-mcp';
  const code = pairing?.pairingCode ?? null;
  const countdownActive = mcp && paired === null && code !== null && pairing?.pairingExpiresAt != null;
  const now = useNow(1000, countdownActive);
  const remaining =
    countdownActive && pairing?.pairingExpiresAt != null ? pairingRemainingMs(pairing.pairingExpiresAt, now) : 0;
  const [confirmToken, setConfirmToken] = useState(false);
  const url = pairing?.mcpUrl ?? connection?.endpoints?.mcpUrl ?? null;
  const brief = pairing?.instructionBrief ?? null;

  const factDone = (key: string): boolean => facts.find((f) => f.key === key)?.status === 'done';
  const testMessageReady = mcp ? paired !== null : factDone('first-call');
  const firstWaiting = facts.findIndex((f) => f.status === 'waiting');
  const meta = VENDOR_META[vendor];

  return (
    <div data-testid="bridge-pairing-card" className="flex flex-col gap-3 text-[12px] text-text-primary">
      {mcp ? (
        <>
          <p>
            {vendor === 'openai-dots'
              ? 'In ChatGPT, add a custom connector (Developer mode) and paste this URL. When ChatGPT asks you to sign in, enter the pairing code and approve.'
              : 'Add this URL to your agent as a remote MCP server. When it asks you to authorize, enter the pairing code and approve.'}
          </p>
          {url !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-tertiary">Connector URL</span>
              <code data-testid="pairing-mcp-url" className="break-all font-mono text-[12px]">
                {url}
              </code>
              <CopyButton text={url} testId="pairing-copy-url" />
            </div>
          )}
          {paired === null &&
            (pairing === null || code === null ? (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="pairing-new-code"
                  loading={busy === 'repair'}
                  onClick={props.onNewCode}
                >
                  Get a pairing code
                </Button>
              </div>
            ) : remaining > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  data-testid="pairing-code"
                  className="font-mono text-lg font-bold tracking-wide text-text-primary"
                >
                  {code}
                </span>
                <CopyButton text={code} testId="pairing-copy-code" />
                <span data-testid="pairing-countdown" aria-live="off" className="text-[11px] text-text-tertiary">
                  {`Expires in ${formatCountdown(remaining)}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="pairing-new-code"
                  loading={busy === 'repair'}
                  onClick={props.onNewCode}
                >
                  New code
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="pairing-code" className="font-mono text-lg font-bold tracking-wide text-text-tertiary line-through">
                  {code}
                </span>
                <span role="status" className="text-[11px] text-text-tertiary">
                  This code expired.
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="pairing-new-code"
                  loading={busy === 'repair'}
                  onClick={props.onNewCode}
                >
                  New code
                </Button>
              </div>
            ))}
        </>
      ) : (
        <>
          <p>{`Paste these instructions into ${meta.appName === "the agent's app" ? 'your agent' : meta.appName}'s saved instructions (or wherever your agent keeps standing orders).`}</p>
          {brief !== null ? (
            <>
              <pre
                data-testid="pairing-http-instructions"
                className="max-h-56 overflow-auto whitespace-pre-wrap break-words border border-border-primary bg-surface-secondary p-3 font-mono text-[11px] text-text-primary"
              >
                {brief}
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton text={brief} label="Copy instructions" testId="pairing-copy-instructions" />
              </div>
              <p className="text-[11px] text-status-warning">
                The token is shown only now. If you lose it, issue a new one — the old one stops working.
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-secondary">The token was shown when you created this connection.</span>
              <Button
                variant="secondary"
                size="sm"
                data-testid="pairing-new-token"
                loading={busy === 'repair'}
                onClick={() => setConfirmToken(true)}
              >
                Issue a new token
              </Button>
            </div>
          )}
        </>
      )}

      {facts.length > 0 && (
        <ol data-testid="pairing-checklist" className="flex flex-col gap-1.5">
          {facts.map((f, i) => (
            <li key={f.key} data-testid={`pairing-fact-${f.key}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <FactIcon status={f.status} spin={i === firstWaiting} />
              <span>
                {f.label}
                {f.subject !== undefined && (
                  <>
                    {' “'}
                    <bdi data-testid="pairing-paired-client-name">{f.subject.name ?? 'an unnamed client'}</bdi>
                    {'” (name reported by the client) · '}
                    <span data-testid="pairing-paired-client-host">{f.subject.host}</span>
                  </>
                )}
              </span>
              {f.at !== null && <span className="text-[10px] text-text-tertiary">{formatClock(f.at)}</span>}
              {f.key === 'round-trip' && f.status === 'waiting' && testMessageReady && (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="pairing-send-test"
                  loading={busy === 'verify'}
                  onClick={props.onSendTestMessage}
                >
                  Send a test message
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}

      {verified && (
        <p role="status" className="text-status-success">
          Connected. Messages, links and pull request reports will show up in its thread.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="text-status-error">
          {error.message}
        </p>
      )}

      {mode === 'reconnect' && agent?.pendingSwitch != null && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="pairing-cancel-switch"
            loading={busy === 'cancel'}
            onClick={props.onCancelReconnect}
          >
            Cancel reconnect
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmToken}
        onClose={() => setConfirmToken(false)}
        onConfirm={props.onNewCode}
        title="Issue a new token?"
        message="The current token stops working immediately. Paste the new instructions into your agent afterwards."
        confirmText="Issue new token"
      />
    </div>
  );
}
