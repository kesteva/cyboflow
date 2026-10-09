import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeHost } from './fixtures';

let addMutate: ReturnType<typeof vi.fn>;
let updateMutate: ReturnType<typeof vi.fn>;
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      hosts: {
        add: { get mutate() { return addMutate; } },
        update: { get mutate() { return updateMutate; } },
        list: { query: vi.fn().mockResolvedValue([]) },
      },
    },
  },
}));

import { AddEnvironmentDialog, validateSshTarget, validateEnvironmentName } from '../AddEnvironmentDialog';

beforeEach(() => {
  addMutate = vi.fn().mockResolvedValue({ ok: true, id: 'h9' });
  updateMutate = vi.fn().mockResolvedValue({ ok: true });
});

const fill = (name: string, target: string): void => {
  fireEvent.change(screen.getByTestId('add-environment-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('add-environment-target'), { target: { value: target } });
};

describe('AddEnvironmentDialog', () => {
  it('validators', () => {
    expect(validateSshTarget('-oProxyCommand=x')).not.toBeNull();
    expect(validateSshTarget('user@host')).toBeNull();
    expect(validateSshTarget('my-alias')).toBeNull();
    expect(validateSshTarget('a b')).not.toBeNull();
    expect(validateEnvironmentName('  ')).not.toBeNull();
    expect(validateEnvironmentName('x'.repeat(49))).not.toBeNull();
    expect(validateEnvironmentName('Build box')).toBeNull();
  });

  it('blocks an invalid submit and shows field errors', () => {
    render(<AddEnvironmentDialog isOpen onClose={vi.fn()} />);
    fill('', '-bad');
    fireEvent.click(screen.getByTestId('add-environment-submit'));
    expect(addMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(screen.getByText('Use an ssh config alias or user@host.')).toBeInTheDocument();
  });

  it('adds with trimmed values and closes', async () => {
    const onClose = vi.fn();
    render(<AddEnvironmentDialog isOpen onClose={onClose} />);
    fill('  Build box ', ' me@10.0.0.5 ');
    fireEvent.click(screen.getByTestId('add-environment-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(addMutate).toHaveBeenCalledWith({ label: 'Build box', sshTarget: 'me@10.0.0.5' });
  });

  it('keeps the dialog open and shows a server failure', async () => {
    addMutate.mockResolvedValue({ ok: false, error: 'label_taken', message: 'That name is taken.' });
    const onClose = vi.fn();
    render(<AddEnvironmentDialog isOpen onClose={onClose} />);
    fill('Build box', 'build');
    fireEvent.click(screen.getByTestId('add-environment-submit'));
    expect(await screen.findByTestId('add-environment-failure')).toHaveTextContent('That name is taken.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('edit mode sends only changed fields', async () => {
    const onClose = vi.fn();
    render(<AddEnvironmentDialog isOpen onClose={onClose} host={makeHost()} />);
    fireEvent.change(screen.getByTestId('add-environment-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('add-environment-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateMutate).toHaveBeenCalledWith({ id: 'h2', label: 'Renamed' });
    expect(addMutate).not.toHaveBeenCalled();
  });
});
