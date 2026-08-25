/**
 * OmpFleetIndicator — colored dot reflecting OMP fleet awareness.
 *
 * Dot colors:
 *   available → green  (bg-status-success)  — registry parsed, N workers
 *   absent    → gray   (bg-text-muted)      — no registry (OMP never ran here)
 *   error     → red    (bg-status-error)    — malformed / unsupported-version
 *   checking  → yellow (bg-status-warning)  — transport failure, snapshot stale
 *
 * Clicking opens a popover with worker count / error kind / detail.
 * Read-only by construction: the renderer has no command surface; this only
 * renders the snapshot the read adapter already validated.
 *
 * Renders NOTHING unless Aria mode is on (Settings → Advanced Options → OMP
 * Runtime). The dot reports FLEET health, which is meaningless on an install
 * that runs OMP locally or not at all — and OMP ships disabled by default, so
 * an always-present "OMP" chip in every user's status bar would label a
 * provider most of them never enabled. The store floors `ariaMode` to false on
 * a cold mount and on any probe failure, so the failure direction is hidden
 * rather than an unexplainable dot.
 */
import { useState, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../utils/cn';
import { useOmpFleetStore } from '../stores/ompFleetStore';
import type { OmpFleetUiStatus } from '../stores/ompFleetStore';

const DOT_COLOR: Record<OmpFleetUiStatus, string> = {
  available: 'bg-status-success',
  absent: 'bg-text-muted',
  error: 'bg-status-error',
  checking: 'bg-status-warning',
};

const STATUS_LABEL: Record<OmpFleetUiStatus, string> = {
  available: 'Fleet available',
  absent: 'No fleet (never ran)',
  error: 'Fleet error',
  checking: 'Checking',
};

const ERROR_LABEL: Record<string, string> = {
  unavailable: 'OMP unavailable',
  missing: 'No fleet (never ran)',
  malformed: 'Malformed registry',
  'unsupported-version': 'Unsupported registry version',
};

export function OmpFleetIndicator() {
  const { ariaMode, status, workerCount, errorKind, detail } = useOmpFleetStore(
    useShallow((s) => ({
      ariaMode: s.ariaMode,
      status: s.status,
      workerCount: s.workerCount,
      errorKind: s.errorKind,
      detail: s.detail,
    })),
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Aria mode can flip off while the popover is open (the store re-probes every
  // tick). Collapse it, so re-enabling later does not re-open a stale dialog.
  useEffect(() => {
    if (!ariaMode) setOpen(false);
  }, [ariaMode]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  // After every hook — an early return above them would break the hook order on
  // the render where Aria mode flips.
  if (!ariaMode) return null;

  return (
    <div ref={containerRef} className="relative flex items-center">
      <button
        type="button"
        aria-label={`OMP fleet status: ${STATUS_LABEL[status]}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive/30 transition-colors"
      >
        <span
          className={cn('w-2 h-2 rounded-full', DOT_COLOR[status], status === 'checking' && 'animate-pulse')}
          data-status={status}
        />
        <span className="text-xs text-text-muted leading-none">OMP</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="OMP fleet diagnostics"
          className={cn(
            'absolute bottom-full right-0 mb-2 z-50',
            'w-64 rounded-md border border-border-primary bg-bg-secondary shadow-lg',
            'p-3 text-xs text-text-primary',
          )}
        >
          <p className="font-semibold mb-2 text-text-primary">OMP Fleet</p>

          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-text-muted">Status</span>
              <span>{STATUS_LABEL[status]}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Workers</span>
              <span>{workerCount !== null ? String(workerCount) : '—'}</span>
            </div>
          </div>

          {status === 'checking' && (
            <div className="mt-2 pt-2 border-t border-border-primary">
              <p className="font-mono text-status-warning break-all text-[10px] leading-tight">
                Last snapshot is stale — IPC unavailable.
              </p>
            </div>
          )}

          {errorKind && (
            <div className="mt-2 pt-2 border-t border-border-primary">
              <p className="text-text-muted mb-1">Error</p>
              <p className="font-mono text-status-error break-all text-[10px] leading-tight">
                {ERROR_LABEL[errorKind] ?? errorKind}
                {detail ? `: ${detail}` : ''}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
