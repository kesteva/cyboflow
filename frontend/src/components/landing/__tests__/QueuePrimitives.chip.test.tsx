import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chip } from '../QueuePrimitives';

describe('Chip', () => {
  it('truncates by default', () => {
    render(<Chip>a very long chip label</Chip>);
    expect(screen.getByText('a very long chip label').className).toContain('truncate');
  });

  it('noTruncate wraps instead of truncating', () => {
    render(<Chip noTruncate>a very long chip label</Chip>);
    const cls = screen.getByText('a very long chip label').className;
    expect(cls).not.toContain('truncate');
    expect(cls).toContain('whitespace-normal');
    expect(cls).toContain('break-words');
  });
});
