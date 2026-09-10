/**
 * Narrow structural interfaces for the custom-views feature
 * (docs/proposals/CUSTOM-VIEWS.md §3.3, §4.6).
 *
 * These are the seams the store (S1), the query/action services (S2) and the
 * tRPC router (S3) meet at. Kept import-light (shared types only) so router
 * code never pulls DatabaseService / better-sqlite3 into its module graph.
 */
import type {
  CustomView,
  CustomViewSurface,
  CustomWidget,
  ViewLayout,
  WidgetSpec,
} from '../../../../shared/types/customViews';

/** A stored view whose layout_json failed to parse — surfaced, never hidden. */
export interface CorruptCustomView {
  id: string;
  surface: CustomViewSurface;
  name: string;
  revision: number;
  layout: null;
  corrupt: true;
  createdAt: string;
  updatedAt: string;
}

export type StoredCustomView = CustomView | CorruptCustomView;

export class CustomViewsStoreError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'name_taken'
      | 'concurrency'
      | 'unknown_widget'
      | 'in_use'
      | 'corrupt_layout'
      | 'session_mismatch'
      | 'no_draft',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CustomViewsStoreError';
  }
}

export interface CustomViewsStoreLike {
  listViews(surface: CustomViewSurface): StoredCustomView[];
  getView(id: string): StoredCustomView | null;
  createView(input: { surface: CustomViewSurface; name: string; layout: ViewLayout }): CustomView;
  updateView(input: {
    id: string;
    expectedRevision: number;
    name?: string;
    layout?: ViewLayout;
  }): CustomView;
  deleteView(id: string): boolean;

  listWidgets(): CustomWidget[];
  getWidget(id: string): CustomWidget | null;
  saveDraft(input: {
    id?: string;
    name: string;
    description?: string | null;
    spec: WidgetSpec;
    authoringSessionId: string;
    threadId?: string | null;
  }): CustomWidget;
  publishDraft(input: { id: string; authoringSessionId: string }): CustomWidget;
  discardDraft(input: { id: string; authoringSessionId: string }): CustomWidget | null;
  deleteWidget(id: string): boolean;

  getActiveViewId(surface: CustomViewSurface): string | null;
  setActiveViewId(surface: CustomViewSurface, viewId: string | null): void;
}
