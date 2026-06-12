/**
 * CodeQualitySection bucketing + status-chip tests.
 *
 * The insights store is mocked to supply a fixed `qualityFindings` array; the
 * REAL shared `classifyQualityFinding` runs (not mocked) so this asserts the
 * component routes each finding to the column the shared rule dictates. Fixtures
 * are crafted so exactly one finding lands in each of the three buckets:
 *
 *   in_workflow   — plain finding, no verification step, not merged/categorized.
 *   verification  — sourceStep matches /verify|review|test/i.
 *   post_merge    — runOutcome='merged' AND createdAt > runEndedAt (the time rule).
 *
 * Plus the status-chip mapping (pending → OPEN / resolved → RESOLVED /
 * dismissed → DISMISSED) and the severity-dot + empty-column placeholder.
 */
import '@testing-library/jest-dom';
import { cleanup, render, screen, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QualityFinding } from '../../../../../shared/types/insights';
import {
  parseResolutionKind,
  RESOLUTION_PREFIX_PROMOTED,
  RESOLUTION_PREFIX_FIXED,
  RESOLUTION_PREFIX_TRIAGED,
} from '../../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Store mock — only qualityFindings matters for this section.
// ---------------------------------------------------------------------------

let mockQualityFindings: QualityFinding[] = [];

function snapshot() {
  return { qualityFindings: mockQualityFindings };
}

vi.mock('../../../stores/insightsStore', () => {
  const useInsightsStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector(snapshot());
  useInsightsStore.getState = () => snapshot();
  return { useInsightsStore };
});

import { CodeQualitySection } from '../CodeQualitySection';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function finding(over: Partial<QualityFinding> = {}): QualityFinding {
  return {
    id: 'qf',
    projectId: 1,
    title: 'A finding',
    severity: 'info',
    status: 'pending',
    source: 'agent:executor',
    sourceStep: 'executor',
    category: null,
    locations: [],
    createdAt: '2026-06-10T00:00:00.000Z',
    resolution: null,
    runId: 'run-1',
    runOutcome: null,
    runEndedAt: null,
    workflowName: 'Sprint',
    ...over,
  };
}

