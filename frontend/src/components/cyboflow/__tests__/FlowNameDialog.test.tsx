/**
 * FlowNameDialog — regression coverage for the empty-name → server-error
 * sequence (rvw_1570a76a): the transient "name is required" validation error
 * must not permanently mask a later server-side rejection (reserved name /
 * duplicate) once the user has corrected the input and resubmitted.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FlowNameDialog } from '../FlowNameDialog';

describe('FlowNameDialog', () => {
  it('a corrected resubmit still surfaces a later serverError after an earlier empty-name error', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <FlowNameDialog
        isOpen
        title="Save as new flow"
        defaultValue="My Flow"
        confirmLabel="Save"
        onConfirm={onConfirm}
        onClose={vi.fn()}
        serverError={null}
      />,
    );

    const input = screen.getByTestId('flow-name-input');
    const confirmButton = screen.getByTestId('flow-name-confirm');

    // Clear the name and press Enter — the confirm BUTTON disables on an empty
    // name, but the input's onKeyDown calls handleConfirm() directly regardless,
    // which is how the local required-name error gets set in the first place.
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('A workflow name is required.')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    // Correct the input to a valid name and resubmit.
    fireEvent.change(input, { target: { value: 'reserved-name' } });
    expect(screen.queryByText('A workflow name is required.')).not.toBeInTheDocument();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledWith('reserved-name', null);

    // The caller reports a server-side rejection for the corrected name — it
    // must render, not be hidden by the stale local validation error.
    rerender(
      <FlowNameDialog
        isOpen
        title="Save as new flow"
        defaultValue="My Flow"
        confirmLabel="Save"
        onConfirm={onConfirm}
        onClose={vi.fn()}
        serverError="A workflow named 'reserved-name' already exists."
      />,
    );
    expect(screen.getByTestId('flow-name-server-error')).toHaveTextContent(
      "A workflow named 'reserved-name' already exists.",
    );
  });
});
