/**
 * PlaceholderSlot — the dashed "waiting for the assistant" well (docs/proposals/
 * CUSTOM-VIEWS.md §7.1). A pure presentational component; `ViewSurface`'s own
 * tests cover WHEN it renders (the authoring instance, before a draft lands).
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PlaceholderSlot } from '../../edit/PlaceholderSlot';

describe('PlaceholderSlot', () => {
  it('renders the waiting-for-the-assistant copy', () => {
    render(<PlaceholderSlot />);
    expect(screen.getByTestId('widget-placeholder-body')).toHaveTextContent(
      'Waiting for the assistant… Describe the widget in the chat on the right.',
    );
  });

  it('uses the default test id, or an overridden one', () => {
    const { unmount } = render(<PlaceholderSlot />);
    expect(screen.getByTestId('widget-placeholder-slot')).toBeInTheDocument();
    unmount();

    render(<PlaceholderSlot testId="widget-frame-i1" />);
    expect(screen.getByTestId('widget-frame-i1')).toBeInTheDocument();
    expect(screen.queryByTestId('widget-placeholder-slot')).not.toBeInTheDocument();
  });
});
