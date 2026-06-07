/**
 * useAgentPermissionMode — per-run/per-session agent-permission selection state.
 *
 * Seeds REACTIVELY from the global default (Settings → Agent Permission Mode) so
 * an untouched picker forwards the same value the launch would otherwise inherit
 * — never silently clobbering the global default down to a hardcoded 'default'.
 * The default is read from the config store (not once at mount) so a config
 * fetch that resolves AFTER the picker mounts still re-seeds the selection; a
 * `touched` ref guards an explicit user pick from being clobbered once they
 * interact.
 *
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * seed + touched-guard behavior lives in ONE place (no per-surface drift).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useConfigStore } from '../stores/configStore';
import type { PermissionMode } from '../../../shared/types/workflows';

export interface UseAgentPermissionModeReturn {
  /** The currently-selected mode (seeded from the global default until touched). */
  mode: PermissionMode;
  /** Set the mode and mark the selection as user-touched (stops re-seeding). */
  setMode: (mode: PermissionMode) => void;
}

export function useAgentPermissionMode(): UseAgentPermissionModeReturn {
  const globalDefault =
    useConfigStore((state) => state.config?.defaultAgentPermissionMode) ?? 'default';
  const [mode, setModeState] = useState<PermissionMode>(globalDefault);
  const touchedRef = useRef(false);

  useEffect(() => {
    if (!touchedRef.current) setModeState(globalDefault);
  }, [globalDefault]);

  const setMode = useCallback((next: PermissionMode) => {
    touchedRef.current = true;
    setModeState(next);
  }, []);

  return { mode, setMode };
}
