import type { HostView } from '../../../../shared/types/hosts';

/** "Limit to: CLI sessions" - lowers a detected tier. Hidden for This Mac; disabled when nothing to lower. */
export function TierControl({
  host,
  onChange,
  busy = false,
}: {
  host: HostView;
  onChange: (cap: 'cli' | null) => void;
  busy?: boolean;
}): React.JSX.Element | null {
  if (host.kind === 'local') return null;
  const checked = host.userCapTier === 'cli';
  // A stale cap can always be cleared; a new one only makes sense when detection allows more than CLI.
  const lockedByDetection = !checked && (host.detectedTier === null || host.detectedTier === 'cli');
  return (
    <label
      title={lockedByDetection ? 'Already limited by detection' : undefined}
      className={`flex items-center gap-2 text-[11px] ${
        lockedByDetection ? 'cursor-not-allowed text-text-disabled' : 'cursor-pointer text-text-secondary'
      }`}
    >
      <input
        type="checkbox"
        data-testid={`tier-control-${host.id}`}
        checked={checked}
        disabled={lockedByDetection || busy}
        onChange={(e) => onChange(e.target.checked ? 'cli' : null)}
      />
      Limit to: CLI sessions
    </label>
  );
}
