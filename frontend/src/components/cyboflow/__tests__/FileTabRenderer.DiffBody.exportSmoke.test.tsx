/**
 * Export-smoke test: FileTabRenderer's `DiffBody` (A/B testing slice C reuses it
 * in ExperimentComparisonView for the two frozen per-arm diffs). Confirms the
 * export exists and renders both the unified-hunk and binary paths — a full
 * behavioral suite already lives in FileTabRenderer.test.tsx via the parent tab.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffBody } from '../FileTabRenderer';
import type { ParsedFileDiff } from '../../../utils/parseFileHunks';

const PARSED: ParsedFileDiff = {
  path: 'src/a.ts',
  oldPath: 'src/a.ts',
  type: 'modified',
  isBinary: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: '@@ -1,3 +1,3 @@',
      lines: [
        { oldNo: 1, newNo: 1, kind: 'context', text: 'line1' },
        { oldNo: 2, newNo: null, kind: 'del', text: 'old line' },
        { oldNo: null, newNo: 2, kind: 'add', text: 'new line' },
      ],
    },
  ],
};

const BINARY: ParsedFileDiff = {
  path: 'assets/logo.png',
  oldPath: 'assets/logo.png',
  type: 'modified',
  isBinary: true,
  additions: 0,
  deletions: 0,
  hunks: [],
};

describe('FileTabRenderer — DiffBody export smoke', () => {
  it('is exported and renders the unified hunk grid for a parsed diff', () => {
    render(<DiffBody fileDiff={PARSED} mode="diff" />);
    expect(screen.getByTestId('file-tab-hunks')).toBeInTheDocument();
    expect(screen.getByText(/old line/)).toBeInTheDocument();
    expect(screen.getByText(/new line/)).toBeInTheDocument();
  });

  it('renders the split view when mode="split"', () => {
    render(<DiffBody fileDiff={PARSED} mode="split" />);
    expect(screen.getByText(/old line/)).toBeInTheDocument();
  });

  it('renders the binary fallback for a binary diff', () => {
    render(<DiffBody fileDiff={BINARY} mode="diff" />);
    expect(screen.getByTestId('file-tab-binary')).toBeInTheDocument();
  });
});
