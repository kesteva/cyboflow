import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import type { CloudChangedEvent, CloudStatus } from '../../../../../shared/types/cloudAccountWire';
import { makeAgent, makeBridgeConnector, makeCloudStatus, makeConnection, makeStatus } from './fixtures';
import type { AgentViewT, ConnectorViewT, PairingPayloadT } from '../types';

// ---- tRPC mock (mutable refs, reassigned in beforeEach) -------------------------------------
let cloudStatus: CloudStatus;
let serverAgents: AgentViewT[];
let connectors: ConnectorViewT[];
let featureStatus: ReturnType<typeof makeStatus>;
let cloudHandlers: { onData: (e: CloudChangedEvent) => void } | null;
let agentsHandlers: { onData: (e: { kind: string; agentId: string | null }) => void } | null;

let cloudStatusQuery: ReturnType<typeof vi.fn>;
let signInMutate: ReturnType<typeof vi.fn>;
let refreshMutate: ReturnType<typeof vi.fn>;
let unlockMutate: ReturnType<typeof vi.fn>;
let listConnectorsQuery: ReturnType<typeof vi.fn>;
let connectMutate: ReturnType<typeof vi.fn>;
let switchMutate: ReturnType<typeof vi.fn>;
let cancelSwitchMutate: ReturnType<typeof vi.fn>;
let repairMutate: ReturnType<typeof vi.fn>;
let verifyMutate: ReturnType<typeof vi.fn>;
let getPairingQuery: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      cloud: {
        status: { get query() { return cloudStatusQuery; } },
        onCloudChanged: {
          subscribe: vi.fn().mockImplementation((_i: undefined, h: { onData: (e: CloudChangedEvent) => void }) => {
            cloudHandlers = h;
            return { unsubscribe: vi.fn() };
          }),
        },
        signIn: { get mutate() { return signInMutate; } },
        refreshAccount: { get mutate() { return refreshMutate; } },
        unlock: { get mutate() { return unlockMutate; } },
        cancelSignIn: { mutate: vi.fn() },
        reopenSignInPage: { mutate: vi.fn() },
      },
      persistentAgents: {
        status: { query: vi.fn().mockImplementation(async () => featureStatus) },
        listAgents: { query: vi.fn().mockImplementation(async () => serverAgents) },
        listConnectors: { get query() { return listConnectorsQuery; } },
        connect: { get mutate() { return connectMutate; } },
        switchConnection: { get mutate() { return switchMutate; } },
        cancelSwitch: { get mutate() { return cancelSwitchMutate; } },
        repairPairing: { get mutate() { return repairMutate; } },
        verify: { get mutate() { return verifyMutate; } },
        getPairing: { get query() { return getPairingQuery; } },
        onAgentsChanged: {
          subscribe: vi.fn().mockImplementation((_i: undefined, h: { onData: (e: { kind: string; agentId: string | null }) => void }) => {
            agentsHandlers = h;
            return { unsubscribe: vi.fn() };
          }),
        },
      },
    },
  },
}));

import { ConnectAgentDialog, connectDialogReducer, bridgeSetupGate, type ConnectDialogState } from '../ConnectAgentDialog';
import { useCloudAccountStore } from '../../../stores/cloudAccountStore';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';

const cloudInitial = useCloudAccountStore.getState();
let teardown: (() => void) | null = null;

function pairing(over: Partial<PairingPayloadT> = {}): PairingPayloadT {
  return {
    kind: 'bridge',
    connectionId: 'conn-1',
    transport: 'relay-mcp',
    mcpUrl: 'https://relay.example/mcp/c1',
    httpBase: 'https://relay.example/c/c1',
    pairingCode: 'AMBER-FALCON-4821',
    pairingExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    oneTimeToken: null,
    instructionBrief: null,
    ...over,
  };
}

const DEFAULT_PAIRING_FACTS = [
  { key: 'pairing-issued', label: 'Pairing code issued', at: '2026-10-07T10:00:00.000Z', status: 'done' as const },
  { key: 'paired', label: 'Paired with', at: null, status: 'waiting' as const },
  { key: 'round-trip', label: 'Round trip verified', at: null, status: 'waiting' as const },
];

