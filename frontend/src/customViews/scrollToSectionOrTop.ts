/**
 * scrollToSectionOrTop — the navigation guard a custom view makes necessary
 * (docs/proposals/CUSTOM-VIEWS.md §5.2).
 *
 * Every "jump to the queue" affordance on `LandingHome` scrolls to a section
 * ref. In the Default view those sections always exist, so a bare
 * `ref.current?.scrollIntoView()` was total. Under a custom view the target
 * section may be hidden, reordered, or simply not placed at all — the ref then
 * stays null and the jump silently does nothing, which reads as a dead button.
 *
 * The rule is: scroll to the section when it is mounted; otherwise scroll the
 * page container to the top, which is the closest honest answer to "take me to
 * where that lives". Callers pair this with their own flash: the flash is only
 * meaningful when the element exists, so the return value reports which branch
 * ran and the caller flashes ONLY on `'section'`.
 *
 * The container is looked up from the ref's own ancestry when not supplied —
 * `LandingHome`'s scroll container is the page wrapper, not `window` (the page
 * is `h-full overflow-y-auto` inside the shell's center pane), so scrolling
 * `window` would move nothing.
 */

/** Which branch {@link scrollToSectionOrTop} took — callers flash only on `'section'`. */
export type ScrollOutcome = 'section' | 'top';

/** The bits of an Element this helper uses; keeps the signature testable in jsdom. */
interface ScrollTargetLike {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  closest?(selectors: string): Element | null;
}

/** The bits of the scroll container this helper uses. */
interface ScrollContainerLike {
  scrollTo?(options: ScrollToOptions): void;
  scrollTop?: number;
}

/**
 * Scroll to `ref`'s element when it is mounted, else scroll `container` (or the
 * ref's nearest scrollable ancestor, or `window`) to the top.
 *
 * @param ref       the section ref — `null`/unmounted takes the "top" branch.
 * @param container explicit scroll container; omitted resolves one.
 * @param options   forwarded to `scrollIntoView` on the section branch.
 */
export function scrollToSectionOrTop(
  ref: { current: ScrollTargetLike | null } | null,
  container?: ScrollContainerLike | null,
  options: ScrollIntoViewOptions = { block: 'start' },
): ScrollOutcome {
  const el = ref?.current ?? null;
  if (el !== null) {
    el.scrollIntoView(options);
    return 'section';
  }
  const target = container ?? resolveScrollContainer();
  if (target !== null) {
    if (typeof target.scrollTo === 'function') {
      target.scrollTo({ top: 0, behavior: options.behavior ?? 'auto' });
    } else if ('scrollTop' in target) {
      target.scrollTop = 0;
    }
  }
  return 'top';
}

/**
 * The page's own scroll container. `LandingHome` / `ProjectOverviewPage` both
 * render one `overflow-y-auto` wrapper as their outermost element, tagged
 * `data-scroll-container` for exactly this lookup; `window` is the fallback so
 * the helper still does something sane anywhere else.
 */
function resolveScrollContainer(): ScrollContainerLike | null {
  if (typeof document === 'undefined') return null;
  const tagged = document.querySelector('[data-scroll-container]');
  if (tagged !== null) return tagged as unknown as ScrollContainerLike;
  return typeof window !== 'undefined' ? (window as unknown as ScrollContainerLike) : null;
}
