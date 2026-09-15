/**
 * ViewIdentityContext — how a `WidgetHost` learns which SAVED view it is
 * rendering inside (docs/proposals/CUSTOM-VIEWS.md §4.4's consent model).
 *
 * `executeAction` requires `viewId` + `viewRevision`: the server re-loads that
 * exact stored view, re-resolves the layout item, and refuses on a revision
 * mismatch (`stale_view`). So a widget that is NOT rendering out of a saved
 * view — a customize-mode draft, an inspector preview, the Default view (which
 * has no widgets at all today) — has no legitimate identity to send, and every
 * action control on it must be disabled. Passing `null` here is exactly that
 * statement, and it is the DEFAULT: a host mounted outside a provider is
 * action-disabled rather than accidentally armed.
 *
 * `editing` is the second disable reason and is kept separate on purpose:
 * "unsaved" and "being edited" are different facts and S5 needs to explain each
 * differently in the UI.
 *
 * A context (not a prop drilled through `ViewSurface`) because the shape
 * components in `shape/` render row action buttons several levels down, and the
 * frame renders header ones — threading two fields through every shape's props
 * would put a consent-critical value in five places instead of one.
 */
import { createContext, useContext } from 'react';

export interface ViewIdentity {
  /** The saved view's id, or `null` when nothing saved backs this render. */
  viewId: string | null;
  /** The saved view's CAS revision, or `null`. */
  viewRevision: number | null;
  /** True while the surface is in customize mode. */
  editing: boolean;
}

const DEFAULT_IDENTITY: ViewIdentity = { viewId: null, viewRevision: null, editing: false };

export const ViewIdentityContext = createContext<ViewIdentity>(DEFAULT_IDENTITY);

export function useViewIdentity(): ViewIdentity {
  return useContext(ViewIdentityContext);
}

/**
 * Whether action controls may fire. False for a draft/unsaved render and false
 * in customize mode — the two conditions §4.4 names.
 */
export function actionsEnabled(identity: ViewIdentity): boolean {
  return !identity.editing && identity.viewId !== null && identity.viewRevision !== null;
}
