import { CyboflowMark } from '../CyboflowMark';
import { WELCOME_BULLETS } from '../copy';

/**
 * Step 0 — the one-screen product premise. Full-bleed terracotta hero (inverted
 * wordmark) over a lead paragraph and three phase bullets.
 */
export function WelcomeStep(): React.JSX.Element {
  return (
    <div>
      <div className="bg-interactive px-6 pb-5 pt-6 text-text-on-interactive">
        {/* Wordmark, drawn inline so the mark keeps its chevron on terracotta
            (see CyboflowMark). Mirrors cyboflow-wordmark.svg's proportions. */}
        <div className="mb-3.5 flex items-center gap-2.5 opacity-95" role="img" aria-label="Cyboflow">
          <CyboflowMark size={28} className="flex-shrink-0" />
          <span className="text-[22px] font-bold tracking-[-.02em]">cyboflow</span>
        </div>
        <div className="text-[21px] font-bold tracking-[-.01em]">Welcome to Cyboflow</div>
        <div className="mt-[7px] text-[11.5px] leading-[1.55] text-text-on-interactive/80">
          Built to keep humans at the center — focused on what matters, not distracted by everything that doesn't.
        </div>
      </div>
      <div className="px-6 pb-2 pt-5">
        <div className="mb-[18px] text-[12px] leading-[1.65] text-text-primary">
          Cyboflow runs long-lived coding agents over a structured workflow and pulls you in only at the moments that
          need real judgement.
        </div>
        <div className="flex flex-col gap-[13px]">
          {WELCOME_BULLETS.map((b) => (
            <div key={b.title} className="flex gap-[11px]">
              {/* Phase-identity swatch — a fixed brand hue with no semantic token. */}
              <span className="mt-1 h-2 w-2 flex-shrink-0" style={{ background: b.swatch }} />
              <div>
                <div className="text-[11.5px] font-bold text-text-primary">{b.title}</div>
                <div className="text-[10.5px] leading-[1.5] text-text-secondary">{b.body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
