import type { HealthDot as HealthDotKind } from '../../../../shared/types/persistentAgents';

const CLS: Record<HealthDotKind, string> = {
  green: 'bg-status-success',
  amber: 'bg-status-warning',
  neutral: 'bg-status-neutral',
  hollow: 'border border-text-tertiary bg-transparent',
  red: 'bg-status-error',
};

/** Connection health dot. Red is reserved for revoked / rejected credentials. */
export function HealthDot({ dot, label }: { dot: HealthDotKind; label: string }): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-dot={dot}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${CLS[dot]}`}
    />
  );
}