beforeEach(async () => {
  cloudHandlers = null;
  agentsHandlers = null;
  cloudStatus = makeCloudStatus('signed_in');
  serverAgents = [];
  connectors = [makeBridgeConnector()];
  featureStatus = makeStatus();
  cloudStatusQuery = vi.fn().mockImplementation(async () => cloudStatus);
  signInMutate = vi.fn().mockResolvedValue({ expiresAt: '2026-10-07T11:00:00.000Z' });
  refreshMutate = vi.fn().mockImplementation(async () => cloudStatus);
  unlockMutate = vi.fn().mockImplementation(async () => cloudStatus);
  listConnectorsQuery = vi.fn().mockImplementation(async () => connectors);
  connectMutate = vi.fn().mockResolvedValue({ ok: true, agentId: 'a1', connectionId: 'conn-1', pairing: pairing() });
  switchMutate = vi.fn();
  cancelSwitchMutate = vi.fn().mockResolvedValue({ ok: true });
  repairMutate = vi.fn();
  verifyMutate = vi.fn().mockResolvedValue({ ok: true, connectionId: 'conn-1', state: 'pending', facts: [], probeQueued: true });
  getPairingQuery = vi.fn().mockResolvedValue(null);
  useCloudAccountStore.setState({ ...cloudInitial, status: null, actionError: null, pending: null });
  usePersistentAgentsStore.setState({ featureStatus: null, connectors: null, agents: [], agentsStatus: 'idle', threads: {} });
  teardown = usePersistentAgentsStore.getState().init();
  await waitFor(() => expect(usePersistentAgentsStore.getState().featureStatus).not.toBeNull());
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

function open(props: Partial<React.ComponentProps<typeof ConnectAgentDialog>> = {}): { onClose: ReturnType<typeof vi.fn>; onOpenThread: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const onOpenThread = vi.fn();
  render(<ConnectAgentDialog isOpen onClose={onClose} onOpenThread={onOpenThread} {...props} />);
  return { onClose, onOpenThread };
}

async function pickVendor(vendor: 'openai-dots' | 'meta-muse' | 'other'): Promise<void> {
  fireEvent.click(await screen.findByTestId(`connect-vendor-${vendor}`));
}

describe('ConnectAgentDialog: vendor step', () => {
  it('rows come from listConnectors, in vendor order, each tagged as a Bridge connection', async () => {
    open();
    const rows = await screen.findAllByTestId(/^connect-vendor-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'connect-vendor-openai-dots',
      'connect-vendor-meta-muse',
      'connect-vendor-other',
    ]);
    for (const r of rows) expect(r).toHaveTextContent('Connects via cyboflow Bridge');
    expect(screen.queryByTestId('connect-vendor-anthropic-cma')).toBeNull();
  });

  it('the Muse Code note is always present', async () => {
    open();
    await screen.findByTestId('connect-vendor-openai-dots');
    expect(screen.getByText(/Looking for Muse Code\?/)).toBeInTheDocument();
  });

  it('a disabled Bridge disables its rows with the reason, and a click does not advance', async () => {
    act(() => usePersistentAgentsStore.setState({ featureStatus: makeStatus({ bridgeDisabled: true }) }));
    open();
    const row = await screen.findByTestId('connect-vendor-openai-dots');
    await waitFor(() => expect(row).toHaveAttribute('aria-disabled', 'true'));
    expect(row).toHaveTextContent('The Bridge is turned off on this computer (CYBOFLOW_DISABLE_BRIDGE).');
    fireEvent.click(row);
    expect(screen.queryByTestId('connect-name')).toBeNull();
    expect(screen.getByTestId('connect-vendor-openai-dots')).toBeInTheDocument();
  });

  it('a native connector row is disabled in this build', async () => {
    connectors = [
      {
        ...makeBridgeConnector(),
        definition: { ...makeBridgeConnector().definition, id: 'claude-managed-agents', kind: 'native', vendors: ['anthropic-cma'], connectsVia: 'api' },
      },
    ];
    open();
    const row = await screen.findByTestId('connect-vendor-anthropic-cma');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent('Not available in this build yet.');
    expect(row).toHaveTextContent('Connects via API');
  });
});

describe('ConnectAgentDialog: bridge setup gate', () => {
  it('signed out shows the sign-in prompt and no form; the button signs in', async () => {
    cloudStatus = makeCloudStatus('signed_out');
    open();
    await pickVendor('openai-dots');
    const prompt = await screen.findByTestId('cloud-signin-prompt');
    expect(screen.queryByTestId('connect-name')).toBeNull();
    fireEvent.click(within(prompt).getByTestId('cloud-signin-button'));
    await waitFor(() => expect(signInMutate).toHaveBeenCalledTimes(1));
  });

  it('signed in without the Bridge entitlement shows the beta copy with the login and no form', async () => {
    cloudStatus = makeCloudStatus('signed_in', { bridgeEntitled: false, displayLogin: 'octo' });
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByText("The cyboflow Bridge is in private beta and isn't enabled for @octo yet.")).toBeInTheDocument();
    expect(screen.queryByTestId('connect-name')).toBeNull();
  });

  it('gate order (a) cloud not available in this build', async () => {
    cloudStatus = { available: false };
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByText("cyboflow cloud isn't available in this build.")).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-signin-prompt')).toBeNull();
  });

  it('gate order (c0) an unfetched account shows Checking your account…, no beta copy', async () => {
    cloudStatus = makeCloudStatus('signed_in', { lastOkAt: null, bridgeEntitled: false });
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByText('Checking your account…')).toBeInTheDocument();
    expect(screen.queryByText(/private beta/)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('cloud-prompt-check-again')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('cloud-prompt-check-again'));
    await waitFor(() => expect(refreshMutate).toHaveBeenCalledWith({ force: true }));
  });

  it('gate order (d) a connector that is not callable shows its message', async () => {
    connectors = [makeBridgeConnector({ availability: { state: 'needs_update', message: 'Update cyboflow to keep the Bridge working.', retryAt: null } })];
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByText('Update cyboflow to keep the Bridge working.')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-name')).toBeNull();
  });

  it('gate order (e) everything ready renders the form', async () => {
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByTestId('connect-name')).toBeInTheDocument();
  });

  it('the gate is evaluated in order (pure)', () => {
    const ok = makeCloudStatus('signed_in');
    const bridge = [makeBridgeConnector()];
    expect(bridgeSetupGate({ cloud: { available: false }, connectors: bridge, bridgeDisabled: false, forceSignIn: false }).kind).toBe('unavailable');
    expect(bridgeSetupGate({ cloud: null, connectors: bridge, bridgeDisabled: false, forceSignIn: false }).kind).toBe('prompt');
    expect(bridgeSetupGate({ cloud: makeCloudStatus('locked'), connectors: bridge, bridgeDisabled: false, forceSignIn: false }).kind).toBe('prompt');
    expect(bridgeSetupGate({ cloud: makeCloudStatus('signed_in', { lastOkAt: null }), connectors: bridge, bridgeDisabled: false, forceSignIn: false }).kind).toBe('prompt');
    expect(bridgeSetupGate({ cloud: makeCloudStatus('signed_in', { bridgeEntitled: false }), connectors: bridge, bridgeDisabled: false, forceSignIn: false }).kind).toBe('prompt');
    expect(bridgeSetupGate({ cloud: ok, connectors: null, bridgeDisabled: false, forceSignIn: false }).kind).toBe('loading');
    expect(bridgeSetupGate({ cloud: ok, connectors: bridge, bridgeDisabled: true, forceSignIn: false }).kind).toBe('connector');
    expect(bridgeSetupGate({ cloud: ok, connectors: bridge, bridgeDisabled: false, forceSignIn: true }).kind).toBe('prompt');
    expect(bridgeSetupGate({ cloud: ok, connectors: bridge, bridgeDisabled: false, forceSignIn: false }).kind).toBe('form');
  });

  it('connectors seeded signed out; the cloud turns signed in and a connection signal re-queries them and the form renders', async () => {
    cloudStatus = makeCloudStatus('signed_out');
    connectors = [makeBridgeConnector({ availability: { state: 'signed_out', message: 'Sign in to cyboflow cloud', retryAt: null } })];
    open();
    await pickVendor('openai-dots');
    await screen.findByTestId('cloud-signin-prompt');
    const queriesBefore = listConnectorsQuery.mock.calls.length;

    cloudStatus = makeCloudStatus('signed_in');
    connectors = [makeBridgeConnector()];
    act(() => cloudHandlers?.onData({ kind: 'signedIn', status: cloudStatus }));
    act(() => agentsHandlers?.onData({ kind: 'connection', agentId: null }));
    expect(await screen.findByTestId('connect-name')).toBeInTheDocument();
    expect(listConnectorsQuery.mock.calls.length).toBeGreaterThan(queriesBefore);
  });
});

