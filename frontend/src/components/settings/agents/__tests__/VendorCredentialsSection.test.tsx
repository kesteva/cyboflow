import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { makeStatus } from '../../../agentsEnv/__tests__/fixtures';
import type { CredentialViewT } from '../../../agentsEnv/types';

let listCredentialsQuery: ReturnType<typeof vi.fn>;
let rotateMutate: ReturnType<typeof vi.fn>;
let forgetMutate: ReturnType<typeof vi.fn>;
let handlers: { onData: (e: { kind: string; agentId: string | null }) => void } | null;

vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      persistentAgents: {
        listCredentials: { get query() { return listCredentialsQuery; } },
        rotateCredential: { get mutate() { return rotateMutate; } },
        forgetCredential: { get mutate() { return forgetMutate; } },
        onAgentsChanged: {
          subscribe: vi.fn().mockImplementation((_i: undefined, h: { onData: (e: { kind: string; agentId: string | null }) => void }) => {
            handlers = h;
            return { unsubscribe: vi.fn() };
          }),
        },
      },
    },
  },
}));

import { VendorCredentialsSection } from '../VendorCredentialsSection';
import { usePersistentAgentsStore } from '../../../../stores/persistentAgentsStore';

function cred(over: Partial<CredentialViewT> = {}): CredentialViewT {
  return {
    id: 'k1',
    vendor: 'anthropic',
    label: 'Work key',
    fingerprint: '…a1b2',
    state: 'ok',
    version: 1,
    lastVerifiedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    referencedBy: [],
    ...over,
  };
}

beforeEach(() => {
  handlers = null;
  listCredentialsQuery = vi.fn().mockResolvedValue([]);
  rotateMutate = vi.fn().mockResolvedValue({ ok: true, credential: cred() });
  forgetMutate = vi.fn().mockResolvedValue({ ok: true });
  usePersistentAgentsStore.setState({ featureStatus: makeStatus() });
});

