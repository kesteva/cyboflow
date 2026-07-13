/**
 * CategoryTag unit tests (migration 059).
 *
 * markers.tsx has no other direct test coverage — TaskCard/BacklogPane
 * exercise the markers indirectly. This file covers just the NEW CategoryTag
 * component: label + title + a stable per-category error-tone class so bug
 * items stay visually distinct from chore/feature.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CategoryTag } from '../markers';
import type { EntityCategory } from '../../../../../shared/types/tasks';

describe('CategoryTag', () => {
  it.each<[EntityCategory, string]>([
    ['feature', 'Feature'],
    ['bug', 'Bug'],
    ['chore', 'Chore'],
  ])('renders the %s label and title', (category, label) => {
    render(<CategoryTag category={category} />);
    const tag = screen.getByTestId('category-tag');
    expect(tag).toHaveTextContent(label);
    expect(tag).toHaveAttribute('title', `Category: ${label}`);
  });

  it('gives bug the error-tone class (attention-grabbing) unlike chore/feature', () => {
    const { unmount: unmountBug } = render(<CategoryTag category="bug" />);
    expect(screen.getByTestId('category-tag').className).toContain('status-error');
    unmountBug();

    const { unmount: unmountChore } = render(<CategoryTag category="chore" />);
    expect(screen.getByTestId('category-tag').className).not.toContain('status-error');
    unmountChore();

    render(<CategoryTag category="feature" />);
    expect(screen.getByTestId('category-tag').className).not.toContain('status-error');
  });
});
