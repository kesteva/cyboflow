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
  { name: 'CHANGELOG.md', path: 'CHANGELOG.md', isDirectory: false, size: 4 },
];

/** A controllable promise for driving deterministic resolve-order races. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  it('shows the too-large notice (with MB-formatted size) for an oversized file', async () => {
    mockReadFile.mockResolvedValue({
      path: 'big.bin',
      content: null,
      size: 2 * 1024 * 1024,
      unviewableReason: 'too-large',
    });
    render(<RunFileExplorer runId="run-1" />);
    const fileNode = await screen.findByTestId('run-file-explorer-node-README.md');
    await act(async () => {
      fireEvent.click(fileNode);
    });

    const notice = await screen.findByTestId('run-file-explorer-unviewable');
    expect(notice).toHaveTextContent(/too large/i);
    expect(notice).toHaveTextContent('2.0 MB');
    expect(screen.queryByTestId('run-file-explorer-content')).not.toBeInTheDocument();
  });

  it('shows the viewer error state when readFile rejects', async () => {
    mockReadFile.mockRejectedValue(new Error('boom reading file'));
    render(<RunFileExplorer runId="run-1" />);
    const fileNode = await screen.findByTestId('run-file-explorer-node-README.md');
    await act(async () => {
      fireEvent.click(fileNode);
    });

    const err = await screen.findByTestId('run-file-explorer-viewer-error');
    expect(err).toHaveTextContent('boom reading file');
    expect(screen.queryByTestId('run-file-explorer-content')).not.toBeInTheDocument();
  });

  it('refresh re-reads the root AND every expanded directory', async () => {
    render(<RunFileExplorer runId="run-1" />);
    const srcNode = await screen.findByTestId('run-file-explorer-node-src');
    await act(async () => {
      fireEvent.click(srcNode);
    });
    await screen.findByTestId('run-file-explorer-node-src/index.ts');

    // After refresh, 'src' now contains an extra file.
    mockListFiles.mockImplementation((input: { runId: string; path?: string }) => {
      if (input.path === undefined || input.path === '') return Promise.resolve(ROOT_ENTRIES);
      if (input.path === 'src') {
        return Promise.resolve([
          ...SRC_ENTRIES,
          { name: 'new.ts', path: 'src/new.ts', isDirectory: false, size: 3 },
        ]);
      }
      return Promise.resolve([]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('run-file-explorer-refresh'));
    });

    // The freshly-written file appears, and BOTH root and the expanded dir were re-listed.
    await screen.findByTestId('run-file-explorer-node-src/new.ts');
    expect(mockListFiles).toHaveBeenCalledWith({ runId: 'run-1', path: undefined });
    expect(mockListFiles).toHaveBeenCalledWith({ runId: 'run-1', path: 'src' });
  });

  it('surfaces a failed subdirectory expand as an inline retryable error', async () => {
    mockListFiles.mockImplementation((input: { runId: string; path?: string }) => {
      if (input.path === 'src') return Promise.reject(new Error('cannot read src'));
      return Promise.resolve(ROOT_ENTRIES);
    });
    render(<RunFileExplorer runId="run-1" />);
    const srcNode = await screen.findByTestId('run-file-explorer-node-src');

    await act(async () => {
      fireEvent.click(srcNode);
    });

    const errRow = await screen.findByTestId('run-file-explorer-node-error-src');
    expect(errRow).toHaveTextContent('cannot read src');

    // Retry succeeds once the dir is readable again.
    mockListFiles.mockImplementation(listFilesByPath);
    await act(async () => {
      fireEvent.click(errRow);
    });
    await screen.findByTestId('run-file-explorer-node-src/index.ts');
    expect(screen.queryByTestId('run-file-explorer-node-error-src')).not.toBeInTheDocument();
  });

  it('does not let a superseded file read paint over a newer open (request-id guard)', async () => {
    const slowA = deferred<RunFileContent>();
    // First open (README.md) hangs; the second open (CHANGELOG.md) resolves fast.
    mockReadFile.mockImplementationOnce(() => slowA.promise);
    mockReadFile.mockResolvedValue({
      path: 'CHANGELOG.md',
      content: 'changelog body',
      size: 4,
      unviewableReason: null,
    });

    render(<RunFileExplorer runId="run-1" />);
    const readme = await screen.findByTestId('run-file-explorer-node-README.md');
    await act(async () => {
      fireEvent.click(readme); // open A (slow)
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-file-explorer-back')); // back to tree
    });
    const changelog = await screen.findByTestId('run-file-explorer-node-CHANGELOG.md');
    await act(async () => {
      fireEvent.click(changelog); // open B (fast)
    });
    await screen.findByText('changelog body');

    // Now A finally resolves — it must NOT overwrite B's content.
    await act(async () => {
      slowA.resolve({ path: 'README.md', content: '# Hello', size: 7, unviewableReason: null });
      await slowA.promise;
    });
    expect(screen.getByTestId('run-file-explorer-content')).toHaveTextContent('changelog body');
    expect(screen.getByTestId('run-file-explorer-content')).not.toHaveTextContent('# Hello');
  });
});