describe('VendorCredentialsSection', () => {
  it('renders nothing and calls nothing when the feature is off', () => {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus({ enabled: false, running: false }) });
    const { container } = render(<VendorCredentialsSection />);
    expect(container).toBeEmptyDOMElement();
    expect(listCredentialsQuery).not.toHaveBeenCalled();
  });

  it('a killed status (enabled but not running) renders nothing', () => {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus({ enabled: true, killed: true, running: false }) });
    const { container } = render(<VendorCredentialsSection />);
    expect(container).toBeEmptyDOMElement();
    expect(listCredentialsQuery).not.toHaveBeenCalled();
  });

  it('renders nothing while the status is unknown', () => {
    usePersistentAgentsStore.setState({ featureStatus: null });
    const { container } = render(<VendorCredentialsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('an empty list shows the empty copy', async () => {
    render(<VendorCredentialsSection />);
    expect(await screen.findByTestId('vendor-credentials-empty')).toHaveTextContent(
      "No API keys yet. An agent that connects through a vendor API (such as Claude Managed Agents) stores its key here when you connect it. Bridge agents don't need a key.",
    );
  });

  it('a row shows the label, fingerprint and who uses it, and flags an unreadable key', async () => {
    listCredentialsQuery.mockResolvedValue([
      cred({ referencedBy: [{ agentId: 'a', displayName: 'Alpha', connectionId: 'c1' }, { agentId: 'b', displayName: 'Beta', connectionId: 'c2' }] }),
      cred({ id: 'k2', vendor: 'github-pat', label: 'PAT', state: 'undecryptable' }),
    ]);
    render(<VendorCredentialsSection />);
    const row = await screen.findByTestId('credential-row-k1');
    expect(row).toHaveTextContent('Anthropic API key');
    expect(row).toHaveTextContent('Work key');
    expect(row).toHaveTextContent('…a1b2');
    expect(row).toHaveTextContent('Used by Alpha, Beta');
    const second = screen.getByTestId('credential-row-k2');
    expect(second).toHaveTextContent('GitHub token');
    expect(second).toHaveTextContent('Re-enter key');
    expect(second).toHaveTextContent('Not used by any agent');
  });

  it('a rejected or revoked key shows its chip', async () => {
    listCredentialsQuery.mockResolvedValue([cred({ state: 'auth_failed' }), cred({ id: 'k2', state: 'revoked' })]);
    render(<VendorCredentialsSection />);
    await screen.findByTestId('credential-row-k1');
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('Rotate sends the typed secret; the secret never appears in the DOM outside the input and is gone on reopen', async () => {
    listCredentialsQuery.mockResolvedValue([cred()]);
    render(<VendorCredentialsSection />);
    fireEvent.click(await screen.findByTestId('credential-rotate-k1'));
    const input = await screen.findByTestId('credential-secret-input');
    fireEvent.change(input, { target: { value: 'sk-ant-secret-value' } });
    expect(document.body.textContent).not.toContain('sk-ant-secret-value');
    expect(screen.queryByText('sk-ant-secret-value')).toBeNull();
    fireEvent.click(screen.getByTestId('credential-rotate-save'));
    await waitFor(() => expect(rotateMutate).toHaveBeenCalledWith({ id: 'k1', secret: 'sk-ant-secret-value' }));
    await waitFor(() => expect(screen.queryByTestId('credential-secret-input')).toBeNull());
    fireEvent.click(screen.getByTestId('credential-rotate-k1'));
    expect((await screen.findByTestId('credential-secret-input')) as HTMLInputElement).toHaveValue('');
  });

  it('a rejected secret shows the message under the field and keeps the dialog open', async () => {
    listCredentialsQuery.mockResolvedValue([cred()]);
    rotateMutate.mockResolvedValue({ ok: false, error: 'invalid_input', message: 'That does not look like an Anthropic key.', field: 'secret' });
    render(<VendorCredentialsSection />);
    fireEvent.click(await screen.findByTestId('credential-rotate-k1'));
    fireEvent.change(await screen.findByTestId('credential-secret-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('credential-rotate-save'));
    expect(await screen.findByText('That does not look like an Anthropic key.')).toBeInTheDocument();
    expect(screen.getByTestId('credential-secret-input')).toBeInTheDocument();
  });

  it('an unavailable keychain shows its copy and never echoes the secret', async () => {
    listCredentialsQuery.mockResolvedValue([cred()]);
    rotateMutate.mockResolvedValue({ ok: false, error: 'secrets_unavailable', message: 'x' });
    render(<VendorCredentialsSection />);
    fireEvent.click(await screen.findByTestId('credential-rotate-k1'));
    fireEvent.change(await screen.findByTestId('credential-secret-input'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByTestId('credential-rotate-save'));
    const msg = await screen.findByText("This computer's keychain isn't available, so cyboflow can't store this safely.");
    expect(msg.textContent).not.toContain('sk-secret');
  });

  it('forgets a key that is not in use after one confirm', async () => {
    listCredentialsQuery.mockResolvedValue([cred()]);
    render(<VendorCredentialsSection />);
    fireEvent.click(await screen.findByTestId('credential-forget-k1'));
    expect(screen.getByText('Forget Work key?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(forgetMutate).toHaveBeenCalledWith({ id: 'k1' }));
  });

  it('forgetting a key in use asks again, naming the agents, then detaches', async () => {
    const used = cred({ referencedBy: [{ agentId: 'a', displayName: 'Alpha', connectionId: 'c1' }] });
    listCredentialsQuery.mockResolvedValue([used]);
    forgetMutate.mockResolvedValueOnce({
      ok: false, error: 'in_use', message: 'in use', referencedBy: [{ agentId: 'a', displayName: 'Alpha', connectionId: 'c1' }],
    });
    render(<VendorCredentialsSection />);
    fireEvent.click(await screen.findByTestId('credential-forget-k1'));
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await screen.findByText('This key is in use');
    expect(screen.getByText(/Alpha use this key\. If you forget it, they stop until you give them a new key\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget anyway' }));
    await waitFor(() => expect(forgetMutate).toHaveBeenLastCalledWith({ id: 'k1', detach: true }));
  });

  it('a change signal refetches the list', async () => {
    render(<VendorCredentialsSection />);
    await waitFor(() => expect(listCredentialsQuery).toHaveBeenCalled());
    const before = listCredentialsQuery.mock.calls.length;
    listCredentialsQuery.mockResolvedValue([cred()]);
    act(() => handlers?.onData({ kind: 'credentials', agentId: null }));
    await waitFor(() => expect(listCredentialsQuery.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByTestId('credential-row-k1')).toBeInTheDocument();
  });
});
