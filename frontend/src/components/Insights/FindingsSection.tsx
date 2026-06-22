/**
 * FindingsSection — Insights mockup section 01, the findings-triage surface
 * ("01 FINDINGS — triage what the flows surfaced").
 *
 * A layout shell over five focused children that turn the flat pending-findings
 * list into a human triage moment before a compound run:
 *
 *   FindingsHeader   — the eyebrow + tagline (no CTA — the launch lives in the tray).
 *   CounterStrip     — findings-scoped Pending / Resolved / Dismissed (live).
 *   UntriagedList    — the untriaged findings (top-5 + "Show N more"), each with
 *                      Approve / Modify (re-tag + re-prioritize) / Dismiss.
 *   ReadyToCompound  — approved findings bucketed, with per-row / per-bucket /
 *                      Select-all selection (the greedy-5 budget).
 *   CompoundingTray  — the sticky "Run compounding session (N) →" CTA carrying the
 *                      human's exact selection into the start wizard.
 *
 * The shell owns ONE piece of view-local state: `openModifyId` — the single-open
 * modify-drawer invariant. It resets to null when the open id leaves the untriaged
 * set (the row was Approved into READY or Dismissed), so a departed row's drawer
 * cannot leak. All triage actions + the live subscription live in the store; this
 * component is presentational glue.
 */
import { useEffect, useState } from 'react';
import { useInsightsStore, selectUntriaged } from '../../stores/insightsStore';
import { FindingsHeader } from './FindingsHeader';
import { CounterStrip } from './CounterStrip';
import { UntriagedList } from './UntriagedList';
import { ReadyToCompound } from './ReadyToCompound';
import { CompoundingTray } from './CompoundingTray';

/** FindingsSection — see the file header. Default export so InsightsView is unchanged. */
export function FindingsSection(): React.JSX.Element {
  const triageFindings = useInsightsStore((s) => s.triageFindings);
  // Single-open modify-drawer invariant (opening B closes A is enforced by the
  // single id; UntriagedList toggles it).
  const [openModifyId, setOpenModifyId] = useState<string | null>(null);

  // Reset the open drawer when its row leaves the untriaged set — once a finding
  // is Approved (→ READY) or Dismissed it no longer renders an UntriagedRow, so a
  // stale openModifyId would point at a departed row.
  useEffect(() => {
    if (openModifyId === null) return;
    const stillUntriaged = selectUntriaged(triageFindings).some((f) => f.id === openModifyId);
    if (!stillUntriaged) setOpenModifyId(null);
  }, [openModifyId, triageFindings]);

  return (
    <div data-testid="findings-section">
      <FindingsHeader />
      <CounterStrip />
      <UntriagedList openModifyId={openModifyId} onOpenModify={setOpenModifyId} />
      <ReadyToCompound />
      <CompoundingTray />
    </div>
  );
}
