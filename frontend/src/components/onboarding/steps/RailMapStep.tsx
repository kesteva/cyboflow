import { Users, BarChart3, Activity, Boxes, ScanEye, FolderTree } from 'lucide-react';

/**
 * Step 7 — the closing map of the left rail. Six rows (the prototype's five plus
 * the Verify Queue, per the lane brief). The Human review row keeps the design's
 * barber-pole human-checkpoint swatch; the rest sit on terracotta circles.
 */
interface RailRowSpec {
  icon: React.ReactNode;
  title: string;
  body: string;
  /** Human-checkpoint barber-pole swatch instead of the flat terracotta circle. */
  barberPole?: boolean;
}

const ICON_CLASS = 'h-3 w-3';

const ROWS: ReadonlyArray<RailRowSpec> = [
  {
    icon: <Users className={ICON_CLASS} strokeWidth={1.6} />,
    title: 'Human review',
    body: 'Approvals, questions & findings — across every project.',
    barberPole: true,
  },
  {
    icon: <BarChart3 className={ICON_CLASS} strokeWidth={2} />,
    title: 'Task backlog',
    body: 'Ideas moving through clarify → extract → execute.',
  },
  {
    icon: <Activity className={ICON_CLASS} strokeWidth={2} />,
    title: 'Insights',
    body: 'Token usage, success rates & code quality per flow.',
  },
  {
    icon: <Boxes className={ICON_CLASS} strokeWidth={2} />,
    title: 'Workflows',
    body: 'Edit the built-in flows, or build your own agents.',
  },
  {
    icon: <ScanEye className={ICON_CLASS} strokeWidth={2} />,
    title: 'Verify Queue',
    body: 'Visual verification — screenshots of UI changes, reviewed by you.',
  },
  {
    icon: <FolderTree className={ICON_CLASS} strokeWidth={2} />,
    title: 'Projects & Sessions',
    body: 'Your repos, with every running & idle session nested under them.',
  },
];

// Barber-pole (human-checkpoint) gradient; no semantic token maps to it.
const BARBER_POLE = 'repeating-linear-gradient(135deg,#d99a3d 0 4px,#c98a2d 4px 8px)';

export function RailMapStep(): React.JSX.Element {
  return (
    <div className="px-6 pb-2 pt-5">
      <div className="mb-4 text-[12px] leading-[1.6] text-text-primary">Everything else lives on the left rail:</div>
      <div className="flex flex-col gap-3">
        {ROWS.map((row) => (
          <div key={row.title} className="flex items-start gap-[11px]">
            <span
              className={`flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full text-white ${
                row.barberPole ? '' : 'bg-interactive'
              }`}
              style={row.barberPole ? { background: BARBER_POLE } : undefined}
            >
              {row.icon}
            </span>
            <div>
              <span className="text-[11.5px] font-bold text-text-primary">{row.title}</span>
              <div className="text-[10px] leading-[1.5] text-text-secondary">{row.body}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-[15px] border-t border-dashed border-border-primary pt-3 text-[10px] leading-[1.5] text-text-tertiary">
        Replay this walkthrough anytime from Settings → Onboarding.
      </div>
    </div>
  );
}
