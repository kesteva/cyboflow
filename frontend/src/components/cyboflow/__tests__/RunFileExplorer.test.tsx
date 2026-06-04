/**
 * RunFileExplorer tests.
 *
 * Behaviors verified:
 *   1. Loads & renders the worktree root (dirs first, then files).
 *   2. Expanding a directory lazy-loads its children via a relative path.
 *   3. Clicking a file opens the read-only viewer with its content; the back
 *      control returns to the tree.
 *   4. A binary/oversized file shows the unviewable notice (no content).
 *   5. A root listing error (e.g. no worktree) surfaces inline.
 *
 * tRPC is mocked file-locally (overriding the global setup.ts stub), keyed on the
 * requested path so directory lazy-loading can be exercised.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunFileEntry, RunFileContent } from '../../../../../shared/types/runFiles';

// ---------------------------------------------------------------------------
// tRPC mock — override the global setup.ts stub with path-aware impls.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listFiles: { query: vi.fn() },
        readFile: { query: vi.fn() },
      },
    },
  },
}));

import { RunFileExplorer } from '../RunFileExplorer';
import { trpc } from '../../../trpc/client';

const mockListFiles = vi.mocked(trpc.cyboflow.runs.listFiles.query);
const mockReadFile = vi.mocked(trpc.cyboflow.runs.readFile.query);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT_ENTRIES: RunFileEntry[] = [
  { name: 'src', path: 'src', isDirectory: true },
  { name: 'README.md', path: 'README.md', isDirectory: false, size: 7 },
];

const SRC_ENTRIES: RunFileEntry[] = [
  { name: 'index.ts', path: 'src/index.ts', isDirectory: false, size: 12 },
];

const README_CONTENT: RunFileContent = {
  path: 'README.md',
  content: '# Hello',
  size: 7,
  unviewableReason: null,
};

/** Route listFiles by requested path; undefined/'' === worktree root. */
function listFilesByPath(input: { runId: string; path?: string }): Promise<RunFileEntry[]> {
  if (input.path === undefined || input.path === '') return Promise.resolve(ROOT_ENTRIES);
  if (input.path === 'src') return Promise.resolve(SRC_ENTRIES);
  return Promise.resolve([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListFiles.mockImplementation(listFilesByPath);
  mockReadFile.mockResolvedValue(structuredClone(README_CONTENT));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunFileExplorer', () => {
  it('loads and renders the worktree root, directories first', async () => {
    render(<RunFileExplorer runId="run-1" />);

    // Root listed with the run's id and no path.
    await screen.findByTestId('run-file-explorer-node-src');
    expect(mockListFiles).toHaveBeenCalledWith({ runId: 'run-1', path: undefined });

    const tree = screen.getByTestId('run-file-explorer-tree');
    const labels = Array.from(tree.querySelectorAll('button')).map((b) => b.textContent);
    // 'src' (dir) appears before 'README.md' (file).
    expect(labels[0]).toContain('src');
    expect(labels[1]).toContain('README.md');
  });

  it('lazy-loads a directory on expand, addressing it by relative path', async () => {
    render(<RunFileExplorer runId="run-1" />);
    const srcNode = await screen.findByTestId('run-file-explorer-node-src');

    await act(async () => {
      fireEvent.click(srcNode);
    });

    // Child loaded via the relative path 'src'.
    await screen.findByTestId('run-file-explorer-node-src/index.ts');
    expect(mockListFiles).toHaveBeenCalledWith({ runId: 'run-1', path: 'src' });
  });

  it('opens the read-only viewer when a file is clicked and the back control returns to the tree', async () => {
    render(<RunFileExplorer runId="run-1" />);
    const fileNode = await screen.findByTestId('run-file-explorer-node-README.md');

    await act(async () => {
      fireEvent.click(fileNode);
    });

    // Viewer takes over with the file content.
    await screen.findByTestId('run-file-explorer-viewer');
    expect(mockReadFile).toHaveBeenCalledWith({ runId: 'run-1', path: 'README.md' });
    expect(screen.getByTestId('run-file-explorer-content')).toHaveTextContent('# Hello');

    // Back returns to the tree.
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-file-explorer-back'));
    });
    await screen.findByTestId('run-file-explorer-tree');
    expect(screen.queryByTestId('run-file-explorer-viewer')).not.toBeInTheDocument();
  });

  it('shows the unviewable notice for a binary file instead of content', async () => {
    mockReadFile.mockResolvedValue({
      path: 'blob.bin',
      content: null,
      size: 2048,
      unviewableReason: 'binary',
    });
    render(<RunFileExplorer runId="run-1" />);
    const fileNode = await screen.findByTestId('run-file-explorer-node-README.md');

    await act(async () => {
      fireEvent.click(fileNode);
    });

    await screen.findByTestId('run-file-explorer-unviewable');
    expect(screen.getByTestId('run-file-explorer-unviewable')).toHaveTextContent(/binary file/i);
    expect(screen.queryByTestId('run-file-explorer-content')).not.toBeInTheDocument();
  });

  it('surfaces a root listing error inline (e.g. run has no worktree)', async () => {
    mockListFiles.mockRejectedValue(new Error('Run run-1 has no worktree yet'));
    render(<RunFileExplorer runId="run-1" />);

    const err = await screen.findByTestId('run-file-explorer-error');
    expect(err).toHaveTextContent('has no worktree yet');
  });

  it('reloads the root when runId changes', async () => {
    const { rerender } = render(<RunFileExplorer runId="run-1" />);
    await screen.findByTestId('run-file-explorer-node-src');
    expect(mockListFiles).toHaveBeenCalledWith({ runId: 'run-1', path: undefined });

    await act(async () => {
      rerender(<RunFileExplorer runId="run-2" />);
    });
    await waitFor(() => {
      expect(mockListFiles).toHaveBeenCalledWith({ runId: 'run-2', path: undefined });
    });
  });
});
