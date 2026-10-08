import { useCallback, useEffect, useReducer, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { OutlinePill } from '../landing/QueuePrimitives';
import {
  isConnectorCallable,
  type BridgeTransport,
  type PersistentAgentVendor,
} from '../../../../shared/types/persistentAgents';
import { useCloudAccountStore } from '../../stores/cloudAccountStore';
import { usePersistentAgentsStore } from '../../stores/persistentAgentsStore';
import { BridgePairingCard } from './BridgePairingCard';
import { CloudSignInPrompt } from './CloudSignInPrompt';
import { isValidHandle, pairingRemainingMs, slugifyHandle, validateDisplayName } from './agentsEnvFormat';
import { VENDOR_META, VENDOR_ORDER, failureCopy } from './agentsVocabulary';
import { VendorAvatar } from './VendorAvatar';
import type { AgentViewT, CloudStatusT, ConnectorViewT, PairingPayloadT } from './types';

// ---- State machine ---------------------------------------------------------------------

type FieldName = 'displayName' | 'handle';
type SetupError = { code: string; message: string; field: FieldName | null };
type PairingMode = 'connect' | 'reconnect';

export type ConnectDialogState =
  | { step: 'vendor' }
  | {
      step: 'bridge-setup';
      vendor: PersistentAgentVendor;
      connectorId: string;
      displayName: string;
      handle: string;
      handleTouched: boolean;
      transport: BridgeTransport;
      submitting: boolean;
      error: SetupError | null;
      /** Non-null in reconnect mode: the agent keeps its name and handle. */
      reconnectAgentId: string | null;
    }
  | {
      step: 'pairing';
      agentId: string;
      connectionId: string;
      vendor: PersistentAgentVendor;
      transport: BridgeTransport;
      /** null in resume mode until "Get a pairing code". */
      pairing: PairingPayloadT | null;
      busy: 'repair' | 'verify' | 'cancel' | null;
      error: { code: string; message: string } | null;
      mode: PairingMode;
    };

export type ConnectDialogAction =
  | { type: 'pickVendor'; vendor: PersistentAgentVendor; connectorId: string }
  | { type: 'back' }
  | { type: 'edit'; field: 'displayName' | 'handle' | 'transport'; value: string }
  | { type: 'submit' }
  | { type: 'submitFailed'; code: string; message: string; field?: FieldName | null }
  | { type: 'connected'; agentId: string; connectionId: string; pairing: PairingPayloadT | null; mode?: PairingMode }
  | {
      type: 'resume';
      agentId: string;
      connectionId: string;
      vendor: PersistentAgentVendor;
      transport: BridgeTransport;
      mode?: PairingMode;
    }
  | { type: 'reconnect'; agentId: string; vendor: PersistentAgentVendor; displayName: string; transport: BridgeTransport }
  | { type: 'busy'; busy: 'repair' | 'verify' | 'cancel' | null }
  | { type: 'repaired'; connectionId: string; pairing: PairingPayloadT }
  | { type: 'pairingFailed'; code: string; message: string }
  | { type: 'reset' };

function isBridgeTransport(t: string | null | undefined): t is BridgeTransport {
  return t === 'relay-mcp' || t === 'relay-http';
}

export function bridgeTransportFor(t: string | null | undefined, vendor: PersistentAgentVendor): BridgeTransport {
  return isBridgeTransport(t) ? t : (VENDOR_META[vendor].defaultTransport ?? 'relay-mcp');
}

export function connectDialogReducer(s: ConnectDialogState, a: ConnectDialogAction): ConnectDialogState {
  switch (a.type) {
    case 'reset':
      return { step: 'vendor' };
    case 'pickVendor': {
      const meta = VENDOR_META[a.vendor];
      return {
        step: 'bridge-setup',
        vendor: a.vendor,
        connectorId: a.connectorId,
        displayName: meta.defaultName,
        handle: slugifyHandle(meta.defaultName),
        handleTouched: false,
        transport: meta.defaultTransport ?? 'relay-mcp',
        submitting: false,
        error: null,
        reconnectAgentId: null,
      };
    }
    case 'reconnect':
      return {
        step: 'bridge-setup',
        vendor: a.vendor,
        connectorId: 'bridge',
        displayName: a.displayName,
        handle: '',
        handleTouched: true,
        transport: a.transport,
        submitting: false,
        error: null,
        reconnectAgentId: a.agentId,
      };
    case 'back':
      return s.step === 'bridge-setup' ? { step: 'vendor' } : s;
    case 'edit': {
      if (s.step !== 'bridge-setup') return s;
      if (a.field === 'displayName') {
        return {
          ...s,
          displayName: a.value,
          handle: s.handleTouched ? s.handle : slugifyHandle(a.value),
          error: s.error?.field === 'displayName' ? null : s.error,
        };
      }
      if (a.field === 'handle') {
        return { ...s, handle: a.value, handleTouched: true, error: s.error?.field === 'handle' ? null : s.error };
      }
      return isBridgeTransport(a.value) ? { ...s, transport: a.value } : s;
    }
    case 'submit':
      return s.step === 'bridge-setup' ? { ...s, submitting: true, error: null } : s;
    case 'submitFailed':
      return s.step === 'bridge-setup'
        ? { ...s, submitting: false, error: { code: a.code, message: a.message, field: a.field ?? null } }
        : s;
    case 'connected':
      if (s.step !== 'bridge-setup') return s;
      return {
        step: 'pairing',
        agentId: a.agentId,
        connectionId: a.connectionId,
        vendor: s.vendor,
        transport: s.transport,
        pairing: a.pairing,
        busy: null,
        error: null,
        mode: a.mode ?? (s.reconnectAgentId !== null ? 'reconnect' : 'connect'),
      };
    case 'resume':
      return {
        step: 'pairing',
        agentId: a.agentId,
        connectionId: a.connectionId,
        vendor: a.vendor,
        transport: a.transport,
        pairing: null,
        busy: null,
        error: null,
        mode: a.mode ?? 'connect',
      };
    case 'busy':
      return s.step === 'pairing' ? { ...s, busy: a.busy, error: a.busy === null ? s.error : null } : s;
    case 'repaired':
      return s.step === 'pairing' && s.connectionId === a.connectionId
        ? { ...s, pairing: a.pairing, busy: null, error: null }
        : s;
    case 'pairingFailed':
      return s.step === 'pairing' ? { ...s, busy: null, error: { code: a.code, message: a.message } } : s;
  }
}

// ---- Gate ------------------------------------------------------------------------------

export type BridgeSetupGate =
  | { kind: 'unavailable'; copy: string }
  | { kind: 'prompt' }
  | { kind: 'loading' }
  | { kind: 'connector'; copy: string }
  | { kind: 'form' };

const BRIDGE_OFF_COPY = 'The Bridge is turned off on this computer (CYBOFLOW_DISABLE_BRIDGE).';

/** Gate order: (a) cloud unavailable, (b/c0/c) sign-in, account check, entitlement, (d) connector, (e) form. */
export function bridgeSetupGate(args: {
  cloud: CloudStatusT | null;
  connectors: ConnectorViewT[] | null;
  bridgeDisabled: boolean;
  forceSignIn: boolean;
}): BridgeSetupGate {
  const { cloud, connectors, bridgeDisabled, forceSignIn } = args;
  if (cloud !== null && !cloud.available) {
    return { kind: 'unavailable', copy: "cyboflow cloud isn't available in this build." };
  }
  if (cloud === null || forceSignIn) return { kind: 'prompt' };
  if (cloud.display !== 'signed_in' && cloud.display !== 'needs_update') return { kind: 'prompt' };
  if (cloud.account === null || cloud.account.lastOkAt === null) return { kind: 'prompt' };
  if (!cloud.account.bridgeEntitled) return { kind: 'prompt' };
  if (connectors === null) return { kind: 'loading' };
  const bridge = connectors.find((c) => c.definition.id === 'bridge');
  if (bridge === undefined) return { kind: 'connector', copy: "The Bridge isn't available in this build." };
  if (bridgeDisabled || bridge.availability.state === 'disabled') {
    return { kind: 'connector', copy: bridge.availability.message ?? BRIDGE_OFF_COPY };
  }
  if (!isConnectorCallable(bridge.availability)) {
    return { kind: 'connector', copy: bridge.availability.message ?? 'The Bridge is unavailable right now.' };
  }
  return { kind: 'form' };
}

// ---- Component -------------------------------------------------------------------------

export interface ConnectAgentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Resume mode: open at the pairing step for an existing agent with a pending Bridge connection. */
  resumeAgentId?: string | null;
  /** Reconnect mode: pair a NEW Bridge connection for this agent (it keeps its name, handle and thread). */
  reconnectAgentId?: string | null;
  onOpenThread: (agentId: string) => void;
}

