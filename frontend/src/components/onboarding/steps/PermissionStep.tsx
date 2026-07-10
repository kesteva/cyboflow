import type { PermissionMode } from '../../../../../shared/types/workflows';
import { PERMISSION_MODE_OPTIONS } from '../../cyboflow/AgentPermissionModeSelector';

/**
 * Step 2 — permission mode. Radio rows single-sourced from
 * PERMISSION_MODE_OPTIONS (order + labels), re-skinned to the onboarding design
 * with its own longer descriptions and the Recommended / Least-safe tags. The
 * selection persists to config.defaultAgentPermissionMode when the footer Next
 * fires (handled by the gate), not on click.
 */
interface PermissionStepProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

/** Design descriptions + tag, keyed by the canonical PermissionMode id. */
const DETAIL: Record<PermissionMode, { desc: string; tag?: { label: string; amber?: boolean } }> = {
  default: { desc: 'Approve every change. Safest — most interruptions.' },
  acceptEdits: { desc: 'Edits run freely; sensitive actions still ask first.' },
  auto: { desc: 'Uses a safety classifier to only escalate sensitive actions', tag: { label: 'Recommended' } },
  dontAsk: {
    desc: 'Never prompts for permissions — even sensitive actions run unattended.',
    tag: { label: 'Least safe', amber: true },
  },
};

export function PermissionStep({ value, onChange }: PermissionStepProps): React.JSX.Element {
  return (
    <div className="px-6 pb-2 pt-5">
      <div className="mb-[15px] text-[12px] leading-[1.6] text-text-primary">
        How much can agents do on their own? You can change this any time in Settings — blocking requests always land in
        the review queue.
      </div>
      <div className="flex flex-col gap-[7px]">
        {PERMISSION_MODE_OPTIONS.map(({ id, label }) => {
          const detail = DETAIL[id];
          const selected = value === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(id)}
              className={`px-3.5 py-2.5 text-left transition-colors ${
                selected
                  ? 'border-[1.4px] border-interactive bg-surface-primary shadow-[inset_3px_0_0_var(--terracotta)]'
                  : 'border border-border-primary bg-surface-primary hover:border-border-emphasized'
              }`}
            >
              <div className="flex items-center gap-2 text-[11.5px] font-bold text-text-primary">
                {label}
                {detail.tag && (
                  <span
                    className="border px-[5px] py-px text-[8.5px] uppercase tracking-[.14em]"
                    style={
                      detail.tag.amber
                        ? { color: 'var(--human-border)', borderColor: 'var(--human-border)' }
                        : { color: 'var(--terracotta)', borderColor: 'var(--terracotta)' }
                    }
                  >
                    {detail.tag.label}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[10px] leading-[1.45] text-text-secondary">{detail.desc}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-[13px] text-[10px] leading-[1.5] text-text-tertiary">
        Applies to every new session · per-run overrides available when you start one.
      </div>
    </div>
  );
}
