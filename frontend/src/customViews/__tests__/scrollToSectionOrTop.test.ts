/**
 * scrollToSectionOrTop — the two branches of the custom-view scroll guard
 * (docs/proposals/CUSTOM-VIEWS.md §5.2).
 *
 * The distinction the tests pin is the one the callers act on: a MOUNTED
 * section scrolls into view and reports `'section'` (so the caller flashes it);
 * an absent one scrolls the page container to the top and reports `'top'` (so
 * the caller does NOT flash an unexplained blink).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrollToSectionOrTop } from '../scrollToSectionOrTop';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('scrollToSectionOrTop', () => {
  it('scrolls the mounted section into view and reports "section"', () => {
    const scrollIntoView = vi.fn();
    const container = { scrollTo: vi.fn() };
    const outcome = scrollToSectionOrTop({ current: { scrollIntoView } }, container);

    expect(outcome).toBe('section');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it('forwards scrollIntoView options', () => {
    const scrollIntoView = vi.fn();
    scrollToSectionOrTop({ current: { scrollIntoView } }, null, {
      block: 'start',
      behavior: 'smooth',
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });

  it('scrolls the given container to the top and reports "top" when the ref is unmounted', () => {
    const container = { scrollTo: vi.fn() };
    const outcome = scrollToSectionOrTop({ current: null }, container, { behavior: 'smooth' });

    expect(outcome).toBe('top');
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('falls back to the tagged page scroll container when none is passed', () => {
    const page = document.createElement('div');
    page.setAttribute('data-scroll-container', '');
    const scrollTo = vi.fn();
    Object.defineProperty(page, 'scrollTo', { value: scrollTo, writable: true });
    document.body.appendChild(page);

    expect(scrollToSectionOrTop({ current: null })).toBe('top');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('sets scrollTop when the container has no scrollTo (a plain element)', () => {
    const container: { scrollTop: number } = { scrollTop: 400 };
    expect(scrollToSectionOrTop(null, container)).toBe('top');
    expect(container.scrollTop).toBe(0);
  });
});
