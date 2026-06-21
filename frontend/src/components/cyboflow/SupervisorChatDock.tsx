/**
 * SupervisorChatDock — a self-hiding, fixed-overlay home for the Stage 3 supervisor
 * chat (the human seam). Rendered at CyboflowRoot top level for the active run; it
 * shows NOTHING unless that run actually has a supervisor chat session
 * (programmatic run + SDK supervisor — gated on `supervisorChat.isActive`). Being
 * fixed-position, it never reflows the existing layout — a deliberately
 * low-risk first cut; placement/polish can move it into the run rail later.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { SupervisorChatPanel } from './SupervisorChatPanel';

interface SupervisorChatDockProps {
  /** The active run id (null when no run is focused). */
  runId: string | null;
}

export function SupervisorChatDock({ runId }: SupervisorChatDockProps): ReactElement | null {
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!runId) {
      setActive(false);
      return;
    }
    let cancelled = false;
    // The session registers on run start; re-check briefly in case the dock
    // mounts a tick before registration.
    let tries = 0;
    const check = (): void => {
      void trpc.cyboflow.supervisorChat.isActive
        .query({ runId })
        .then((r) => {
          if (cancelled) return;
          setActive(r.active);
          if (!r.active && tries < 3) {
            tries += 1;
            setTimeout(check, 1000);
          }
        })
        .catch(() => {
          /* fail-soft: leave hidden */
        });
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (!runId || !active) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex flex-col overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
      style={{ width: 360, height: open ? 420 : 36 }}
      data-testid="supervisor-chat-dock"
    >
      <button
        className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Supervisor</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="min-h-0 flex-1">
          <SupervisorChatPanel runId={runId} />
        </div>
      )}
    </div>
  );
}
