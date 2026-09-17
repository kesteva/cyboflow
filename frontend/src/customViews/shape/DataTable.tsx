/**
 * DataTable — the tier-2 `table` shape.
 *
 * Columns are DECLARED, never inferred from the rows: the spec lists exactly
 * which fields render, in which order, under which label and format. A source
 * that grows a column therefore cannot silently widen a saved widget, and a
 * column the source stopped returning renders an em dash instead of `undefined`.
 *
 * The table scrolls horizontally inside its own container rather than pushing
 * the page wide — a widget sits in a fixed single-column stack and must not be
 * able to change the page's geometry.
 */
import type { Scalar, WidgetValueFormat } from '../../../../shared/types/customViews';
import { formatWidgetValue } from '../format';
import { GhostButton } from '../../components/landing/QueuePrimitives';
import { rowActionKey, type ShapeActionProps } from './shapeTypes';

export interface DataTableColumn {
  field: string;
  label?: string;
  format?: WidgetValueFormat;
}

export interface DataTableProps extends ShapeActionProps {
  rows: ReadonlyArray<Record<string, Scalar>>;
  columns: DataTableColumn[];
}

/** DataTable — see {@link DataTableProps}. */
export function DataTable({
  rows,
  columns,
  rowActions = [],
  actionsDisabled = false,
  busyActionKey = null,
  onAction,
}: DataTableProps): React.JSX.Element {
  return (
    <div className="overflow-x-auto border border-border-primary bg-surface-raised">
      <table data-testid="widget-table" className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-border-primary">
            {columns.map((col) => (
              <th
                key={col.field}
                scope="col"
                className="px-2.5 py-1.5 text-left font-bold text-text-secondary"
              >
                {col.label ?? col.field}
              </th>
            ))}
            {rowActions.length > 0 && <th scope="col" className="px-2.5 py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border-primary last:border-b-0">
              {columns.map((col) => (
                <td key={col.field} className="px-2.5 py-1.5 tabular-nums text-text-primary">
                  {formatWidgetValue(row[col.field] ?? null, col.format)}
                </td>
              ))}
              {rowActions.length > 0 && (
                <td className="whitespace-nowrap px-2.5 py-1.5 text-right">
                  {rowActions.map((action) => {
                    const keyValue: Scalar =
                      action.rowKey !== undefined ? (row[action.rowKey] ?? null) : null;
                    const busy = busyActionKey === rowActionKey(action.id, keyValue);
                    return (
                      <GhostButton
                        key={action.id}
                        className="ml-2"
                        disabled={actionsDisabled || busy}
                        onClick={() => onAction?.(action.id, keyValue)}
                        data-testid={`widget-row-action-${action.id}-${String(keyValue)}`}
                      >
                        {busy ? '…' : action.label}
                      </GhostButton>
                    );
                  })}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
