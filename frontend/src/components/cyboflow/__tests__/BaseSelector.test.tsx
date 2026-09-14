import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- trpc mock (mirrors SessionFileExplorer.test.tsx's pattern) ------------
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      sessionGit: {
        getComparisonBases: { query: vi.fn() },
      },
    },
  },
}));

// --- API mock ---------------------------------------------------------------
vi.mock('../../../utils/api', () => ({
  API: {
    projects: {
      listBranches: vi.fn(),
    },
  },
}));

import { BaseSelector } from '../BaseSelector';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';

const mockGetComparisonBases = vi.mocked(trpc.cyboflow.sessionGit.getComparisonBases.query);
const mockListBranches = vi.mocked(API.projects.listBranches);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_BASES = {
  success: true as const,
  data: {
    branchPoint: { ref: 'abc123def456', shortSha: 'd809dc1' },
    defaultBranch: 'main',
    localDefault: { ref: 'main', behind: 3 },
    originDefault: { ref: 'origin/main', behind: 5, fetchedAt: new Date().toISOString() },
  },
};

const TRUNK_BASES = {
  success: true as const,
  data: {
    branchPoint: { ref: 'abc123def456', shortSha: 'd809dc1' },
    defaultBranch: 'trunk',
    localDefault: { ref: 'trunk', behind: 0 },
    originDefault: { ref: 'origin/trunk', behind: 0, fetchedAt: new Date().toISOString() },
  },
};

const NO_DEFAULT_BASES = {
  success: true as const,
  data: {
    branchPoint: { ref: 'abc123def456', shortSha: 'd809dc1' },
    defaultBranch: null,
    localDefault: null,
    originDefault: null,
  },
};