describe('ConnectAgentDialog: bridge setup form', () => {
  it('the transport defaults per vendor', async () => {
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByTestId('connect-transport-mcp')).toBeChecked();
    expect(screen.getByTestId('connect-transport-http')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('connect-back'));
    await pickVendor('meta-muse');
    expect(await screen.findByTestId('connect-transport-http')).toBeChecked();
  });

  it('the handle follows the name until it is edited; an invalid handle disables submit', async () => {
    open();
    await pickVendor('openai-dots');
    const name = await screen.findByTestId('connect-name');
    const handle = screen.getByTestId('connect-handle') as HTMLInputElement;
    expect(handle.value).toBe('my-dot');
    fireEvent.change(name, { target: { value: 'Research Bot' } });
    expect(handle.value).toBe('research-bot');
    fireEvent.change(handle, { target: { value: 'custom' } });
    fireEvent.change(name, { target: { value: 'Another Name' } });
    expect(handle.value).toBe('custom');
    fireEvent.change(handle, { target: { value: 'Bad Handle!' } });
    expect(screen.getByText('Use lowercase letters, digits and dashes (up to 32).')).toBeInTheDocument();
    expect(screen.getByTestId('connect-submit')).toBeDisabled();
  });

  it('the one-computer note is always shown on the form', async () => {
    open();
    await pickVendor('openai-dots');
    expect(await screen.findByTestId('connect-one-desktop-note')).toHaveTextContent('Use one computer for this agent.');
  });

  it('submit sends the canonical connect input with the trimmed name', async () => {
    open();
    await pickVendor('openai-dots');
    fireEvent.change(await screen.findByTestId('connect-name'), { target: { value: '  Research Bot  ' } });
    fireEvent.click(screen.getByTestId('connect-submit'));
    await waitFor(() =>
      expect(connectMutate).toHaveBeenCalledWith({
        agent: { displayName: 'Research Bot', vendor: 'openai-dots', handle: 'research-bot' },
        connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' },
      }),
    );
    expect(await screen.findByTestId('bridge-pairing-card')).toBeInTheDocument();
  });

  it('handle_taken shows under the handle and keeps the form', async () => {
    connectMutate.mockResolvedValue({ ok: false, error: 'handle_taken', message: 'taken' });
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByText('Another agent already uses this handle.')).toBeInTheDocument();
    expect(screen.getByTestId('connect-name')).toBeInTheDocument();
  });

  it('connection_limit is a banner naming 20 connections', async () => {
    connectMutate.mockResolvedValue({ ok: false, error: 'connection_limit', message: 'x' });
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account already has 20 Bridge connections. Disconnect one you no longer use first.',
    );
  });

  it('a thrown error shows the generic copy', async () => {
    connectMutate.mockRejectedValue(new Error(''));
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
  });

  it('a not_signed_in failure replaces the form with the sign-in prompt', async () => {
    connectMutate.mockResolvedValue({ ok: false, error: 'not_signed_in', message: 'x' });
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByTestId('cloud-signin-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-name')).toBeNull();
  });

  it('a cloud_locked failure asks main to unlock', async () => {
    connectMutate.mockResolvedValue({ ok: false, error: 'cloud_locked', message: 'x' });
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unlocking your cyboflow cloud sign-in. Try again in a moment.');
    await waitFor(() => expect(unlockMutate).toHaveBeenCalledWith({ explicitRetry: false }));
  });
});

