/**
 * useForcedSubstrate — the global forced-substrate pin, read reactively from the
 * config store.
 *
 * Mirrors the AUTHORITATIVE backend precedence (ConfigManager.getForcedSubstrate,
 * consumed in WorkflowRegistry.createRun above the whole resolver ladder):
 *   1. Demo mode pins 'sdk' FIRST — the scripted DemoCliManager handles every
 *      spawn, so the picker/payload must NOT claim 'interactive' under demo even
 *      if the PTY-only lock is also set.
 *   2. The global interactivePtyOnly lock pins 'interactive'.
 *   3. Otherwise null — normal per-run resolution (default 'sdk' + picker).
 *
 * Both the substrate picker lock (SubstrateSelector) and the canvas launch
 * payload (useLaunchWorkflow) derive from this ONE selector so they can never
 * drift from each other or from the backend pin. Returns a primitive, so the
 * default Object.is store equality is correct (no re-render churn).
 */
import { useConfigStore } from '../stores/configStore';
import type { CliSubstrate } from '../../../shared/types/substrate';

export function useForcedSubstrate(): CliSubstrate | null {
  return useConfigStore((s) =>
    s.config?.demoMode ? 'sdk' : s.config?.interactivePtyOnly ? 'interactive' : null,
  );
}
