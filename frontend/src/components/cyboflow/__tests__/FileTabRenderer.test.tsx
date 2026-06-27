/**
 * FileTabRenderer tests — center-pane file/diff tab.
 *
 * Drives each useFileDiffData state (loading / error / binary / parsed diff) and
 * the no-diff fallback to plain file contents (useFileContentData), asserting the
 * header (filename, ± counts), the 3-col hunk grid, and the content view render.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileTabRenderer } from '../FileTabRenderer';
import { useFileDiffData, type FileDiffData } from '../../../hooks/useFileDiffData';
import { useFileContentData, type FileContentData } from '../../../hooks/useFileContentData';
import type { ParsedFileDiff } from '../../../utils/parseFileHunks';

vi.mock('../../../hooks/useFileDiffData', () => ({ useFileDiffData: vi.fn() }));
vi.mock('../../../hooks/useFileContentData', () => ({ useFileContentData: vi.fn() }));
const mockHook = vi.mocked(useFileDiffData);
const mockContentHook = vi.mocked(useFileContentData);

function setHook(value: FileDiffData): void {
  mockHook.mockReturnValue(value);
}

function setContentHook(value: FileContentData): void {
  mockContentHook.mockReturnValue(value);
}

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
        { oldNo: 3, newNo: 3, kind: 'context', text: 'line3' },
      ],
    },
  ],
};

describe('FileTabRenderer', () => {
  beforeEach(() => {
    mockHook.mockReset();
    mockContentHook.mockReset();
    // Default the content hook so diff-path tests (which never reach the
    // content fallback) still have a defined return.
    setContentHook({ loading: false, error: null, content: null });
  });

  it('shows the loading state', () => {
    setHook({ loading: true, error: null, fileDiff: null });
    render(<FileTabRenderer sessionId="s1" filePath="src/a.ts" />);
    expect(screen.getByTestId('file-tab-loading')).toBeInTheDocument();
  });

  it('shows the error state', () => {
    setHook({ loading: false, error: 'boom', fileDiff: null });
    render(<FileTabRenderer sessionId="s1" filePath="src/a.ts" />);
    expect(screen.getByTestId('file-tab-error')).toHaveTextContent('boom');
  });

  it('falls back to the file contents when the file has no diff', () => {
    setHook({ loading: false, error: null, fileDiff: null });
    setContentHook({
      loading: false,
      error: null,
      content: { path: 'src/a.ts', content: 'hello world', size: 11, unviewableReason: null },
    });
    render(<FileTabRenderer sessionId="s1" filePath="src/a.ts" />);
    expect(screen.getByTestId('file-tab-content')).toHaveTextContent('hello world');
    expect(screen.queryByTestId('file-tab-empty')).not.toBeInTheDocument();
  });

  it('shows the content loading state while the no-diff file is fetched', () => {
    setHook({ loading: false, error: null, fileDiff: null });
    setContentHook({ loading: true, error: null, content: null });
    render(<FileTabRenderer sessionId="s1" filePath="src/a.ts" />);
    expect(screen.getByTestId('file-tab-content-loading')).toBeInTheDocument();
  });

  it('surfaces the binary notice for an unviewable no-diff file', () => {
    setHook({ loading: false, error: null, fileDiff: null });
    setContentHook({
      loading: false,
      error: null,
      content: { path: 'img.png', content: null, size: 999, unviewableReason: 'binary' },
    });
    render(<FileTabRenderer sessionId="s1" filePath="img.png" />);
    expect(screen.getByTestId('file-tab-content-unviewable')).toHaveTextContent('Binary file');
  });

  it('shows the binary notice', () => {
    setHook({
      loading: false,
      error: null,
      fileDiff: { ...PARSED, isBinary: true, hunks: [], additions: 0, deletions: 0 },
    });
    render(<FileTabRenderer sessionId="s1" filePath="img.png" />);
    expect(screen.getByTestId('file-tab-binary')).toBeInTheDocument();
  });

  it('renders the header and the 3-col hunk grid', () => {
    setHook({ loading: false, error: null, fileDiff: PARSED });
    render(<FileTabRenderer sessionId="s1" filePath="src/a.ts" />);
    // Header: basename + dir + ± counts.
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    // Hunk header + code rows.
    expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeInTheDocument();
    const hunks = screen.getByTestId('file-tab-hunks');
    expect(hunks).toHaveTextContent('new line');
    expect(hunks).toHaveTextContent('old line');
  });
});