describe('ConnectAgentDialog: pairing', () => {
  it('a new code is requested for the connection and replaces the displayed one', async () => {
    repairMutate.mockResolvedValue({ ok: true, pairing: pairing({ pairingCode: 'NEXT-OTTER-0007' }) });
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('AMBER-FALCON-4821');
    expect(screen.getByTestId('pairing-mcp-url')).toHaveTextContent('https://relay.example/mcp/c1');
    fireEvent.click(screen.getByTestId('pairing-new-code'));
    await waitFor(() => expect(repairMutate).toHaveBeenCalledWith({ connectionId: 'conn-1' }));
    await waitFor(() => expect(screen.getByTestId('pairing-code')).toHaveTextContent('NEXT-OTTER-0007'));
  });

  it('a paired client appears as labelled facts and the code row goes away', async () => {
    serverAgents = [makeAgent({ connection: makeConnection({ state: 'pending', verifyFacts: DEFAULT_PAIRING_FACTS }) })];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    await screen.findByTestId('pairing-code');
    const paired = makeAgent({
      connection: makeConnection({
        state: 'pending',
        pairedClient: { name: 'ChatGPT', redirectHost: 'chatgpt.com', pairedAt: '2026-10-07T10:01:00.000Z' },
        verifyFacts: [
          DEFAULT_PAIRING_FACTS[0],
          { key: 'paired', label: 'Paired with', at: '2026-10-07T10:01:00.000Z', status: 'done', subject: { name: 'ChatGPT', host: 'chatgpt.com' } },
          DEFAULT_PAIRING_FACTS[2],
        ],
      }),
    });
    act(() => usePersistentAgentsStore.setState({ agents: [paired] }));
    const row = await screen.findByTestId('pairing-fact-paired');
    expect(row).toHaveTextContent('“ChatGPT” (name reported by the client) · chatgpt.com');
    expect(screen.queryByTestId('pairing-code')).toBeNull();
    expect(screen.queryByTestId('pairing-new-code')).toBeNull();
    fireEvent.click(screen.getByTestId('pairing-send-test'));
    await waitFor(() => expect(verifyMutate).toHaveBeenCalledWith({ connectionId: 'conn-1' }));
  });

  it('the checklist renders from connection.verifyFacts for relay-http rows', async () => {
    connectMutate.mockResolvedValue({
      ok: true, agentId: 'a1', connectionId: 'conn-1',
      pairing: pairing({ transport: 'relay-http', pairingCode: null, pairingExpiresAt: null, oneTimeToken: 'cbh_secret', instructionBrief: 'You have a mailbox. Token: cbh_secret' }),
    });
    serverAgents = [
      makeAgent({
        connection: makeConnection({
          transport: 'relay-http',
          state: 'pending',
          verifyFacts: [
            { key: 'token-issued', label: 'Token issued', at: '2026-10-07T10:00:00.000Z', status: 'done' },
            { key: 'pair-called', label: 'Pair call received', at: '2026-10-07T10:01:00.000Z', status: 'done' },
            { key: 'first-call', label: 'First call received', at: null, status: 'waiting' },
            { key: 'round-trip', label: 'Round trip verified', at: null, status: 'waiting' },
          ],
        }),
      }),
    ];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    open();
    await pickVendor('meta-muse');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    const list = await screen.findByTestId('pairing-checklist');
    expect(within(list).getByTestId('pairing-fact-pair-called')).toHaveTextContent('Pair call received');
    expect(within(list).getByTestId('pairing-fact-first-call')).toHaveTextContent('First call received');
  });

  it('a verified connection shows the success line; Open thread opens it', async () => {
    serverAgents = [makeAgent({ connection: makeConnection({ state: 'verified', verifyFacts: DEFAULT_PAIRING_FACTS }) })];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    const { onOpenThread } = open();
    await pickVendor('openai-dots');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByText('Connected. Messages, links and pull request reports will show up in its thread.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pairing-open-thread'));
    expect(onOpenThread).toHaveBeenCalledWith('a1');
  });

  it('the HTTP instructions render once, are copyable, and warn the token is shown only now', async () => {
    const brief = 'You have a cyboflow mailbox.\nAuthorization: Bearer cbh_secret_token';
    connectMutate.mockResolvedValue({
      ok: true, agentId: 'a1', connectionId: 'conn-1',
      pairing: pairing({ transport: 'relay-http', pairingCode: null, pairingExpiresAt: null, oneTimeToken: 'cbh_secret_token', instructionBrief: brief }),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open();
    await pickVendor('meta-muse');
    fireEvent.click(await screen.findByTestId('connect-submit'));
    const pre = await screen.findByTestId('pairing-http-instructions');
    expect(pre.textContent).toBe(brief);
    expect(screen.getAllByText(/cbh_secret_token/)).toHaveLength(1);
    expect(screen.getByText(/The token is shown only now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy instructions' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(brief));
  });

  it('resume mode with no brief offers Issue a new token, behind a confirm', async () => {
    const agent = makeAgent({ connection: makeConnection({ state: 'pending', transport: 'relay-http' }) });
    serverAgents = [agent];
    usePersistentAgentsStore.setState({ agents: [agent] });
    repairMutate.mockResolvedValue({
      ok: true,
      pairing: pairing({ transport: 'relay-http', pairingCode: null, pairingExpiresAt: null, oneTimeToken: 'cbh_new', instructionBrief: 'new brief cbh_new' }),
    });
    open({ resumeAgentId: 'a1' });
    fireEvent.click(await screen.findByTestId('pairing-new-token'));
    expect(repairMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Issue new token' }));
    await waitFor(() => expect(repairMutate).toHaveBeenCalledWith({ connectionId: 'conn-1' }));
    expect(await screen.findByTestId('pairing-http-instructions')).toHaveTextContent('new brief cbh_new');
  });

  it('resume mode asks getPairing first and, with nothing cached, offers Get a pairing code', async () => {
    const agent = makeAgent({ connection: makeConnection({ state: 'pending' }) });
    serverAgents = [agent];
    usePersistentAgentsStore.setState({ agents: [agent] });
    open({ resumeAgentId: 'a1' });
    await waitFor(() => expect(getPairingQuery).toHaveBeenCalledWith({ connectionId: 'conn-1' }));
    const btn = await screen.findByTestId('pairing-new-code');
    expect(btn).toHaveTextContent('Get a pairing code');
    expect(screen.queryByTestId('pairing-code')).toBeNull();
    expect(connectMutate).not.toHaveBeenCalled();
  });

  it('resume mode shows a still-valid cached code', async () => {
    const agent = makeAgent({ connection: makeConnection({ state: 'pending' }) });
    serverAgents = [agent];
    usePersistentAgentsStore.setState({ agents: [agent] });
    getPairingQuery.mockResolvedValue(pairing());
    open({ resumeAgentId: 'a1' });
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('AMBER-FALCON-4821');
  });

  it('a hostile client name renders as literal text; a bidi override does not change the host text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const bidi = `evil‮gnp.exe`;
    const connection = makeConnection({
      state: 'pending',
      pairedClient: { name: hostile, redirectHost: 'chatgpt.com', pairedAt: '2026-10-07T10:01:00.000Z' },
      verifyFacts: [
        { key: 'paired', label: 'Paired with', at: null, status: 'done', subject: { name: hostile, host: 'chatgpt.com' } },
      ],
    });
    serverAgents = [makeAgent({ connection })];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    open({ resumeAgentId: 'a1' });
    const name = await screen.findByTestId('pairing-paired-client-name');
    expect(name.textContent).toBe(hostile);
    expect(document.body.querySelector('img')).toBeNull();
    expect(name.tagName).toBe('BDI');

    act(() =>
      usePersistentAgentsStore.setState({
        agents: [
          makeAgent({
            connection: makeConnection({
              state: 'pending',
              verifyFacts: [{ key: 'paired', label: 'Paired with', at: null, status: 'done', subject: { name: bidi, host: 'chatgpt.com' } }],
            }),
          }),
        ],
      }),
    );
    await waitFor(() => expect(screen.getByTestId('pairing-paired-client-name').textContent).toBe(bidi));
    expect(screen.getByTestId('pairing-paired-client-host').textContent).toBe('chatgpt.com');
  });
});

describe('ConnectAgentDialog: pairing countdown', () => {
  it('the countdown ticks, expires, and offers a new code', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    open();
    // Seed the pairing step directly through the real flow
    fireEvent.click(await screen.findByTestId('connect-vendor-openai-dots'));
    fireEvent.click(await screen.findByTestId('connect-submit'));
    expect(await screen.findByTestId('pairing-countdown')).toHaveTextContent('Expires in 10:00');
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId('pairing-countdown')).toHaveTextContent('Expires in 8:59');
    act(() => {
      vi.advanceTimersByTime(9 * 60_000);
    });
    expect(screen.getByText('This code expired.')).toBeInTheDocument();
    expect(screen.queryByTestId('pairing-countdown')).toBeNull();
    expect(screen.getByTestId('pairing-new-code')).toHaveTextContent('New code');
  });
});

describe('ConnectAgentDialog: reconnect', () => {
  const revoked = (): AgentViewT => makeAgent({ connection: makeConnection({ state: 'revoked' }) });

  it('reconnect hides name and handle and calls switchConnection for the same agent, then pairs the returned connection', async () => {
    serverAgents = [revoked()];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    switchMutate.mockResolvedValue({
      ok: true, agentId: 'a1', connectionId: 'conn-2',
      pairing: pairing({ connectionId: 'conn-2', pairingCode: 'NEW-HERON-1111' }),
    });
    open({ reconnectAgentId: 'a1' });
    const submit = await screen.findByTestId('connect-reconnect-submit');
    expect(submit).toHaveTextContent('Reconnect');
    expect(screen.queryByTestId('connect-name')).toBeNull();
    expect(screen.queryByTestId('connect-handle')).toBeNull();
    expect(screen.getByText('Reconnect My dot')).toBeInTheDocument();
    // the new connection becomes the agent's pending switch once the list refetches
    serverAgents = [
      makeAgent({
        connection: makeConnection({ state: 'revoked' }),
        pendingSwitch: {
          connectionId: 'conn-2', swapState: 'awaiting_verify', startedAt: '2026-10-07T10:00:00.000Z',
          connection: makeConnection({ id: 'conn-2', state: 'pending' }),
        },
      }),
    ];
    fireEvent.click(submit);
    await waitFor(() =>
      expect(switchMutate).toHaveBeenCalledWith({
        agentId: 'a1',
        connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' },
      }),
    );
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('NEW-HERON-1111');
    expect(connectMutate).not.toHaveBeenCalled();
  });

  it('Cancel reconnect cancels the pending switch and closes', async () => {
    serverAgents = [revoked()];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    switchMutate.mockResolvedValue({
      ok: true, agentId: 'a1', connectionId: 'conn-2',
      pairing: pairing({ connectionId: 'conn-2' }),
    });
    serverAgents = [
      makeAgent({
        connection: makeConnection({ state: 'revoked' }),
        pendingSwitch: {
          connectionId: 'conn-2', swapState: 'awaiting_verify', startedAt: '2026-10-07T10:00:00.000Z',
          connection: makeConnection({ id: 'conn-2', state: 'pending' }),
        },
      }),
    ];
    const { onClose } = open({ reconnectAgentId: 'a1' });
    // keep the revoked agent visible until the switch is submitted (the dialog read it at open)
    fireEvent.click(await screen.findByTestId('connect-reconnect-submit'));
    const cancel = await screen.findByTestId('pairing-cancel-switch');
    await waitFor(() => expect(cancel).not.toBeDisabled());
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelSwitchMutate).toHaveBeenCalledWith({ agentId: 'a1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('swap_in_progress opens the existing switch pairing instead', async () => {
    const pendingAgent = makeAgent({
      connection: makeConnection({ state: 'revoked' }),
      pendingSwitch: {
        connectionId: 'conn-2', swapState: 'awaiting_verify', startedAt: '2026-10-07T10:00:00.000Z',
        connection: makeConnection({ id: 'conn-2', state: 'pending' }),
      },
    });
    serverAgents = [revoked()];
    usePersistentAgentsStore.setState({ agents: serverAgents });
    switchMutate.mockImplementation(async () => {
      serverAgents = [pendingAgent];
      usePersistentAgentsStore.setState({ agents: [pendingAgent] });
      return { ok: false, error: 'swap_in_progress', message: 'A switch is already in progress.' };
    });
    open({ reconnectAgentId: 'a1' });
    fireEvent.click(await screen.findByTestId('connect-reconnect-submit'));
    await waitFor(() => expect(getPairingQuery).toHaveBeenCalledWith({ connectionId: 'conn-2' }));
    expect(await screen.findByTestId('pairing-new-code')).toHaveTextContent('Get a pairing code');
  });

  it('resume on a pending switch opens at the switch connection in reconnect mode', async () => {
    const agent = makeAgent({
      connection: makeConnection({ state: 'revoked' }),
      pendingSwitch: {
        connectionId: 'conn-2', swapState: 'awaiting_verify', startedAt: '2026-10-07T10:00:00.000Z',
        connection: makeConnection({ id: 'conn-2', state: 'pending' }),
      },
    });
    serverAgents = [agent];
    usePersistentAgentsStore.setState({ agents: [agent] });
    open({ resumeAgentId: 'a1' });
    await waitFor(() => expect(getPairingQuery).toHaveBeenCalledWith({ connectionId: 'conn-2' }));
    expect(await screen.findByTestId('pairing-cancel-switch')).toBeInTheDocument();
    expect(screen.getByText('Reconnect My dot')).toBeInTheDocument();
  });
});

describe('connectDialogReducer', () => {
  const vendor: ConnectDialogState = { step: 'vendor' };

  it('vendor to setup to pairing, and back', () => {
    const setup = connectDialogReducer(vendor, { type: 'pickVendor', vendor: 'openai-dots', connectorId: 'bridge' });
    expect(setup).toMatchObject({ step: 'bridge-setup', displayName: 'My dot', handle: 'my-dot', transport: 'relay-mcp', submitting: false });
    expect(connectDialogReducer(setup, { type: 'back' })).toEqual(vendor);
    const submitting = connectDialogReducer(setup, { type: 'submit' });
    expect(submitting).toMatchObject({ submitting: true });
    const paired = connectDialogReducer(submitting, { type: 'connected', agentId: 'a1', connectionId: 'c1', pairing: pairing() });
    expect(paired).toMatchObject({ step: 'pairing', agentId: 'a1', connectionId: 'c1', mode: 'connect', vendor: 'openai-dots' });
  });

  it('submitFailed keeps the inputs and records the error; reset starts over', () => {
    const setup = connectDialogReducer(vendor, { type: 'pickVendor', vendor: 'meta-muse', connectorId: 'bridge' });
    const edited = connectDialogReducer(setup, { type: 'edit', field: 'displayName', value: 'Bot' });
    const failed = connectDialogReducer(connectDialogReducer(edited, { type: 'submit' }), {
      type: 'submitFailed', code: 'handle_taken', message: 'taken', field: 'handle',
    });
    expect(failed).toMatchObject({ step: 'bridge-setup', displayName: 'Bot', handle: 'bot', submitting: false, error: { code: 'handle_taken', field: 'handle' } });
    expect(connectDialogReducer(failed, { type: 'reset' })).toEqual(vendor);
  });

  it('editing the handle stops the name from driving it; editing either clears its own server error', () => {
    let s = connectDialogReducer(vendor, { type: 'pickVendor', vendor: 'openai-dots', connectorId: 'bridge' });
    s = connectDialogReducer(s, { type: 'submitFailed', code: 'handle_taken', message: 'taken', field: 'handle' });
    s = connectDialogReducer(s, { type: 'edit', field: 'handle', value: 'mine' });
    expect(s).toMatchObject({ handle: 'mine', handleTouched: true, error: null });
    s = connectDialogReducer(s, { type: 'edit', field: 'displayName', value: 'Zed' });
    expect(s).toMatchObject({ handle: 'mine' });
  });

  it('reconnect enters setup with the old transport and the agent id; connected then pairs in reconnect mode', () => {
    const setup = connectDialogReducer(vendor, { type: 'reconnect', agentId: 'a1', vendor: 'meta-muse', displayName: 'Muse', transport: 'relay-http' });
    expect(setup).toMatchObject({ step: 'bridge-setup', reconnectAgentId: 'a1', transport: 'relay-http' });
    const paired = connectDialogReducer(setup, { type: 'connected', agentId: 'a1', connectionId: 'c2', pairing: pairing() });
    expect(paired).toMatchObject({ step: 'pairing', mode: 'reconnect', connectionId: 'c2' });
  });

  it('a late repaired action for another connection is ignored', () => {
    const paired = connectDialogReducer(
      connectDialogReducer(vendor, { type: 'pickVendor', vendor: 'openai-dots', connectorId: 'bridge' }),
      { type: 'connected', agentId: 'a1', connectionId: 'c1', pairing: null },
    );
    expect(connectDialogReducer(paired, { type: 'repaired', connectionId: 'other', pairing: pairing() })).toBe(paired);
  });

  it('resume enters pairing without a code', () => {
    expect(
      connectDialogReducer(vendor, { type: 'resume', agentId: 'a1', connectionId: 'c1', vendor: 'openai-dots', transport: 'relay-mcp' }),
    ).toMatchObject({ step: 'pairing', pairing: null, mode: 'connect' });
  });
});