beforeEach(() => {
  mockQualityFindings = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeQualitySection bucketing', () => {
  it('routes exactly one finding into each of the three columns', () => {
    mockQualityFindings = [
      // in_workflow — plain executor step, no merge / category.
      finding({ id: 'qf-in', title: 'In-flow issue', sourceStep: 'executor' }),
      // verification — step id matches /verify|review|test/i.
      finding({ id: 'qf-verify', title: 'Caught at verify', sourceStep: 'verify-step' }),
      // post_merge — merged run, created after it ended.
      finding({
        id: 'qf-post',
        title: 'Regression after merge',
        sourceStep: 'executor',
        runOutcome: 'merged',
        runEndedAt: '2026-06-10T00:00:00.000Z',
        createdAt: '2026-06-11T00:00:00.000Z',
      }),
    ];
    render(<CodeQualitySection />);

    const inCol = screen.getByTestId('quality-column-in_workflow');
    const verifyCol = screen.getByTestId('quality-column-verification');
    const postCol = screen.getByTestId('quality-column-post_merge');

    expect(within(inCol).getByText('In-flow issue')).toBeInTheDocument();
    expect(within(verifyCol).getByText('Caught at verify')).toBeInTheDocument();
    expect(within(postCol).getByText('Regression after merge')).toBeInTheDocument();

    // Count badges reflect one each.
    expect(within(inCol).getByTestId('quality-column-count')).toHaveTextContent('1');
    expect(within(verifyCol).getByTestId('quality-column-count')).toHaveTextContent('1');
    expect(within(postCol).getByTestId('quality-column-count')).toHaveTextContent('1');
  });

  it('honors the explicit post-merge category over the verification step', () => {
    mockQualityFindings = [
      finding({
        id: 'qf-cat',
        title: 'Explicitly post-merge',
        sourceStep: 'verify', // would otherwise be verification
        category: 'post-merge-bug',
      }),
    ];
    render(<CodeQualitySection />);
    const postCol = screen.getByTestId('quality-column-post_merge');
    expect(within(postCol).getByText('Explicitly post-merge')).toBeInTheDocument();
    expect(within(screen.getByTestId('quality-column-verification')).queryByText('Explicitly post-merge')).toBeNull();
  });

  it('maps finding status to the OPEN / RESOLVED / DISMISSED chips', () => {
    mockQualityFindings = [
      finding({ id: 'qf-p', title: 'Pending one', status: 'pending', sourceStep: 'executor' }),
      finding({ id: 'qf-r', title: 'Resolved one', status: 'resolved', sourceStep: 'executor' }),
      finding({ id: 'qf-d', title: 'Dismissed one', status: 'dismissed', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);
    const chips = screen.getAllByTestId('quality-status-chip').map((n) => n.textContent);
    expect(chips).toContain('Open');
    expect(chips).toContain('Resolved');
    expect(chips).toContain('Dismissed');
  });

  // Helper: render a single finding and read back its one chip. Calls cleanup()
  // first so the tests that invoke chipFor twice in one it() do not leave two
  // renders mounted in document.body (getByTestId would then throw on the
  // duplicate chip — RTL's afterEach cleanup only runs between it() blocks).
  function chipFor(over: Partial<QualityFinding>): string | null {
    cleanup();
    mockQualityFindings = [finding({ id: 'qf-chip', sourceStep: 'executor', ...over })];
    render(<CodeQualitySection />);
    return screen.getByTestId('quality-status-chip').textContent;
  }

  it('refines a resolved chip by its resolution prefix (FIXED / TRIAGED / PROMOTED)', () => {
    // Each resolved item carries a prefixed resolution; the chip text reflects the
    // parseResolutionKind classification (the full prefix matrix, via the component).
    expect(chipFor({ status: 'resolved', resolution: 'fixed:patched the null guard' })).toBe('Fixed');
  });

  it('maps a triaged: resolution to the TRIAGED chip', () => {
    expect(chipFor({ status: 'resolved', resolution: 'triaged:dispositioned, no code change' })).toBe('Triaged');
  });

  it('maps a promoted: resolution to the PROMOTED chip', () => {
    expect(chipFor({ status: 'resolved', resolution: 'promoted:tsk_abc123' })).toBe('Promoted');
  });

  it('falls back to RESOLVED for a free-text (unprefixed) resolution and for a null resolution', () => {
    expect(chipFor({ status: 'resolved', resolution: 'looked at it, fine as-is' })).toBe('Resolved');
    expect(chipFor({ status: 'resolved', resolution: null })).toBe('Resolved');
  });

  it('ignores the resolution prefix for pending / dismissed items (status wins)', () => {
    // A stray resolution on a non-resolved item must NOT change the OPEN/DISMISSED chip.
    expect(chipFor({ status: 'pending', resolution: 'fixed:should be ignored' })).toBe('Open');
    expect(chipFor({ status: 'dismissed', resolution: 'promoted:should be ignored' })).toBe('Dismissed');
  });

  it('renders the location path · sourceStep · workflowName meta line', () => {
    mockQualityFindings = [
      finding({
        id: 'qf-meta',
        title: 'Has meta',
        sourceStep: 'executor',
        workflowName: 'Sprint',
        locations: [{ path: 'src/foo.ts', line: 42 }],
      }),
    ];
    render(<CodeQualitySection />);
    const row = screen.getByTestId('quality-finding-row');
    expect(within(row).getByText('src/foo.ts · executor · Sprint')).toBeInTheDocument();
  });

  it('shows a quiet placeholder for empty columns', () => {
    mockQualityFindings = [
      finding({ id: 'qf-only', title: 'Only in-flow', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);
    // in_workflow column has the item, the other two are empty.
    expect(screen.getAllByTestId('quality-column-empty')).toHaveLength(2);
  });

  it('applies the severity dot color class per severity', () => {
    mockQualityFindings = [
      finding({ id: 'qf-err', title: 'Error sev', severity: 'error', sourceStep: 'executor' }),
    ];
    render(<CodeQualitySection />);
    const dot = screen.getByTestId('quality-severity-dot');
    expect(dot.className).toContain('bg-status-error');
  });
});

// ---------------------------------------------------------------------------
// parseResolutionKind matrix — the shared classifier the chip mapping keys on.
// ---------------------------------------------------------------------------

describe('parseResolutionKind', () => {
  it('returns null for a null (still-pending) resolution', () => {
    expect(parseResolutionKind(null)).toBeNull();
  });

  it('classifies each known prefix', () => {
    expect(parseResolutionKind(`${RESOLUTION_PREFIX_PROMOTED}tsk_1`)).toBe('promoted');
    expect(parseResolutionKind(`${RESOLUTION_PREFIX_FIXED}patched`)).toBe('fixed');
    expect(parseResolutionKind(`${RESOLUTION_PREFIX_TRIAGED}reviewed`)).toBe('triaged');
  });

  it('classifies a prefix with an empty note (the colon alone is enough)', () => {
    expect(parseResolutionKind(RESOLUTION_PREFIX_FIXED)).toBe('fixed');
  });

  it("returns 'other' for free-text and unknown-prefix resolutions", () => {
    expect(parseResolutionKind('looks fine to me')).toBe('other');
    expect(parseResolutionKind('wontfix:later')).toBe('other');
    expect(parseResolutionKind('')).toBe('other');
    // Prefix must be LEADING — a mid-string occurrence does not match.
    expect(parseResolutionKind('see fixed: note below')).toBe('other');
  });
});
