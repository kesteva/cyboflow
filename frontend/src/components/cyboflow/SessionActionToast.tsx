import { useEffect, useRef } from 'react';

interface SessionActionToastProps {
  message: string;
  isVisible: boolean;
  onDismiss: () => void;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  /** Visual style; defaults to 'success' so every pre-existing call site (which
   * never passed this prop) renders byte-identical to before. */
  tone?: 'success' | 'error';
}

export function SessionActionToast({
  message,
  isVisible,
  onDismiss,
  durationMs = 3000,
  actionLabel,
  onAction,
  tone = 'success',
}: SessionActionToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);
  // The always-mounted live region below — deliberately decoupled from
  // `isVisible` and the visible toast markup (which still mounts/unmounts
  // with it; several call sites' tests assert it is gone from the DOM once
  // dismissed). A role="status" region inserted into the DOM at the same
  // instant as its own text is commonly never announced — the node has to
  // already exist for a later text mutation to be observed — so the span
  // starts empty and its text is set via direct DOM mutation (a ref, NOT
  // React state) one tick after the region itself is known to exist, on
  // every isVisible flip to true, including the very first one (the span
  // below renders unconditionally, before this effect ever runs). A ref
  // rather than state on purpose: this fires on every toast, and routing it
  // through a re-render would make every caller's tests that fire a toast
  // and then assert synchronously need an extra `act()`/`waitFor` flush they
  // have no reason to know about.
  const liveRegionRef = useRef<HTMLSpanElement | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = () => {
    clearTimer();
    timerRef.current = setTimeout(onDismiss, durationMs);
  };

  useEffect(() => {
    if (!isVisible) return;
    pausedRef.current = false;
    startTimer();
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, onDismiss, durationMs]);

  useEffect(() => {
    const el = liveRegionRef.current;
    if (el === null) return;
    el.textContent = '';
    if (!isVisible) return;
    const id = window.setTimeout(() => {
      if (liveRegionRef.current !== null) liveRegionRef.current.textContent = message;
    }, 0);
    return () => window.clearTimeout(id);
  }, [isVisible, message]);

  const handlePause = () => {
    pausedRef.current = true;
    clearTimer();
  };

  const handleResume = () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    startTimer();
  };

  return (
    <>
      {/* Always mounted, regardless of `isVisible` — see the `liveRegionRef`
          doc above. Rendered unconditionally and FIRST so its position in
          this fragment never shifts, which is what keeps React reusing the
          same DOM node (rather than remounting it) across every isVisible
          flip. Starts with no children — its text is set imperatively via
          the ref, never through JSX/props. */}
      <span ref={liveRegionRef} className="sr-only" role="status" />
      {isVisible && (
        <div
          data-testid="session-action-toast"
          className={`${
            tone === 'error' ? 'bg-status-error' : 'bg-status-success'
          } text-white rounded px-4 py-2 text-sm font-medium shadow-lg flex items-center gap-3`}
          onMouseEnter={handlePause}
          onMouseLeave={handleResume}
          onFocus={handlePause}
          onBlur={handleResume}
        >
          <span>{message}</span>
          {actionLabel !== undefined && onAction !== undefined && (
            <button
              type="button"
              data-testid="session-action-toast-action"
              onClick={onAction}
              className="underline underline-offset-2 font-semibold hover:opacity-80"
            >
              {actionLabel}
            </button>
          )}
        </div>
      )}
    </>
  );
}
