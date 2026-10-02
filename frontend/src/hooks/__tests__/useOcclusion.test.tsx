/**
 * Every central overlay primitive must hold an occlusion lease while open — a
 * native web view paints above all DOM, so an overlay that forgets renders
 * BEHIND the page. One test per site in docs/proposals/native-web-viewer.md §3.7
 * (commit 4a).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useIsOccluded, useOcclusion } from '../useOcclusion';
import { getOcclusionCount, isOccluded, resetOcclusionForTests } from '../../utils/occlusion';
import { Modal } from '../../components/ui/Modal';
import { Dropdown } from '../../components/ui/Dropdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useResizable } from '../useResizable';

afterEach(() => resetOcclusionForTests());

const noop = (): void => {};

describe('useOcclusion', () => {
  it('holds a lease exactly while open and releases on close and on unmount', () => {
    const { rerender, unmount } = renderHook(({ open }) => useOcclusion(open), {
      initialProps: { open: false },
    });
    expect(isOccluded()).toBe(false);
    rerender({ open: true });
    expect(getOcclusionCount()).toBe(1);
    rerender({ open: false });
    expect(isOccluded()).toBe(false);
    rerender({ open: true });
    unmount();
    expect(isOccluded()).toBe(false);
  });

  it('useIsOccluded re-renders on transitions', () => {
    const reader = renderHook(() => useIsOccluded());
    expect(reader.result.current).toBe(false);
    const writer = renderHook(() => useOcclusion(true));
    expect(reader.result.current).toBe(true);
    writer.unmount();
    expect(reader.result.current).toBe(false);
  });
});

describe('central overlay sites hold a lease while open', () => {
  it('ui/Modal', () => {
    const { rerender } = render(<Modal isOpen={false} onClose={noop}>x</Modal>);
    expect(isOccluded()).toBe(false);
    rerender(<Modal isOpen onClose={noop}>x</Modal>);
    expect(isOccluded()).toBe(true);
    rerender(<Modal isOpen={false} onClose={noop}>x</Modal>);
    expect(isOccluded()).toBe(false);
  });

  it('ui/Dropdown', () => {
    render(<Dropdown trigger={<span>open menu</span>} items={[{ id: 'a', label: 'A' }]} />);
    expect(isOccluded()).toBe(false);
    fireEvent.click(screen.getByText('open menu'));
    expect(isOccluded()).toBe(true);
  });

  it('ConfirmDialog (hand-rolled scrim, not ui/Modal)', () => {
    const props = { onClose: noop, onConfirm: noop, title: 't', message: 'm' };
    const { rerender } = render(<ConfirmDialog isOpen={false} {...props} />);
    expect(isOccluded()).toBe(false);
    rerender(<ConfirmDialog isOpen {...props} />);
    expect(isOccluded()).toBe(true);
  });

  it('useResizable holds a lease for the duration of a drag', () => {
    const { result } = renderHook(() =>
      useResizable({ defaultWidth: 200, minWidth: 100, maxWidth: 400 }),
    );
    expect(isOccluded()).toBe(false);
    act(() =>
      result.current.startResize({ preventDefault: noop, clientX: 200 } as unknown as React.MouseEvent),
    );
    expect(isOccluded()).toBe(true);
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(isOccluded()).toBe(false);
  });
});
