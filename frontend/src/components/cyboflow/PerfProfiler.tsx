/**
 * PerfProfiler — wraps a subtree to attribute its React commit cost under `id`
 * for the renderer perf probe (see utils/perfProbe.ts). Transparent passthrough
 * (no <Profiler>, zero overhead) when the probe is disabled.
 */
import { Profiler, type ReactElement, type ReactNode } from 'react';
import { PERF_PROBE_ENABLED, perfOnRender } from '../../utils/perfProbe';

export function PerfProfiler({ id, children }: { id: string; children: ReactNode }): ReactElement {
  if (!PERF_PROBE_ENABLED) return <>{children}</>;
  return (
    <Profiler id={id} onRender={perfOnRender}>
      {children}
    </Profiler>
  );
}
