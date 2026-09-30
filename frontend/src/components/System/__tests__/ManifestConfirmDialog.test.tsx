import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ManifestConfirmDialog } from '../ManifestConfirmDialog';
import { formatManifestBytes } from '../formatManifestBytes';
import type { ManifestConfirmData } from '../ManifestConfirmDialog';
import { KillProcessConfirmDialog } from '../KillProcessConfirmDialog';

const manifest: ManifestConfirmData = {
  id: 'man-1',
  reclaimableBytes: 3 * 1024 * 1024 * 1024,
  targets: [
    {
      id: 'wt-1',
      kind: 'worktree',
      name: 'agent-sprint-1',
      detail: '/tmp/wt/agent-sprint-1',
      dirtyFileCount: 4,
      aheadOfMainCount: 2,
    },
    { id: 'p-1', kind: 'process', name: 'codex app-server', detail: 'pid 4242', descendantPidCount: 7, taggedAsCyboflow: true },
  ],
};

function setup(overrides: Partial<React.ComponentProps<typeof ManifestConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ManifestConfirmDialog
      isOpen
      manifest={manifest}
      title="Reap 2 targets?"
      confirmText="Reap"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ManifestConfirmDialog', () => {
  it('renders nothing when closed', () => {
    setup({ isOpen: false });
    expect(screen.queryByTestId('manifest-confirm-dialog')).not.toBeInTheDocument();
  });

  it('renders every manifest field', () => {
    setup();
    expect(screen.getByText('Reap 2 targets?')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-confirm-subtitle')).toHaveTextContent('2 targets · 3 GB reclaimable');
    expect(screen.getByText('agent-sprint-1')).toBeInTheDocument();
    expect(screen.getByText('/tmp/wt/agent-sprint-1')).toBeInTheDocument();
    expect(screen.getByText('codex app-server')).toBeInTheDocument();
    expect(screen.getByText('pid 4242')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-target-wt-1')).toHaveAttribute('data-kind', 'worktree');
    expect(screen.getByTestId('manifest-target-p-1')).toHaveAttribute('data-kind', 'process');
    expect(screen.getByText('4 dirty files')).toBeInTheDocument();
    expect(screen.getByText('2 ahead of main')).toBeInTheDocument();
    expect(screen.getByText('7 descendant PIDs')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-dirty-warning')).toHaveTextContent(
      'Pruning discards them permanently — nothing is stashed',
    );
    expect(screen.getByTestId('manifest-ahead-warning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reap' })).toBeInTheDocument();
  });

  it('omits the warnings when nothing is dirty or ahead', () => {
    setup({ manifest: { ...manifest, targets: [{ id: 'wt-2', kind: 'worktree', name: 'clean', dirtyFileCount: 0, aheadOfMainCount: 0 }] } });
    expect(screen.queryByTestId('manifest-dirty-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manifest-ahead-warning')).not.toBeInTheDocument();
  });

  it('defaults Also delete branch to unchecked and passes the state through', () => {
    const { onConfirm } = setup();
    const box = screen.getByLabelText('Also delete branch') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reap' }));
    expect(onConfirm).toHaveBeenLastCalledWith(manifest, { deleteBranch: false });

    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Reap' }));
    expect(onConfirm).toHaveBeenLastCalledWith(manifest, { deleteBranch: true });
    // Exact object identity, not a copy.
    expect(onConfirm.mock.calls[1][0]).toBe(manifest);
  });

  it('Esc cancels without confirming', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('bare Enter does not confirm', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('hides the branch checkbox when there is no worktree target', () => {
    setup({ manifest: { id: 'm2', reclaimableBytes: null, targets: [manifest.targets[1]] } });
    expect(screen.queryByLabelText('Also delete branch')).not.toBeInTheDocument();
    expect(screen.getByTestId('manifest-confirm-subtitle')).toHaveTextContent('1 target');
    expect(screen.getByTestId('manifest-confirm-subtitle')).not.toHaveTextContent('reclaimable');
  });
});

describe('formatManifestBytes', () => {
  it('formats across units', () => {
    expect(formatManifestBytes(0)).toBe('0 B');
    expect(formatManifestBytes(1536)).toBe('1.5 KB');
    expect(formatManifestBytes(312 * 1024 * 1024)).toBe('312 MB');
  });
});

describe('KillProcessConfirmDialog', () => {
  const warning = "This process is not tagged as cyboflow's — killing it may affect other software";
  const proc = (tagged: boolean | undefined): ManifestConfirmData => ({
    id: 'kill-1',
    reclaimableBytes: null,
    targets: [{ id: 'p-9', kind: 'process', name: 'node', detail: 'pid 9', descendantPidCount: 2, taggedAsCyboflow: tagged }],
  });

  it('shows the warning and Kill anyway when the target is untagged', () => {
    const onConfirm = vi.fn();
    const m = proc(false);
    render(<KillProcessConfirmDialog isOpen manifest={m} title="Kill process tree?" onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Kill anyway' }));
    expect(onConfirm).toHaveBeenCalledWith(m, { deleteBranch: false });
  });

  it('never shows the warning when the target is tagged', () => {
    render(<KillProcessConfirmDialog isOpen manifest={proc(true)} title="Kill process tree?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kill anyway' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kill tree' })).toBeInTheDocument();
  });

  it('does not show the branch checkbox', () => {
    render(<KillProcessConfirmDialog isOpen manifest={proc(false)} title="Kill?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Also delete branch')).not.toBeInTheDocument();
  });

  it('Enter does not confirm and Esc cancels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<KillProcessConfirmDialog isOpen manifest={proc(false)} title="Kill?" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
