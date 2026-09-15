/**
 * WidgetLibraryModal — the "+ Add widget" library (docs/proposals/CUSTOM-VIEWS.md
 * §6, the "Widget library" artboard).
 *
 * Categories in a fixed order: **Sections** (this surface's tier-1 page
 * sections — a singleton already placed in the draft is disabled, never
 * hidden, so the user can see WHY it can't be added again), **Insights**,
 * **Stats**, **Lists** (the catalog's `insights` / `stats` / `sessions`
 * categories under friendlier library names), then **Mine** — custom widgets
 * with a `publishedSpec` (a draft-only widget has nothing to run yet, so it
 * is not offered here). The footer's **Create a custom widget** CTA is S6's:
 * it renders only when `onCreateCustom` is supplied, and is absent otherwise
 * — there is nothing useful the library can do with that click until the
 * assistant rail exists to receive it.
 */
import React, { useMemo } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../components/ui/Modal';
import { Chip, EmptyStrip, PrimaryButton, SecondaryButton } from '../../components/landing/QueuePrimitives';
import { useCustomViewsStore, useDraft } from '../../stores/customViewsStore';
import { catalogEntriesFor, type CatalogCategory, type CatalogEntry } from '../catalog';
import type { CustomViewSurface, WidgetRef } from '../../../../shared/types/customViews';

export interface WidgetLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  surface: CustomViewSurface;
  /** The layout index the chosen widget is inserted at. */
  insertAt: number;
  /** S6 fills this to open the assistant rail's kickoff; omitted hides the CTA entirely. */
  onCreateCustom?: (at: number) => void;
}

const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  queue: 'Sections',
  overview: 'Sections',
  insights: 'Insights',
  stats: 'Stats',
  sessions: 'Lists',
};
const CATEGORY_ORDER = ['Sections', 'Insights', 'Stats', 'Lists'] as const;

/** WidgetLibraryModal — see {@link WidgetLibraryModalProps}. */
export function WidgetLibraryModal({
  isOpen,
  onClose,
  surface,
  insertAt,
  onCreateCustom,
}: WidgetLibraryModalProps): React.JSX.Element {
  const draft = useDraft(surface);
  const widgets = useCustomViewsStore((s) => s.widgets);

  const placedSingletonIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of draft?.layout.items ?? []) {
      if (item.widget.type === 'catalog') set.add(item.widget.catalogId);
    }
    return set;
  }, [draft]);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogEntry[]>(CATEGORY_ORDER.map((label) => [label, []]));
    for (const entry of catalogEntriesFor(surface)) {
      map.get(CATEGORY_LABELS[entry.category])?.push(entry);
    }
    return map;
  }, [surface]);

  const mine = useMemo(() => widgets.filter((w) => w.publishedSpec !== null), [widgets]);

  const add = (ref: WidgetRef): void => {
    useCustomViewsStore.getState().insertItem(insertAt, ref);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" showCloseButton={false}>
      <ModalHeader title="Add a widget" onClose={onClose} />
      <ModalBody>
        <div className="flex flex-col gap-5">
          {CATEGORY_ORDER.map((label) => {
            const list = grouped.get(label) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={label}>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary">{label}</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {list.map((entry) => (
                    <LibraryCard
                      key={entry.id}
                      title={entry.title}
                      description={entry.description}
                      reads={entry.reads}
                      actions={entry.actions}
                      disabled={entry.singleton && placedSingletonIds.has(entry.id)}
                      onAdd={() => add({ type: 'catalog', catalogId: entry.id })}
                      testId={`library-card-${entry.id}`}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary">Mine</div>
            {mine.length === 0 ? (
              <EmptyStrip testId="library-mine-empty">No custom widgets yet.</EmptyStrip>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {mine.map((widget) => (
                  <LibraryCard
                    key={widget.id}
                    title={widget.name}
                    description={widget.description ?? ''}
                    reads={widget.publishedSpec !== null ? Object.keys(widget.publishedSpec.sources) : []}
                    actions={widget.publishedSpec?.actions?.map((a) => a.label) ?? []}
                    disabled={false}
                    onAdd={() => add({ type: 'custom', widgetId: widget.id })}
                    testId={`library-card-custom-${widget.id}`}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </ModalBody>
      {onCreateCustom !== undefined && (
        <ModalFooter>
          <PrimaryButton onClick={() => onCreateCustom(insertAt)} data-testid="library-create-custom">
            Create a custom widget
          </PrimaryButton>
        </ModalFooter>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface LibraryCardProps {
  title: string;
  description: string;
  reads: string[];
  actions: string[];
  disabled: boolean;
  onAdd: () => void;
  testId: string;
}

function LibraryCard({ title, description, reads, actions, disabled, onAdd, testId }: LibraryCardProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 border border-border-primary bg-surface-raised p-3" data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-bold text-text-primary">{title}</span>
        <SecondaryButton onClick={onAdd} disabled={disabled} data-testid={`${testId}-add`}>
          {disabled ? 'Added' : 'Add'}
        </SecondaryButton>
      </div>
      {description.length > 0 && <p className="text-[11px] text-text-tertiary">{description}</p>}
      {reads.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`${testId}-reads`}>
          {reads.map((r) => (
            <Chip key={r}>{r}</Chip>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`${testId}-actions`}>
          {actions.map((a) => (
            <Chip key={a} tone="success">
              {a}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
