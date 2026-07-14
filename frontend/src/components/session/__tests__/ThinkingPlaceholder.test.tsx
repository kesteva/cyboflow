import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThinkingPlaceholder } from '../ThinkingPlaceholder';

describe('ThinkingPlaceholder', () => {
  it('uses the active provider name in the waiting state', () => {
    render(<ThinkingPlaceholder agentName="Codex" />);

    expect(screen.getByText(/^Codex is thinking/)).toBeInTheDocument();
    expect(screen.getByText(/view Codex's thinking process/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude is thinking/)).not.toBeInTheDocument();
  });

  it('keeps Claude as the default for existing callers', () => {
    render(<ThinkingPlaceholder />);

    expect(screen.getByText(/^Claude is thinking/)).toBeInTheDocument();
  });
});
