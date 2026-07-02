/**
 * CreateProjectDialog — the shared "Add New Project" form.
 *
 * Covers: empty path/name blocks create (disabled + guarded); a path change runs
 * detectBranch and surfaces the branch; create always sends active:false; a
 * rejected create keeps the dialog open + routes the error to the error store; the
 * demo-mode prefill fills untouched name/path.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockCreate, mockDetectBranch, mockOpenDirectory, mockDemoGetInfo, mockShowError, mockTrackEvent } =
  vi.hoisted(() => ({
    mockCreate: vi.fn(),
    mockDetectBranch: vi.fn(),
    mockOpenDirectory: vi.fn(),
    mockDemoGetInfo: vi.fn(),
    mockShowError: vi.fn(),
    mockTrackEvent: vi.fn(),
  }));

vi.mock('../../utils/api', () => ({
  API: {
    projects: {
      create: (...a: unknown[]) => mockCreate(...a),
      detectBranch: (...a: unknown[]) => mockDetectBranch(...a),
    },
    dialog: { openDirectory: (...a: unknown[]) => mockOpenDirectory(...a) },
    demo: { getInfo: () => mockDemoGetInfo() },
  },
}));

vi.mock('../../utils/telemetry', () => ({ trackEvent: mockTrackEvent }));

vi.mock('../../stores/errorStore', () => ({
  useErrorStore: () => ({ showError: mockShowError }),
}));

import { CreateProjectDialog } from '../CreateProjectDialog';

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ success: true, data: { id: 5, name: 'Proj', path: '/p' } });
  mockDetectBranch.mockReset().mockResolvedValue({ success: true, data: 'trunk' });
  mockOpenDirectory.mockReset().mockResolvedValue({ success: false });
  // Default: not in demo mode.
  mockDemoGetInfo.mockReset().mockResolvedValue({ success: true, data: { demoMode: false } });
  mockShowError.mockReset();
  mockTrackEvent.mockReset();
});

async function flushDemoEffect() {
  // Let the mount-time demo.getInfo().then(...) settle so it doesn't bleed into
  // the assertion below.
  await waitFor(() => expect(mockDemoGetInfo).toHaveBeenCalled());
}

describe('CreateProjectDialog', () => {
  it('disables Create until both name and path are present', async () => {
    render(<CreateProjectDialog isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await flushDemoEffect();
    const createBtn = screen.getByRole('button', { name: /create project/i });
    expect(createBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Enter project name'), { target: { value: 'My Proj' } });
    expect(createBtn).toBeDisabled(); // path still empty
    fireEvent.change(screen.getByPlaceholderText('/path/to/your/repository'), { target: { value: '/repo' } });
    expect(createBtn).not.toBeDisabled();
  });

  it('runs detectBranch on a path change and shows the detected branch', async () => {
    render(<CreateProjectDialog isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await flushDemoEffect();
    fireEvent.change(screen.getByPlaceholderText('/path/to/your/repository'), { target: { value: '/repo' } });
    expect(mockDetectBranch).toHaveBeenCalledWith('/repo');
    expect(await screen.findByText('trunk')).toBeInTheDocument();
  });

  it('sends active:false on create, tracks, and calls onCreated + onClose on success', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateProjectDialog isOpen onClose={onClose} onCreated={onCreated} />);
    await flushDemoEffect();
    fireEvent.change(screen.getByPlaceholderText('Enter project name'), { target: { value: 'My Proj' } });
    fireEvent.change(screen.getByPlaceholderText('/path/to/your/repository'), { target: { value: '/repo' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ name: 'My Proj', path: '/repo', active: false });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 5, name: 'Proj', path: '/p' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith('project_created', {});
  });

  it('keeps the dialog open and routes a rejected create to the error store', async () => {
    mockCreate.mockRejectedValue(new Error('not a git repo'));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateProjectDialog isOpen onClose={onClose} onCreated={onCreated} />);
    await flushDemoEffect();
    fireEvent.change(screen.getByPlaceholderText('Enter project name'), { target: { value: 'My Proj' } });
    fireEvent.change(screen.getByPlaceholderText('/path/to/your/repository'), { target: { value: '/repo' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(mockShowError).toHaveBeenCalled());
    expect(mockShowError.mock.calls[0][0]).toMatchObject({ title: 'Failed to Create Project', error: 'not a git repo' });
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('prefills the sandbox project name + path when demo mode is on', async () => {
    mockDemoGetInfo.mockResolvedValue({
      success: true,
      data: { demoMode: true, sandboxPath: '/demo/sandbox', projectName: 'Sandbox' },
    });
    render(<CreateProjectDialog isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Enter project name') as HTMLInputElement).value).toBe('Sandbox'),
    );
    expect((screen.getByPlaceholderText('/path/to/your/repository') as HTMLInputElement).value).toBe('/demo/sandbox');
  });
});
