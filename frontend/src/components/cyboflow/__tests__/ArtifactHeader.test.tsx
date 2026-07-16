/**
 * ArtifactHeader tests — the shared artifact-tab header bar.
 *
 * Focus (IDEA-039): the Commit button forwards ONLY `{ projectId, artifactId }`
 * to the artifacts.commit chokepoint — the frontend no longer echoes
 * `payloadJson` (the server snapshots durable content from its own source of
 * truth). Plus the commit-state badge + button visibility.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtifactHeader } from '../ArtifactHeader';
import type { Artifact } from '../../../../../shared/types/artifacts';

const commitMutate = vi.fn().mockResolvedValue({ artifactId: 'art-1' });
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      artifacts: {
        commit: { mutate: (...args: unknown[]) => commitMutate(...args) },
      },
    },
  },
}));

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'ui-prototype',
    label: 'Prototype',
    stepOrigin: null,
    mode: 'canvas',
    committed: false,
    sessionOnly: true,
    isNew: false,
    // A non-null payloadJson proves the commit call NO LONGER echoes it.
    payloadJson: '{"fileName":"prototype/index.html"}',
    sourceRef: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    committedAt: null,
    ...overrides,
  };
}

const HEADER_PROPS = { accent: '#c96442', eyebrow: '◳ Live canvas · ui prototype' } as const;

describe('ArtifactHeader', () => {
  beforeEach(() => {
    commitMutate.mockClear();
  });

  it('commits with ONLY { projectId, artifactId } (no payloadJson echo)', async () => {
    render(<ArtifactHeader artifact={makeArtifact()} projectId={1} {...HEADER_PROPS} />);

    expect(screen.getByTestId('artifact-badge-session-only')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('artifact-commit-button'));

    await waitFor(() => expect(commitMutate).toHaveBeenCalledWith({ projectId: 1, artifactId: 'art-1' }));
    // Exactly those two keys — payloadJson must not ride along.
    expect(Object.keys(commitMutate.mock.calls[0][0]).sort()).toEqual(['artifactId', 'projectId']);
  });

  it('shows the in-repo badge and hides the Commit button once committed', () => {
    render(<ArtifactHeader artifact={makeArtifact({ committed: true })} projectId={1} {...HEADER_PROPS} />);
    expect(screen.getByTestId('artifact-badge-committed')).toHaveTextContent('✓ in repo');
    expect(screen.queryByTestId('artifact-commit-button')).not.toBeInTheDocument();
  });

  it('surfaces a commit error when the mutation rejects', async () => {
    commitMutate.mockRejectedValueOnce(new Error('snapshot failed'));
    render(<ArtifactHeader artifact={makeArtifact()} projectId={1} {...HEADER_PROPS} />);

    fireEvent.click(screen.getByTestId('artifact-commit-button'));
    await waitFor(() => expect(screen.getByTestId('artifact-commit-error')).toHaveTextContent('snapshot failed'));
  });
});
