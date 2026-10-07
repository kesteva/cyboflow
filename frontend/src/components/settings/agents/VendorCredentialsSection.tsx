/**
 * Settings → Integrations: vendor API keys cyboflow stores for agents that connect through a vendor API.
 * Renders nothing (and makes no tRPC call) unless Agents & Environments is running. Fingerprints only; the
 * secret is never shown again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { Chip } from '../../landing/QueuePrimitives';
import { trpc } from '../../../trpc/client';
import { errorText } from '../../../utils/errorText';
import { openResilientSubscription } from '../../../stores/agentThreadStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';
import { failureCopy } from '../../agentsEnv/agentsVocabulary';
import type { AgentsChangedEvent, CredentialViewT } from '../../agentsEnv/types';
import { RotateCredentialDialog } from './RotateCredentialDialog';

const VENDOR_LABEL: Record<CredentialViewT['vendor'], string> = {
  anthropic: 'Anthropic API key',
  'github-pat': 'GitHub token',
};

function usedBy(c: CredentialViewT): string {
  const names = [...new Set(c.referencedBy.map((r) => r.displayName))];
  return names.length > 0 ? `Used by ${names.join(', ')}` : 'Not used by any agent';
}

export function VendorCredentialsSection(): React.JSX.Element | null {
  const running = usePersistentAgentsStore((s) => s.featureStatus?.running === true);
  const [credentials, setCredentials] = useState<CredentialViewT[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotating, setRotating] = useState<CredentialViewT | null>(null);
  const [forgetting, setForgetting] = useState<CredentialViewT | null>(null);
  const [forceForget, setForceForget] = useState<{ credential: CredentialViewT; names: string } | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);

  const refetch = useCallback(async (): Promise<void> => {
    const mySeq = ++seq.current;
    try {
      const list = await trpc.cyboflow.persistentAgents.listCredentials.query();
      if (!mounted.current || mySeq !== seq.current) return;
      setCredentials(list);
      setError(null);
    } catch (e) {
      if (!mounted.current || mySeq !== seq.current) return;
      setError(errorText(e) ?? 'Could not load API keys.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const sub = openResilientSubscription<AgentsChangedEvent>(
      'persistentAgents.onAgentsChanged:credentials',
      (h) => {
        const s = trpc.cyboflow.persistentAgents.onAgentsChanged.subscribe(undefined, h);
        void refetch();
        return s;
      },
      { onData: () => void refetch() },
    );
    return () => sub.close();
  }, [running, refetch]);

  const forget = async (c: CredentialViewT, detach: boolean): Promise<void> => {
    try {
      const res = await trpc.cyboflow.persistentAgents.forgetCredential.mutate(detach ? { id: c.id, detach: true } : { id: c.id });
      if (res.ok) {
        void refetch();
        return;
      }
      if (res.error === 'in_use') {
        const names = [...new Set((res.referencedBy ?? c.referencedBy).map((r) => r.displayName))].join(', ');
        setForceForget({ credential: c, names });
        return;
      }
      setError(res.error === 'not_found' ? 'This key no longer exists.' : failureCopy(res).copy);
      if (res.error === 'not_found') void refetch();
    } catch (e) {
      setError(errorText(e) ?? 'Something went wrong. Try again.');
    }
  };

  if (!running) return null;

  return (
    <div data-testid="vendor-credentials-section">
      <SettingsSection
        title="Agent API keys"
        description="Keys cyboflow uses to talk to agent vendors' APIs. They stay in this computer's keychain and are never shown again."
        icon={<KeyRound className="h-4 w-4" />}
        className="ml-0"
      >
        {error !== null && (
          <p role="alert" className="text-[11px] text-status-error">
            {error}
          </p>
        )}
        <div className="divide-y divide-border-primary overflow-hidden rounded-lg border border-border-primary bg-surface-primary">
          {credentials !== null && credentials.length === 0 && (
            <p data-testid="vendor-credentials-empty" className="px-4 py-4 text-xs text-text-tertiary">
              No API keys yet. An agent that connects through a vendor API (such as Claude Managed Agents) stores its
              key here when you connect it. Bridge agents don&apos;t need a key.
            </p>
          )}
          {credentials?.map((c) => (
            <div key={c.id} data-testid={`credential-row-${c.id}`} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-bold text-text-primary">{VENDOR_LABEL[c.vendor]}</span>
                  <span className="break-words text-[12px] text-text-secondary">{c.label}</span>
                  <span className="font-mono text-[11px] text-text-tertiary">{c.fingerprint}</span>
                  {c.state === 'auth_failed' && <Chip tone="error">Rejected</Chip>}
                  {c.state === 'revoked' && <Chip tone="error">Revoked</Chip>}
                  {c.state === 'undecryptable' && (
                    <Chip
                      tone="warning"
                      title="This key can't be read on this computer (for example after restoring a backup). Rotate it to re-enter it."
                    >
                      Re-enter key
                    </Chip>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">{usedBy(c)}</div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" data-testid={`credential-rotate-${c.id}`} onClick={() => setRotating(c)}>
                  Rotate…
                </Button>
                <Button size="sm" variant="ghost" data-testid={`credential-forget-${c.id}`} onClick={() => setForgetting(c)}>
                  Forget…
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      {rotating !== null && (
        <RotateCredentialDialog
          credential={rotating}
          isOpen
          onClose={() => setRotating(null)}
          onRotated={() => void refetch()}
        />
      )}
      <ConfirmDialog
        isOpen={forgetting !== null}
        onClose={() => setForgetting(null)}
        onConfirm={() => {
          if (forgetting !== null) void forget(forgetting, false);
        }}
        title={`Forget ${forgetting?.label ?? 'this key'}?`}
        message="cyboflow deletes this key from the keychain."
        confirmText="Forget"
      />
      <ConfirmDialog
        isOpen={forceForget !== null}
        onClose={() => setForceForget(null)}
        onConfirm={() => {
          if (forceForget !== null) void forget(forceForget.credential, true);
        }}
        title="This key is in use"
        message={`${forceForget?.names ?? ''} use this key. If you forget it, they stop until you give them a new key.`}
        confirmText="Forget anyway"
      />
    </div>
  );
}
