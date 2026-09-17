/**
 * The action props every tier-2 shape that can render ROW buttons takes
 * (docs/proposals/CUSTOM-VIEWS.md §5.3).
 *
 * Row actions are declared on the spec, but the button lives inside the shape —
 * a table cell, a list row — so the host cannot render them itself. It hands
 * the shape the row-placement actions and one callback, and the shape reports
 * `(actionId, rowKeyValue)` back up. The VALUE, never the row: the server
 * re-runs the widget's data and re-finds the row by that key (§4.4's "row
 * actions never trust client-supplied row values"), so anything else the shape
 * knows about the row is not worth sending.
 */
import type { Scalar, WidgetAction } from '../../../../shared/types/customViews';

export interface ShapeActionProps {
  /** The spec's `placement: 'row'` actions. Omitted or empty renders no buttons. */
  rowActions?: WidgetAction[];
  /** True while the view is unsaved or in customize mode (§4.4). */
  actionsDisabled?: boolean;
  /** `<actionId>:<rowKeyValue>` currently in flight, so its button can show it. */
  busyActionKey?: string | null;
  /** Report a click. `rowKeyValue` is the value of the action's declared `rowKey`. */
  onAction?: (actionId: string, rowKeyValue: Scalar) => void;
}

/** The in-flight key for one row button — the shape and the host must agree. */
export function rowActionKey(actionId: string, rowKeyValue: Scalar): string {
  return `${actionId}:${String(rowKeyValue)}`;
}
