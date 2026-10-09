import { Chip } from '../landing/QueuePrimitives';
import { useHostLookup } from '../../stores/hostsStore';
import type { LifecycleState } from '../../../../shared/types/hosts';

function toneFor(state: LifecycleState | null | undefined): 'neutral' | 'warning' | 'error' {
  switch (state) {
    case 'online':
      return 'neutral';
    case 'unreachable':
      return 'error';
    default:
      return 'warning';
  }
}

/** Where a run or session executes. Renders nothing for This Mac (null / 'local'). */
export function EnvironmentMarker({ hostId }: { hostId: string | null | undefined }): React.JSX.Element | null {
  const host = useHostLookup(hostId);
  if (!hostId || hostId === 'local' || host?.kind === 'local') return null;
  const label = host?.label ?? 'Remote';
  const state = host?.lifecycleState ?? null;
  return (
    <span data-testid="environment-marker" className="inline-flex flex-shrink-0 min-w-0" title={`Runs on ${label}`}>
      <Chip tone={host ? toneFor(state) : 'warning'}>{label}</Chip>
    </span>
  );
}