const BRANCH_LIST = {
  success: true,
  data: [
    { name: 'main', isCurrent: true, hasWorktree: false },
    { name: 'feature/foo', isCurrent: false, hasWorktree: false },
    { name: '(HEAD detached at abc123)', isCurrent: false, hasWorktree: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetComparisonBases.mockResolvedValue(DEFAULT_BASES);
  mockListBranches.mockResolvedValue(BRANCH_LIST);
});

async function openMenu() {
  fireEvent.click(screen.getByTestId('base-selector-trigger'));
  await screen.findByTestId('base-selector-menu');
}

describe('BaseSelector', () => {
  it('renders the closed-state default label as "vs <label> · <shortSha>"', async () => {
    render(
      <BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('base-selector-trigger').textContent).toBe('vs branch point · d809dc1');
    });
  });

  it('opens the menu on click and lists exactly four entries', async () => {
    render(
      <BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />,
    );
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalledWith({ sessionId: 's1' }));
    await openMenu();

    expect(screen.getByTestId('base-selector-option-branch-point')).toBeTruthy();
    expect(screen.getByTestId('base-selector-option-local-default')).toBeTruthy();
    expect(screen.getByTestId('base-selector-option-origin-default')).toBeTruthy();
    expect(screen.getByTestId('base-selector-option-another-branch')).toBeTruthy();
  });

  it('selecting "Branch point" calls onChange(null)', async () => {
    const onChange = vi.fn();
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef="main" onChange={onChange} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    fireEvent.click(screen.getByTestId('base-selector-option-branch-point'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('selecting the local-default entry calls onChange with its ref', async () => {
    const onChange = vi.fn();
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={onChange} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    fireEvent.click(screen.getByTestId('base-selector-option-local-default'));
    expect(onChange).toHaveBeenCalledWith('main');
  });

  it('selecting the origin-default entry calls onChange with its ref, and issues no extra query', async () => {
    const onChange = vi.fn();
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={onChange} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalledTimes(1));
    await openMenu();

    fireEvent.click(screen.getByTestId('base-selector-option-origin-default'));
    expect(onChange).toHaveBeenCalledWith('origin/main');

    // No additional query/mutation beyond the one mount-time fetch — selecting
    // origin is a pure read of already-fetched data, never a git fetch.
    expect(mockGetComparisonBases).toHaveBeenCalledTimes(1);
    expect(mockListBranches).not.toHaveBeenCalled();
  });

  it('selecting a filtered "Another branch" entry calls onChange with that branch name', async () => {
    const onChange = vi.fn();
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={onChange} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    fireEvent.click(screen.getByTestId('base-selector-option-another-branch'));
    await waitFor(() => expect(mockListBranches).toHaveBeenCalledWith('p1'));
    await screen.findByTestId('base-selector-branch-filter');

    fireEvent.change(screen.getByTestId('base-selector-branch-filter'), {
      target: { value: 'feature' },
    });

    const branchOption = await screen.findByText('feature/foo');
    fireEvent.click(branchOption);
    expect(onChange).toHaveBeenCalledWith('feature/foo');
  });

  it('never renders the detached-HEAD placeholder as a selectable branch', async () => {
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    fireEvent.click(screen.getByTestId('base-selector-option-another-branch'));
    await waitFor(() => expect(mockListBranches).toHaveBeenCalled());
    await screen.findByTestId('base-selector-branch-filter');

    expect(screen.queryByText(/HEAD detached/)).toBeNull();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('feature/foo')).toBeTruthy();
  });

  it('uses the RESOLVED default branch name ("trunk"), never a hardcoded "main"', async () => {
    mockGetComparisonBases.mockResolvedValue(TRUNK_BASES);
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    expect(screen.getByText('trunk (local)')).toBeTruthy();
    expect(screen.getByText('origin/trunk')).toBeTruthy();
    expect(screen.queryByText(/^main \(local\)$/)).toBeNull();
    expect(screen.queryByText('origin/main')).toBeNull();
  });

  it('disables the local and origin entries (with a title) when defaultBranch is null', async () => {
    mockGetComparisonBases.mockResolvedValue(NO_DEFAULT_BASES);
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    const local = screen.getByTestId('base-selector-option-local-default') as HTMLButtonElement;
    const origin = screen.getByTestId('base-selector-option-origin-default') as HTMLButtonElement;
    expect(local.disabled).toBe(true);
    expect(local.getAttribute('title')).toBeTruthy();
    expect(origin.disabled).toBe(true);
    expect(origin.getAttribute('title')).toBeTruthy();
  });

  it('disables "Another branch" (with a title) when projectId is null', async () => {
    render(<BaseSelector sessionId="s1" projectId={null} selectedRef={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();

    const anotherBranch = screen.getByTestId('base-selector-option-another-branch') as HTMLButtonElement;
    expect(anotherBranch.disabled).toBe(true);
    expect(anotherBranch.getAttribute('title')).toBeTruthy();

    fireEvent.click(anotherBranch);
    expect(mockListBranches).not.toHaveBeenCalled();
  });

  it('disables the trigger when sessionId is null and never calls getComparisonBases', async () => {
    render(<BaseSelector sessionId={null} projectId="p1" selectedRef={null} onChange={vi.fn()} />);

    const trigger = screen.getByTestId('base-selector-trigger') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(mockGetComparisonBases).not.toHaveBeenCalled();
  });

  it('degrades to disabled entries (never crashes) when getComparisonBases rejects', async () => {
    mockGetComparisonBases.mockRejectedValue(new Error('boom'));
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalledWith({ sessionId: 's1' }));
    await openMenu();

    const branchPoint = screen.getByTestId('base-selector-option-branch-point') as HTMLButtonElement;
    const local = screen.getByTestId('base-selector-option-local-default') as HTMLButtonElement;
    const origin = screen.getByTestId('base-selector-option-origin-default') as HTMLButtonElement;
    expect(branchPoint.disabled).toBe(true);
    expect(local.disabled).toBe(true);
    expect(origin.disabled).toBe(true);
  });

  it('degrades to disabled entries (never crashes) when getComparisonBases resolves { success: false }', async () => {
    mockGetComparisonBases.mockResolvedValue({ success: false, error: 'precondition failed' });
    render(<BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />);
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalledWith({ sessionId: 's1' }));
    await openMenu();

    const branchPoint = screen.getByTestId('base-selector-option-branch-point') as HTMLButtonElement;
    const local = screen.getByTestId('base-selector-option-local-default') as HTMLButtonElement;
    const origin = screen.getByTestId('base-selector-option-origin-default') as HTMLButtonElement;
    expect(branchPoint.disabled).toBe(true);
    expect(local.disabled).toBe(true);
    expect(origin.disabled).toBe(true);
  });

  it('keeps the "vs" label intact and truncates only the ref at a 240px container width', async () => {
    const { container } = render(
      <div style={{ width: 240 }}>
        <BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('base-selector-trigger').textContent).toBe('vs branch point · d809dc1');
    });

    expect(container.querySelector('[style]')).toBeTruthy();
    expect(screen.getByTestId('base-selector-vs-label').textContent).toBe('vs branch point');

    const refEl = screen.getByTestId('base-selector-ref');
    expect(refEl.className).toMatch(/truncate/);
    expect(refEl.getAttribute('title')).toBe('d809dc1');
  });
});
