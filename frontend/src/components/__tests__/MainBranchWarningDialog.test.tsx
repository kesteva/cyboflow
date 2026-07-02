/**
 * MainBranchWarningDialog — the "don't ask again" localStorage write is scoped
 * per projectId and ONLY fires on the persistent-continue path; plain Continue and
 * Cancel never touch localStorage.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainBranchWarningDialog } from '../MainBranchWarningDialog';

beforeEach(() => {
  localStorage.clear();
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof MainBranchWarningDialog>> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    onContinue: vi.fn(),
    projectName: 'Acme',
    projectId: 42,
    mainBranch: 'main',
    ...overrides,
  };
  render(<MainBranchWarningDialog {...props} />);
  return props;
}

describe('MainBranchWarningDialog', () => {
  it('"Continue and don\'t ask again" writes mainBranchWarning_<projectId> and continues', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /don't ask again/i }));
    expect(localStorage.getItem('mainBranchWarning_42')).toBe('true');
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('plain Continue calls onContinue but writes NO localStorage flag', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /continue to main branch/i }));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('mainBranchWarning_42')).toBeNull();
  });

  it('Cancel touches neither onContinue nor localStorage', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(props.onContinue).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('mainBranchWarning_42')).toBeNull();
  });

  it('scopes the persisted key per projectId', () => {
    renderDialog({ projectId: 7 });
    fireEvent.click(screen.getByRole('button', { name: /don't ask again/i }));
    expect(localStorage.getItem('mainBranchWarning_7')).toBe('true');
    expect(localStorage.getItem('mainBranchWarning_42')).toBeNull();
  });
});
