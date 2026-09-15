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

  it('keeps the menu contained within a 640px (rail ceiling) container and the closed label intact', async () => {
    const { container } = render(
      <div data-testid="rail-640" style={{ width: 640 }}>
        <BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />
      </div>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('base-selector-trigger').textContent).toBe('vs branch point · d809dc1');
    });
    expect(container.querySelector('[data-testid="rail-640"]')).toBeTruthy();
    expect(screen.getByTestId('base-selector-vs-label').textContent).toBe('vs branch point');

    await openMenu();
    const menu = screen.getByTestId('base-selector-menu');
    // The menu is anchored to BOTH edges of its rail-width container (never a
    // fixed/min width that could exceed the rail) and clips its own overflow.
    expect(menu.className).toMatch(/\bleft-0\b/);
    expect(menu.className).toMatch(/\bright-0\b/);
    expect(menu.className).toMatch(/\boverflow-hidden\b/);
    expect(menu.className).not.toMatch(/\bmin-w-/);
    expect(screen.getByTestId('rail-640').contains(menu)).toBe(true);
  });

  it('"Another branch" selection: keeps "vs" fixed and puts the (long) branch name in the truncating ref element at 240px', async () => {
    const longBranch = 'feature/an-extremely-long-branch-name-that-cannot-possibly-fit-in-a-240px-rail-column';
    render(
      <div style={{ width: 240 }}>
        <BaseSelector sessionId="s1" projectId="p1" selectedRef={longBranch} onChange={vi.fn()} />
      </div>,
    );
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());

    const vsLabel = screen.getByTestId('base-selector-vs-label');
    // The non-shrinking, nowrap span must NOT carry the long branch name.
    expect(vsLabel.className).toMatch(/shrink-0/);
    expect(vsLabel.textContent).not.toContain(longBranch);
    expect(vsLabel.textContent).toBe('vs branch');

    const refEl = screen.getByTestId('base-selector-ref');
    expect(refEl.textContent).toBe(longBranch);
    expect(refEl.className).toMatch(/truncate/);
    expect(refEl.getAttribute('title')).toBe(longBranch);
  });

  it('re-queries branches for a NEW projectId on the same mount and drops a stale in-flight response for the old one', async () => {
    let resolveP1: (v: typeof BRANCH_LIST) => void = () => {};
    const p1Pending = new Promise<typeof BRANCH_LIST>((resolve) => {
      resolveP1 = resolve;
    });
    mockListBranches.mockImplementation((projectId: string) =>
      projectId === 'p1'
        ? p1Pending
        : Promise.resolve({
            success: true,
            data: [{ name: 'p2-only-branch', isCurrent: false, hasWorktree: false }],
          }),
    );

    const { rerender } = render(
      <BaseSelector sessionId="s1" projectId="p1" selectedRef={null} onChange={vi.fn()} />,
    );
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    await openMenu();
    fireEvent.click(screen.getByTestId('base-selector-option-another-branch'));
    await waitFor(() => expect(mockListBranches).toHaveBeenCalledWith('p1'));

    // Switch project while p1's request is still in flight. The menu itself
    // stays open across the switch; only the "Another branch" sub-panel (and
    // its cache) is reset, so it must be re-expanded.
    rerender(<BaseSelector sessionId="s1" projectId="p2" selectedRef={null} onChange={vi.fn()} />);
    expect(screen.getByTestId('base-selector-menu')).toBeTruthy();
    expect(screen.queryByTestId('base-selector-another-branch-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('base-selector-option-another-branch'));
    await waitFor(() => expect(mockListBranches).toHaveBeenCalledWith('p2'));
    expect(mockListBranches).toHaveBeenCalledTimes(2);
    await screen.findByText('p2-only-branch');

    // p1's late response must NOT populate p2's menu.
    resolveP1(BRANCH_LIST);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText('feature/foo')).toBeNull();
    expect(screen.getByText('p2-only-branch')).toBeTruthy();
  });

  it('uses the lifted resolvedDefaultBase (not the session branchPoint) for the branch-point short SHA, and enables Branch point from it alone', async () => {
    mockGetComparisonBases.mockResolvedValue(NO_DEFAULT_BASES);
    const { rerender } = render(
      <BaseSelector
        sessionId="s1"
        projectId="p1"
        selectedRef={null}
        onChange={vi.fn()}
        resolvedDefaultBase="0123456789abcdef0123456789abcdef01234567"
      />,
    );
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalled());
    // Closed label: the run/panel base's short SHA, not the session's d809dc1.
    await waitFor(() => {
      expect(screen.getByTestId('base-selector-trigger').textContent).toBe('vs branch point · 0123456');
    });
    await openMenu();
    const branchPoint = screen.getByTestId('base-selector-option-branch-point') as HTMLButtonElement;
    expect(branchPoint.textContent).toContain('0123456');
    expect(branchPoint.disabled).toBe(false);

    // A session with NO baseCommit but a run with a launch base: still selectable.
    mockGetComparisonBases.mockResolvedValue({
      success: true,
      data: { branchPoint: null, defaultBranch: null, localDefault: null, originDefault: null },
    });
    rerender(
      <BaseSelector
        sessionId="s2"
        projectId="p1"
        selectedRef="origin/main"
        onChange={vi.fn()}
        resolvedDefaultBase="fedcba9876543210fedcba9876543210fedcba98"
      />,
    );
    await waitFor(() => expect(mockGetComparisonBases).toHaveBeenCalledWith({ sessionId: 's2' }));
    // The menu is still open from above (open state survives a rerender).
    await screen.findByTestId('base-selector-menu');
    const branchPoint2 = screen.getByTestId('base-selector-option-branch-point') as HTMLButtonElement;
    expect(branchPoint2.disabled).toBe(false);
    expect(branchPoint2.textContent).toContain('fedcba9');
  });
});
