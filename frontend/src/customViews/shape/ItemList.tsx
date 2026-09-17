/**
 * ItemList — the tier-2 `list` shape: title, optional subtitle, optional meta,
 * and the row actions.
 *
 * The queue's own row idiom (a bold title, a muted trailing descriptor, actions
 * pinned right) rather than a generic list, so a widget's rows sit next to the
 * page's real sections without announcing themselves as foreign.
 */
import type { Scalar } from '../../../../shared/types/customViews';
import { GhostButton } from '../../components/landing/QueuePrimitives';
import { rowActionKey, type ShapeActionProps } from './shapeTypes';

export interface ItemListProps extends ShapeActionProps {
  rows: ReadonlyArray<Record<string, Scalar>>;
  /** Row field holding the row's headline. */
  title: string;
  subtitle?: string;
  meta?: string;
}

/** ItemList — see {@link ItemListProps}. */
export function ItemList({
  rows,
  title,
  subtitle,
  meta,
  rowActions = [],
  actionsDisabled = false,
  busyActionKey = null,
  onAction,
}: ItemListProps): React.JSX.Element {
  return (
    <ul data-testid="widget-list" className="flex flex-col">
      {rows.map((row, i) => (
        <li
          key={i}
          className="flex items-center gap-2 border-b border-border-primary px-2.5 py-1.5 text-[11px] last:border-b-0"
        >
          <span className="truncate font-bold text-text-primary">
            {String(row[title] ?? '')}
          </span>
          {subtitle !== undefined && (
            <span className="shrink-0 text-text-tertiary">{String(row[subtitle] ?? '')}</span>
          )}
          {meta !== undefined && (
            <span className="ml-auto shrink-0 tabular-nums text-text-tertiary">
              {String(row[meta] ?? '')}
            </span>
          )}
          {rowActions.map((action) => {
            const keyValue: Scalar =
              action.rowKey !== undefined ? (row[action.rowKey] ?? null) : null;
            const busy = busyActionKey === rowActionKey(action.id, keyValue);
            return (
              <GhostButton
                key={action.id}
                className={meta === undefined ? 'ml-auto' : 'ml-2'}
                disabled={actionsDisabled || busy}
                onClick={() => onAction?.(action.id, keyValue)}
                data-testid={`widget-row-action-${action.id}-${String(keyValue)}`}
              >
                {busy ? '…' : action.label}
              </GhostButton>
            );
          })}
        </li>
      ))}
    </ul>
  );
}
