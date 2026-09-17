/**
 * DesignAffordance — a small "Design" icon button that opens the approved
 * design bound to a task/epic/idea's originating idea (Tier 2, item 8c).
 *
 * Resolution: `cyboflow.design.forEntity({ entityId })` (idea → itself; epic →
 * `originating_idea_id`; task → its own `originating_idea_id`, else its parent
 * epic's) — the button renders NOTHING while that resolves or when it resolves
 * to `null` (no approved design bound to this entity's idea), so a card with no
 * design shows no dead affordance. Live: subscribes to
 * `cyboflow.ideaComponents.onComponentsChanged` (scoped by `projectId`, when
 * known) and re-resolves on ANY project-scoped event, so a design bound
 * mid-session (a gate's approve side-effect) makes the button appear without a
 * refresh — cheap enough (one read) that filtering by idea id isn't worth the
 * staleness risk of closing over the previous resolution.
 *
 * Two render targets, chosen by whether a center-pane `sessionKey` is in scope:
 *   - WITH `sessionKey` (a surface mounted inside a running session's own
 *     center pane, e.g. the sprint swimlane lane header): clicking opens the
 *     real `approved-design` center-pane tab via
 *     `centerPaneStore.openApprovedDesignTab` — the tab stays live after the
 *     button that opened it unmounts.
 *   - WITHOUT `sessionKey` (the Backlog board's TaskCard / TaskDetailModal,
 *     which have no session context to open a tab in): clicking opens a
 *     self-contained preview modal rendering the SAME `ApprovedDesignTab`
 *     content, so the viewer is identical either way.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Palette } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { Modal } from '../ui/Modal';
import { ApprovedDesignTab } from './ApprovedDesignTab';

interface ResolvedDesign {
  ideaId: string;
  ideaRef: string;
}

interface DesignAffordanceProps {
  /** The idea/epic/task id to resolve a bound approved design for. */
  entityId: string;
  projectId: number | null;
  /**
   * When set, clicking opens the `approved-design` tab in THIS session's
   * center pane instead of a preview modal — pass it only when this component
   * is mounted inside that session's own pane (see file header).
   */
  sessionKey?: string;
}

export function DesignAffordance({ entityId, projectId, sessionKey }: DesignAffordanceProps): ReactElement | null {
  const [resolved, setResolved] = useState<ResolvedDesign | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const openApprovedDesignTab = useCenterPaneStore((s) => s.openApprovedDesignTab);

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      trpc.cyboflow.design.forEntity.query({ entityId }).then(
        (result) => {
          if (cancelled) return;
          setResolved(result ? { ideaId: result.ideaId, ideaRef: result.ideaRef } : null);
        },
        () => {
          if (!cancelled) setResolved(null);
        },
      );
    };

    load();

    if (projectId === null) {
      return () => {
        cancelled = true;
      };
    }

    // Re-resolve on EVERY project-scoped ledger event rather than filtering by
    // the currently-resolved idea id: this entity's idea is not yet known when
    // nothing is bound (the affordance is hidden), and re-resolving is a cheap
    // single read either way.
    const sub = trpc.cyboflow.ideaComponents.onComponentsChanged.subscribe(
      { projectId },
      {
        onData: () => load(),
        onError: (err: unknown) => console.warn('[DesignAffordance] onComponentsChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [entityId, projectId]);

  if (resolved === null) return null;

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (sessionKey !== undefined) {
      openApprovedDesignTab(sessionKey, {
        ideaId: resolved.ideaId,
        ideaRef: resolved.ideaRef,
        label: `${resolved.ideaRef} · Design`,
      });
      return;
    }
    setPreviewOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        data-testid="design-affordance"
        aria-label={`Open approved design for ${resolved.ideaRef}`}
        title={`Open approved design (${resolved.ideaRef})`}
        className="inline-flex items-center gap-1 rounded-button border border-border-primary px-2 py-0.5 text-[10.5px] font-semibold text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <Palette className="h-3 w-3" strokeWidth={2.5} />
        Design
      </button>
      {sessionKey === undefined && (
        <Modal isOpen={previewOpen} onClose={() => setPreviewOpen(false)} size="xl">
          <div style={{ height: '70vh', minHeight: 0 }}>
            <ApprovedDesignTab ideaId={resolved.ideaId} ideaRef={resolved.ideaRef} projectId={projectId} />
          </div>
        </Modal>
      )}
    </>
  );
}