interface VendorRow {
  vendor: PersistentAgentVendor;
  connector: ConnectorViewT;
  disabledReason: string | null;
}

function buildVendorRows(connectors: ConnectorViewT[], bridgeDisabled: boolean): VendorRow[] {
  const byVendor = new Map<PersistentAgentVendor, ConnectorViewT>();
  for (const c of connectors) {
    for (const v of c.definition.vendors) {
      const existing = byVendor.get(v);
      if (existing === undefined || (existing.definition.kind !== 'native' && c.definition.kind === 'native')) {
        byVendor.set(v, c);
      }
    }
  }
  return VENDOR_ORDER.filter((v) => byVendor.has(v)).map((vendor) => {
    const connector = byVendor.get(vendor) as ConnectorViewT;
    let disabledReason: string | null = null;
    if (connector.definition.kind === 'native') {
      disabledReason = 'Not available in this build yet.';
    } else if (bridgeDisabled || connector.availability.state === 'disabled') {
      disabledReason = BRIDGE_OFF_COPY;
    }
    return { vendor, connector, disabledReason };
  });
}

export function ConnectAgentDialog({
  isOpen,
  onClose,
  resumeAgentId = null,
  reconnectAgentId = null,
  onOpenThread,
}: ConnectAgentDialogProps): React.JSX.Element | null {
  const [state, dispatch] = useReducer(connectDialogReducer, { step: 'vendor' } as ConnectDialogState);
  const [nameBlurred, setNameBlurred] = useState(false);
  const [forceSignIn, setForceSignIn] = useState(false);

  const connectors = usePersistentAgentsStore((s) => s.connectors);
  const bridgeDisabled = usePersistentAgentsStore((s) => s.featureStatus?.bridgeDisabled === true);
  const agents = usePersistentAgentsStore((s) => s.agents);
  const loadConnectors = usePersistentAgentsStore((s) => s.loadConnectors);
  const connect = usePersistentAgentsStore((s) => s.connect);
  const switchConnection = usePersistentAgentsStore((s) => s.switchConnection);
  const cancelSwitch = usePersistentAgentsStore((s) => s.cancelSwitch);
  const repairPairing = usePersistentAgentsStore((s) => s.repairPairing);
  const verify = usePersistentAgentsStore((s) => s.verify);
  const getPairing = usePersistentAgentsStore((s) => s.getPairing);
  const cloud = useCloudAccountStore((s) => s.status);

  // Open: reset, take a ref on the cloud store, and (resume / reconnect) jump to the right step.
  useEffect(() => {
    if (!isOpen) return undefined;
    dispatch({ type: 'reset' });
    setNameBlurred(false);
    setForceSignIn(false);
    const teardownCloud = useCloudAccountStore.getState().init();
    const cs = useCloudAccountStore.getState().status;
    if (cs?.available === true && cs.display === 'signed_in') void useCloudAccountStore.getState().refresh(false);

    let cancelled = false;
    const all = usePersistentAgentsStore.getState().agents;
    if (reconnectAgentId !== null) {
      const agent = all.find((x) => x.id === reconnectAgentId);
      if (agent === undefined) {
        onClose();
      } else {
        dispatch({
          type: 'reconnect',
          agentId: agent.id,
          vendor: agent.vendor,
          displayName: agent.displayName,
          transport: bridgeTransportFor(agent.connection?.transport, agent.vendor),
        });
      }
    } else if (resumeAgentId !== null) {
      const agent = all.find((x) => x.id === resumeAgentId);
      const switching = agent?.pendingSwitch?.connection.kind === 'bridge';
      const conn = switching ? agent?.pendingSwitch?.connection : agent?.connection;
      if (agent === undefined || conn === undefined || conn === null || conn.kind !== 'bridge') {
        onClose();
      } else {
        dispatch({
          type: 'resume',
          agentId: agent.id,
          connectionId: conn.id,
          vendor: agent.vendor,
          transport: bridgeTransportFor(conn.transport, agent.vendor),
          mode: switching ? 'reconnect' : 'connect',
        });
        void getPairing(conn.id).then((p) => {
          if (cancelled || p === null || p.pairingCode === null || p.pairingExpiresAt === null) return;
          if (pairingRemainingMs(p.pairingExpiresAt, Date.now()) > 0) {
            dispatch({ type: 'repaired', connectionId: conn.id, pairing: p });
          }
        });
      }
    }
    return () => {
      cancelled = true;
      teardownCloud();
    };
    // Re-run only when the dialog opens or its target changes; agents are read at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, resumeAgentId, reconnectAgentId]);

  // Connectors carry live availability: reload on open and whenever the cloud status changes.
  useEffect(() => {
    if (isOpen) void loadConnectors();
  }, [isOpen, cloud, loadConnectors]);

  // A "sign in again" demand (from a not_signed_in / device_revoked failure) clears once the cloud status is replaced.
  useEffect(() => {
    setForceSignIn(false);
  }, [cloud]);

  const pairingAgent: AgentViewT | null =
    state.step === 'pairing' ? (agents.find((a) => a.id === state.agentId) ?? null) : null;

  const handleFailure = useCallback(
    (res: { error: Parameters<typeof failureCopy>[0]['error']; message: string; field?: Parameters<typeof failureCopy>[0]['field'] }): ReturnType<typeof failureCopy> => {
      const fc = failureCopy(res);
      if (fc.needsSignIn) {
        setForceSignIn(true);
        void useCloudAccountStore.getState().refresh(false);
      }
      if (fc.cloudLocked) void useCloudAccountStore.getState().unlock(false);
      return fc;
    },
    [],
  );

  const submit = async (): Promise<void> => {
    if (state.step !== 'bridge-setup' || state.submitting) return;
    dispatch({ type: 'submit' });
    if (state.reconnectAgentId !== null) {
      const agentId = state.reconnectAgentId;
      const res = await switchConnection(agentId, { kind: 'bridge', connectorId: 'bridge', transport: state.transport });
      if (res.ok && res.pairing !== null) {
        dispatch({ type: 'connected', agentId, connectionId: res.connectionId, pairing: res.pairing, mode: 'reconnect' });
        return;
      }
      if (!res.ok && res.error === 'swap_in_progress') {
        const agent = usePersistentAgentsStore.getState().agents.find((x) => x.id === agentId);
        const pending = agent?.pendingSwitch ?? null;
        if (agent !== undefined && pending !== null && pending.connection.kind === 'bridge') {
          dispatch({
            type: 'resume',
            agentId,
            connectionId: pending.connectionId,
            vendor: agent.vendor,
            transport: bridgeTransportFor(pending.connection.transport, agent.vendor),
            mode: 'reconnect',
          });
          void getPairing(pending.connectionId).then((p) => {
            if (p !== null && p.pairingCode !== null && p.pairingExpiresAt !== null && pairingRemainingMs(p.pairingExpiresAt, Date.now()) > 0) {
              dispatch({ type: 'repaired', connectionId: pending.connectionId, pairing: p });
            }
          });
          return;
        }
      }
      if (res.ok) {
        dispatch({ type: 'submitFailed', code: 'unknown', message: 'Something went wrong. Try again.' });
        return;
      }
      const fc = handleFailure(res);
      dispatch({ type: 'submitFailed', code: res.error, message: fc.copy, field: fc.field });
      return;
    }

    const res = await connect({
      agent: { displayName: state.displayName.trim(), vendor: state.vendor, handle: state.handle },
      connection: { kind: 'bridge', connectorId: 'bridge', transport: state.transport },
    });
    if (res.ok && res.pairing !== null) {
      dispatch({ type: 'connected', agentId: res.agentId, connectionId: res.connectionId, pairing: res.pairing });
      return;
    }
    if (res.ok) {
      dispatch({ type: 'submitFailed', code: 'unknown', message: 'Something went wrong. Try again.' });
      return;
    }
    const fc = handleFailure(res);
    dispatch({ type: 'submitFailed', code: res.error, message: fc.copy, field: fc.field });
  };

  const newCode = async (): Promise<void> => {
    if (state.step !== 'pairing') return;
    const connectionId = state.connectionId;
    dispatch({ type: 'busy', busy: 'repair' });
    const res = await repairPairing(connectionId);
    if (res.ok) dispatch({ type: 'repaired', connectionId, pairing: res.pairing });
    else dispatch({ type: 'pairingFailed', code: res.error, message: handleFailure(res).copy });
  };

  const sendTest = async (): Promise<void> => {
    if (state.step !== 'pairing') return;
    dispatch({ type: 'busy', busy: 'verify' });
    const res = await verify(state.connectionId);
    if (res.ok) dispatch({ type: 'busy', busy: null });
    else dispatch({ type: 'pairingFailed', code: res.error, message: handleFailure(res).copy });
  };

  const cancelReconnect = async (): Promise<void> => {
    if (state.step !== 'pairing') return;
    dispatch({ type: 'busy', busy: 'cancel' });
    const res = await cancelSwitch(state.agentId);
    if (res.ok) onClose();
    else dispatch({ type: 'pairingFailed', code: res.error, message: handleFailure(res).copy });
  };

  if (!isOpen) return null;

  const gate = bridgeSetupGate({ cloud, connectors, bridgeDisabled, forceSignIn });

  const title =
    state.step === 'pairing'
      ? `${state.mode === 'reconnect' ? 'Reconnect' : 'Pair'} ${pairingAgent?.displayName ?? 'your agent'}`
      : state.step === 'bridge-setup' && state.reconnectAgentId !== null
        ? `Reconnect ${state.displayName}`
        : 'Connect an agent';

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <div data-testid="connect-agent-dialog" className="flex min-h-0 flex-1 flex-col">
        <ModalHeader title={title} />
        <ModalBody>
          {state.step === 'vendor' && (
            <VendorStep
              connectors={connectors}
              bridgeDisabled={bridgeDisabled}
              onPick={(vendor, connectorId) => dispatch({ type: 'pickVendor', vendor, connectorId })}
            />
          )}
          {state.step === 'bridge-setup' && (
            <BridgeSetupStep
              state={state}
              gate={gate}
              nameBlurred={nameBlurred}
              onNameBlur={() => setNameBlurred(true)}
              dispatch={dispatch}
              onSubmit={() => void submit()}
            />
          )}
          {state.step === 'pairing' && (
            <BridgePairingCard
              agent={pairingAgent}
              connectionId={state.connectionId}
              vendor={state.vendor}
              transport={state.transport}
              mode={state.mode}
              pairing={state.pairing}
              busy={state.busy}
              error={state.error}
              onNewCode={() => void newCode()}
              onSendTestMessage={() => void sendTest()}
              onCancelReconnect={() => void cancelReconnect()}
            />
          )}
        </ModalBody>
        <ModalFooter>
          {state.step === 'bridge-setup' && (
            <>
              {state.reconnectAgentId === null ? (
                <Button variant="ghost" data-testid="connect-back" onClick={() => dispatch({ type: 'back' })}>
                  Back
                </Button>
              ) : (
                <Button variant="ghost" data-testid="connect-cancel" onClick={onClose}>
                  Cancel
                </Button>
              )}
              {gate.kind === 'form' && (
                <SubmitButton state={state} onSubmit={() => void submit()} />
              )}
            </>
          )}
          {state.step === 'pairing' && (
            <>
              <Button variant="secondary" data-testid="pairing-done" onClick={onClose}>
                Done
              </Button>
              <Button variant="primary" data-testid="pairing-open-thread" onClick={() => onOpenThread(state.agentId)}>
                Open thread
              </Button>
            </>
          )}
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---- Steps -----------------------------------------------------------------------------

function VendorStep({
  connectors,
  bridgeDisabled,
  onPick,
}: {
  connectors: ConnectorViewT[] | null;
  bridgeDisabled: boolean;
  onPick: (vendor: PersistentAgentVendor, connectorId: string) => void;
}): React.JSX.Element {
  const rows = connectors === null ? null : buildVendorRows(connectors, bridgeDisabled);
  return (
    <div className="flex flex-col gap-2">
      {rows === null ? (
        <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading connectors…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-text-tertiary">No connectors are available.</p>
      ) : (
        rows.map(({ vendor, connector, disabledReason }) => {
          const meta = VENDOR_META[vendor];
          return (
            <button
              key={vendor}
              type="button"
              data-testid={`connect-vendor-${vendor}`}
              aria-disabled={disabledReason !== null}
              onClick={() => {
                if (disabledReason === null) onPick(vendor, connector.definition.id);
              }}
              className={`flex w-full items-start gap-3 border border-border-primary bg-surface-primary px-3 py-2.5 text-left hover:border-border-emphasized ${
                disabledReason !== null ? 'opacity-70' : ''
              }`}
            >
              <VendorAvatar vendor={vendor} name={meta.label} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[12px] font-bold text-text-primary">{meta.label}</span>
                <span className="block text-[11px] text-text-tertiary">{meta.description}</span>
                {disabledReason !== null && (
                  <span className="mt-1 block text-[11px] text-status-warning">{disabledReason}</span>
                )}
              </span>
              <OutlinePill>
                {connector.definition.kind === 'native' ? 'Connects via API' : 'Connects via cyboflow Bridge'}
              </OutlinePill>
            </button>
          );
        })
      )}
      <p className="mt-1 text-[11px] text-text-tertiary">
        Looking for Muse Code? It is a command-line agent, so it will run as a cyboflow session, not as a
        persistent agent.
      </p>
    </div>
  );
}

type SetupState = Extract<ConnectDialogState, { step: 'bridge-setup' }>;

function setupInvalid(s: SetupState): boolean {
  if (s.reconnectAgentId !== null) return false;
  return validateDisplayName(s.displayName) !== null || !isValidHandle(s.handle);
}

function SubmitButton({ state, onSubmit }: { state: SetupState; onSubmit: () => void }): React.JSX.Element {
  const reconnect = state.reconnectAgentId !== null;
  return (
    <Button
      variant="primary"
      data-testid={reconnect ? 'connect-reconnect-submit' : 'connect-submit'}
      loading={state.submitting}
      disabled={setupInvalid(state) || state.submitting}
      onClick={onSubmit}
    >
      {reconnect ? 'Reconnect' : 'Create connection'}
    </Button>
  );
}

function BridgeSetupStep({
  state,
  gate,
  nameBlurred,
  onNameBlur,
  dispatch,
  onSubmit,
}: {
  state: SetupState;
  gate: BridgeSetupGate;
  nameBlurred: boolean;
  onNameBlur: () => void;
  dispatch: React.Dispatch<ConnectDialogAction>;
  onSubmit: () => void;
}): React.JSX.Element {
  if (gate.kind === 'unavailable' || gate.kind === 'connector') {
    return (
      <p role="status" data-testid="connect-gate-message" className="text-[12px] text-text-secondary">
        {gate.copy}
      </p>
    );
  }
  if (gate.kind === 'prompt') return <CloudSignInPrompt purpose="bridge" />;
  if (gate.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading connectors…
      </div>
    );
  }

  const reconnect = state.reconnectAgentId !== null;
  const nameError =
    state.error?.field === 'displayName'
      ? state.error.message
      : nameBlurred
        ? validateDisplayName(state.displayName)
        : null;
  const handleError =
    state.error?.field === 'handle'
      ? state.error.message
      : state.handle !== '' && !isValidHandle(state.handle)
        ? 'Use lowercase letters, digits and dashes (up to 32).'
        : null;
  const banner = state.error !== null && state.error.field === null ? state.error : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!setupInvalid(state)) onSubmit();
      }}
    >
      {!reconnect && (
        <>
          <Input
            data-testid="connect-name"
            label="Name"
            fullWidth
            value={state.displayName}
            onChange={(e) => dispatch({ type: 'edit', field: 'displayName', value: e.target.value })}
            onBlur={onNameBlur}
            error={nameError ?? undefined}
            helperText="Shown in your rail and on the pairing page."
            autoComplete="off"
          />
          <div>
            <label className="mb-1 block text-label font-medium text-text-primary" htmlFor="connect-handle-input">
              Handle
            </label>
            <div className="flex items-center gap-1 font-mono text-[12px] text-text-tertiary">
              <span>cf/</span>
              <input
                id="connect-handle-input"
                data-testid="connect-handle"
                value={state.handle}
                onChange={(e) => dispatch({ type: 'edit', field: 'handle', value: e.target.value })}
                aria-invalid={handleError !== null}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-input border border-border-primary bg-bg-primary px-input-x py-input-y text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
              />
              <span>/</span>
            </div>
            <p className={`mt-1 text-[11px] ${handleError !== null ? 'text-status-error' : 'text-text-tertiary'}`}>
              {handleError ?? 'Branch prefix it must use for pull requests: cf/{handle}/…'}
            </p>
          </div>
        </>
      )}

      <fieldset>
        <legend className="mb-1 text-label font-medium text-text-primary">How it connects</legend>
        <div role="radiogroup" aria-label="How it connects" className="flex flex-col gap-2">
          {(
            [
              { id: 'relay-mcp', testId: 'connect-transport-mcp', title: 'MCP connector', body: 'For ChatGPT and other apps that can add a remote MCP server. The agent signs in with a one-time pairing code.' },
              { id: 'relay-http', testId: 'connect-transport-http', title: 'HTTP instructions', body: 'For agents that can call a URL from saved instructions. cyboflow gives you a token to paste into them.' },
            ] as const
          ).map((opt) => (
            <label
              key={opt.id}
              className="flex cursor-pointer items-start gap-2 border border-border-primary bg-surface-primary px-3 py-2"
            >
              <input
                type="radio"
                name="connect-transport"
                data-testid={opt.testId}
                checked={state.transport === opt.id}
                onChange={() => dispatch({ type: 'edit', field: 'transport', value: opt.id })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[12px] font-bold text-text-primary">{opt.title}</span>
                <span className="block text-[11px] text-text-tertiary">{opt.body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p
        data-testid="connect-one-desktop-note"
        className="border border-border-primary bg-surface-secondary px-3 py-2 text-[11px] text-text-secondary"
      >
        Use one computer for this agent. If another computer signed in to the same cyboflow account also collects
        Bridge messages, whichever checks first receives them — the other never sees them.
      </p>

      {banner !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-status-error">
          <span>{banner.message}</span>
          {banner.code === 'service_unavailable' && (
            <Button variant="ghost" size="sm" data-testid="connect-try-again" onClick={onSubmit}>
              Try again
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
