import {
  deriveChips,
  type ConnectionCapabilitiesSnapshot,
  type PersistentAgentTransport,
  type PersistentAgentVendor,
} from '../../../../shared/types/persistentAgents';
import { Chip } from '../landing/QueuePrimitives';

/**
 * Every capability chip, in order, never truncated. Labels come verbatim from the shared `deriveChips` (which
 * already carries the "(not confirmed)" suffix); `unconfirmed` only changes the style.
 */
export function CapabilityChips({
  snapshot,
  transport,
  vendor,
  testId,
}: {
  snapshot: ConnectionCapabilitiesSnapshot;
  transport?: PersistentAgentTransport | null;
  vendor?: PersistentAgentVendor;
  testId?: string;
}): React.JSX.Element {
  const chips = deriveChips(snapshot, { transport, vendor });
  return (
    <div data-testid={testId ?? 'capability-chips'} className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <Chip key={c.key} tone={c.unconfirmed ? 'neutral' : c.tone} noTruncate title={c.label}>
          {c.label}
        </Chip>
      ))}
    </div>
  );
}
