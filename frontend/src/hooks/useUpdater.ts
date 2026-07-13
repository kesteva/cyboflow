import { useEffect, useState } from 'react';

// Mirrors the lifecycle of the in-app auto-updater (see shared/types/updater).
// 'unsupported' = dev / unpackaged build where the updater is a no-op.
export type UpdateUiState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'up-to-date' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export interface Updater {
  state: UpdateUiState;
  /** Trigger a check; settles the discrete verdict. */
  check: () => Promise<void>;
  /** Start the download; progress + 'downloaded' arrive via the event stream. */
  download: () => Promise<void>;
  /** Quit and install a downloaded update. */
  install: () => void;
  /** Reset back to idle (e.g. when a dialog closes). */
  reset: () => void;
}

/**
 * Shared driver for the in-app auto-updater UI. Subscribes to the main-process
 * 'updater:event' stream for the async download lifecycle and exposes the
 * imperative check/download/install actions. Used by both Settings → Updates
 * and the About dialog so the state machine lives in one place.
 */
export function useUpdater(): Updater {
  // Intentionally per-instance (accepted, not a shared store): each consumer
  // (Sidebar, UpdateSettings) runs its own state machine, kept eventually
  // consistent via the 'updater:event' broadcast below. The discrete check()
  // verdict is deliberately instance-local. A shared Zustand store isn't
  // justified for two low-frequency consumers whose only shared signal is that
  // event stream.
  const [state, setState] = useState<UpdateUiState>({ status: 'idle' });

  // Stream the async download lifecycle; the discrete check verdict is settled
  // by check() below.
  useEffect(() => {
    return window.electronAPI.updater.onEvent((event) => {
      switch (event.kind) {
        case 'download-progress':
          setState({ status: 'downloading', percent: Math.round(event.percent) });
          break;
        case 'downloaded':
          setState({ status: 'downloaded', version: event.version });
          break;
        case 'error':
          setState({ status: 'error', message: event.message });
          break;
        case 'available':
          setState((prev) => (prev.status === 'idle' ? { status: 'available', version: event.version } : prev));
          break;
      }
    });
  }, []);

  const check = async () => {
    setState({ status: 'checking' });
    try {
      const result = await window.electronAPI.updater.check();
      if (!result.success || !result.data) {
        setState({ status: 'error', message: result.error || 'Update check failed' });
        return;
      }
      if (!result.data.supported) {
        setState({ status: 'unsupported' });
      } else if (result.data.updateAvailable && result.data.latestVersion) {
        setState({ status: 'available', version: result.data.latestVersion });
      } else {
        setState({ status: 'up-to-date' });
      }
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Update check failed' });
    }
  };

  const download = async () => {
    setState({ status: 'downloading', percent: 0 });
    const result = await window.electronAPI.updater.download();
    if (!result.success) {
      setState({ status: 'error', message: result.error || 'Update download failed' });
    }
  };

  const install = () => {
    void window.electronAPI.updater.install();
  };

  const reset = () => setState({ status: 'idle' });

  return { state, check, download, install, reset };
}
