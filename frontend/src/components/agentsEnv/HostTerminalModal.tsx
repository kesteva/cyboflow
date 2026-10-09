import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalHeader } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { errorText } from '../../utils/errorText';
import { RunShellTerminalView, type ShellTerminalApi } from '../cyboflow/RunShellTerminalView';
import type { HostView } from '../../../../shared/types/hosts';

/**
 * Interactive ssh terminal for one environment. Opens a terminal on mount of the modal and closes it when the
 * modal closes. Modal itself takes the occlusion lease, so the overlay paints above native web-tab views.
 */
export function HostTerminalModal({
  host,
  isOpen,
  onClose,
}: {
  host: HostView | null;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const hostId = host?.id ?? null;
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    if (!isOpen || hostId === null) return;
    let cancelled = false;
    let opened: string | null = null;
    setTerminalId(null);
    setError(null);
    setDisconnected(false);
    const closeTerminal = (id: string): void => {
      try {
        void Promise.resolve(trpc.cyboflow.hosts.terminalClose.mutate({ terminalId: id })).catch(() => {});
      } catch {
        /* nothing to close */
      }
    };
    void (async () => {
      try {
        const res = await trpc.cyboflow.hosts.terminalOpen.mutate({ hostId });
        if (!res.ok) {
          if (!cancelled) setError(res.message);
          return;
        }
        if (cancelled) {
          closeTerminal(res.terminalId);
          return;
        }
        opened = res.terminalId;
        setTerminalId(res.terminalId);
      } catch (e) {
        if (!cancelled) setError(errorText(e) ?? 'Could not open a terminal.');
      }
    })();
    return () => {
      cancelled = true;
      if (opened !== null) closeTerminal(opened);
    };
  }, [isOpen, hostId]);

  const api = useMemo<ShellTerminalApi | undefined>(() => {
    if (terminalId === null) return undefined;
    const flag = (ok: boolean): void => {
      if (!ok) setDisconnected(true);
    };
    return {
      // The terminal is already open: the host router mints its id.
      open: async () => ({ ok: true }),
      input: async (text) => {
        const res = await trpc.cyboflow.hosts.terminalInput.mutate({ terminalId, text });
        flag(res.ok);
        return res;
      },
      resize: async (cols, rows) => {
        const res = await trpc.cyboflow.hosts.terminalResize.mutate({ terminalId, cols, rows });
        flag(res.ok);
        return res;
      },
      backlog: async () => {
        const res = await trpc.cyboflow.hosts.terminalBacklog.query({ terminalId });
        if (!res.ok) return { backlog: '', exited: true, exitCode: null };
        return { backlog: res.backlog, exited: res.exited, exitCode: res.exitCode };
      },
    };
  }, [terminalId]);

  if (host === null) return null;
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" closeOnOverlayClick={false} className="h-[85vh]">
      <div data-testid="host-terminal-modal" className="flex min-h-0 flex-1 flex-col">
        <ModalHeader title={`Terminal — ${host.label}`} />
        {disconnected && (
          <div
            role="status"
            data-testid="host-terminal-disconnected"
            className="border-b border-border-primary bg-bg-secondary px-6 py-2 text-xs text-status-warning"
          >
            Disconnected
          </div>
        )}
        <div className="min-h-0 flex-1 bg-bg-primary p-2">
          {error !== null ? (
            <div role="alert" data-testid="host-terminal-error" className="p-4 text-[12px] text-status-error">
              {error}
            </div>
          ) : terminalId === null || api === undefined ? (
            <div className="flex items-center gap-2 p-4 text-[12px] text-text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Connecting…
            </div>
          ) : (
            <RunShellTerminalView
              key={terminalId}
              runId={terminalId}
              terminalId={terminalId}
              api={api}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
