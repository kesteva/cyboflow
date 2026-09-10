/**
 * CustomViewsService — the ONE narrow dependency the tRPC router
 * (`main/src/orchestrator/trpc/routers/customViews.ts`) uses
 * (docs/proposals/CUSTOM-VIEWS.md §4.6, §9 row S3).
 *
 * Bundles the store (§3.3), the query engine (§4.2/§4.3 — `WidgetDataService`)
 * and the action engine (§4.4 — `WidgetActionService`) behind one interface so
 * the router imports neither `DatabaseService` nor `better-sqlite3`: it only
 * ever sees `CustomViewsServiceLike`, mirroring how `AgentThreadServiceLike` /
 * `AgentThreadStoreLike` keep `trpc/context.ts` clean (see that file's own
 * standalone-typecheck comment). `createCustomViewsService` is the ONE call
 * `main/src/index.ts` makes — it constructs the two inner services from the
 * raw collaborators (db, store, the proposal-preparation closures) so boot
 * wiring never has to know `WidgetDataService`/`WidgetActionService` exist.
 *
 * Widget-ref resolution (`runWidget`/`resetBreaker`'s `WidgetRef | {inline} |
 * {draftOf}` union) lives HERE, not in `WidgetDataService` — the data service
 * only ever sees an already-resolved `WidgetSpec` (§4.3's cache key is over
 * the resolved spec, not the ref), and turning a ref into a spec needs the
 * catalog map + the store, neither of which the data service depends on.
 *
 * Standalone-typecheck invariant: only shared types/validators, the narrow
 * `DatabaseLike`/`CustomViewsStoreLike` seams, and the two sibling services
 * (which themselves hold to the same invariant) are imported — no `electron`,
 * no `main/src/services/*`. `better-sqlite3` is a TYPE-ONLY reach (via
 * `openReadonlySibling`'s return type for `dbSchema`), same as
 * `widgetDataService.ts` already does.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalPreconditions,
} from '../../../../shared/types/agentThread';
import {
  DEFAULT_VIEW_ID,
  type CustomView,
  type CustomViewSurface,
  type CustomWidget,
  type Scalar,
  type ViewLayout,
  type WidgetDataPayload,
  type WidgetRef,
  type WidgetSpec,
} from '../../../../shared/types/customViews';
import { widgetSpecSchema } from '../../../../shared/customViews/validate';
import { openReadonlySibling } from '../readOnlyQuery';
import type { DatabaseLike } from '../types';
import type { ExecuteProposalResult } from '../agentThread/proposalExecutor';
import type { PrepareProposalResult } from '../agentThread/prepareProposal';
import { CustomViewsStoreError, type CustomViewsStoreLike, type StoredCustomView } from './types';
import { WidgetDataService, type WidgetKeyInput, type WidgetRunPayload } from './widgetDataService';
import {
  WidgetActionService,
  type ExecuteWidgetActionResult,
  type WidgetActionPreview,
  type WidgetActionTarget,
} from './widgetActionService';

// ---------------------------------------------------------------------------
// Shapes local to the service surface
// ---------------------------------------------------------------------------

/** How `runWidget`/`resetBreaker` name which spec to run — §4.6's `widget` input. */
export type RunWidgetRef = WidgetRef | { inline: WidgetSpec } | { draftOf: string };

export interface RunWidgetInput {
  widget: RunWidgetRef;
  settings: Record<string, Scalar>;
  /** Clamped by `WidgetDataService`; omitted falls back to the spec's own default. */
  refreshSec?: number;
  context: { projectId: number | null };
}

export interface ResetBreakerInput {
  widget: RunWidgetRef;
  settings: Record<string, Scalar>;
  context: { projectId: number | null };
}

/** `customViews.onWidgetDraft`'s payload (§7.3) — emitted by the MCP `cyboflow_widget_save` handler (S6). */
export interface WidgetDraftEvent {
  widgetId: string;
  authoringSessionId: string;
  kind: 'draft' | 'published';
}

export interface CustomViewsDbSchemaColumn {
  name: string;
  type: string;
  pk: boolean;
  notnull: boolean;
}

export interface CustomViewsDbSchemaTable {
  table: string;
  columns: CustomViewsDbSchemaColumn[];
  /** `null` for `raw_events` — a `COUNT(*)` over it is not cheap (§4.6). */
  rowEstimate: number | null;
}

// ---------------------------------------------------------------------------
// CustomViewsServiceLike — the router's ONE dependency
// ---------------------------------------------------------------------------

export interface CustomViewsServiceLike {
  listViews(surface: CustomViewSurface): StoredCustomView[];
  /** `'default'` when unset, or when the stored id no longer resolves on this surface. */
  getActiveView(surface: CustomViewSurface): { viewId: string };
  /** `DEFAULT_VIEW_ID` clears the preference (the sentinel is never stored). */
  setActiveView(surface: CustomViewSurface, viewId: string): void;
  createView(input: { surface: CustomViewSurface; name: string; layout: ViewLayout }): CustomView;
  updateView(input: { id: string; expectedRevision: number; name?: string; layout?: ViewLayout }): CustomView;
  deleteView(id: string): void;

  listWidgets(): CustomWidget[];
  getWidget(id: string): CustomWidget | null;
  /**
   * The assistant's ONE write entrypoint (S6, `cyboflow_widget_save`):
   * saves `spec` as a draft via `store.saveDraft`, then — when `publish` is
   * true — promotes it via `store.publishDraft` in the same call. Emits
   * exactly ONE `onWidgetDraft` event describing the FINAL outcome
   * (`kind:'draft'` when `publish` is false, `kind:'published'` when it
   * promoted), not one event per store call — the renderer's session-bound
   * live landing (§7.3) only needs to know where the widget ended up.
   * `id` omitted creates a new widget; a `session_mismatch` /
   * `not_found` from the store propagates unchanged (the MCP handler maps
   * it to the response `error` string).
   */
  saveWidget(input: {
    id?: string;
    name: string;
    description?: string | null;
    spec: WidgetSpec;
    authoringSessionId: string;
    threadId?: string | null;
    publish: boolean;
  }): CustomWidget;
  publishDraft(input: { id: string; authoringSessionId: string }): CustomWidget;
  discardDraft(input: { id: string; authoringSessionId: string }): CustomWidget | null;
  deleteWidget(id: string): void;

  runWidget(input: RunWidgetInput): Promise<WidgetDataPayload>;
  resetBreaker(input: ResetBreakerInput): void;
  previewAction(target: WidgetActionTarget): Promise<WidgetActionPreview>;
  executeAction(input: WidgetActionTarget & { operationId: string }): Promise<ExecuteWidgetActionResult>;

  dbSchema(): CustomViewsDbSchemaTable[];

  /** Subscribe to widget draft/publish events; returns an unsubscribe function. */
  onWidgetDraft(cb: (evt: WidgetDraftEvent) => void): () => void;
  /** Emitted by the MCP `cyboflow_widget_save` handler (S6) after every save. */
  emitWidgetDraft(evt: WidgetDraftEvent): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Double-quoted SQL identifier — table names here come from `sqlite_master` itself
 *  (never user input), but quoting is cheap defense-in-depth against an embedded `"`. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CustomViewsServiceDeps {
  store: CustomViewsStoreLike;
  data: WidgetDataService;
  actions: WidgetActionService;
  /** Catalog SPEC entries by id — section entries (no spec) are simply absent. */
  catalogSpecs: Record<string, WidgetSpec>;
  db: DatabaseLike;
}

export class CustomViewsService implements CustomViewsServiceLike {
  private readonly draftEvents = new EventEmitter();

  constructor(private readonly deps: CustomViewsServiceDeps) {}

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  listViews(surface: CustomViewSurface): StoredCustomView[] {
    return this.deps.store.listViews(surface);
  }

  getActiveView(surface: CustomViewSurface): { viewId: string } {
    const id = this.deps.store.getActiveViewId(surface);
    if (!id) return { viewId: DEFAULT_VIEW_ID };
    const view = this.deps.store.getView(id);
    // A corrupt view still "exists" (§3.3 — surfaced for delete, not hidden),
    // but a view that vanished or belongs to the OTHER surface is dangling.
    if (!view || view.surface !== surface) return { viewId: DEFAULT_VIEW_ID };
    return { viewId: id };
  }

  setActiveView(surface: CustomViewSurface, viewId: string): void {
    if (viewId === DEFAULT_VIEW_ID) {
      this.deps.store.setActiveViewId(surface, null);
      return;
    }
    const view = this.deps.store.getView(viewId);
    if (!view || view.surface !== surface) {
      throw new CustomViewsStoreError('not_found', viewId);
    }
    this.deps.store.setActiveViewId(surface, viewId);
  }

  createView(input: { surface: CustomViewSurface; name: string; layout: ViewLayout }): CustomView {
    return this.deps.store.createView(input);
  }

  updateView(input: { id: string; expectedRevision: number; name?: string; layout?: ViewLayout }): CustomView {
    return this.deps.store.updateView(input);
  }

  deleteView(id: string): void {
    const deleted = this.deps.store.deleteView(id);
    if (!deleted) throw new CustomViewsStoreError('not_found', id);
  }

  // -------------------------------------------------------------------------
  // Widgets
  // -------------------------------------------------------------------------

  listWidgets(): CustomWidget[] {
    return this.deps.store.listWidgets();
  }

  getWidget(id: string): CustomWidget | null {
    return this.deps.store.getWidget(id);
  }

  saveWidget(input: {
    id?: string;
    name: string;
    description?: string | null;
    spec: WidgetSpec;
    authoringSessionId: string;
    threadId?: string | null;
    publish: boolean;
  }): CustomWidget {
    const draft = this.deps.store.saveDraft({
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      spec: input.spec,
      authoringSessionId: input.authoringSessionId,
      threadId: input.threadId ?? null,
    });
    const widget = input.publish
      ? this.deps.store.publishDraft({ id: draft.id, authoringSessionId: input.authoringSessionId })
      : draft;
    this.emitWidgetDraft({
      widgetId: widget.id,
      authoringSessionId: input.authoringSessionId,
      kind: input.publish ? 'published' : 'draft',
    });
    return widget;
  }

  publishDraft(input: { id: string; authoringSessionId: string }): CustomWidget {
    return this.deps.store.publishDraft(input);
  }

  discardDraft(input: { id: string; authoringSessionId: string }): CustomWidget | null {
    return this.deps.store.discardDraft(input);
  }

  deleteWidget(id: string): void {
    const deleted = this.deps.store.deleteWidget(id);
    if (!deleted) throw new CustomViewsStoreError('not_found', id);
  }

  // -------------------------------------------------------------------------
  // Query engine
  // -------------------------------------------------------------------------

  async runWidget(input: RunWidgetInput): Promise<WidgetRunPayload> {
    const spec = this.resolveWidgetSpec(input.widget);
    return this.deps.data.run({
      spec,
      settings: input.settings,
      context: input.context,
      ...(input.refreshSec !== undefined ? { refreshSec: input.refreshSec } : {}),
    });
  }

  resetBreaker(input: ResetBreakerInput): void {
    const spec = this.resolveWidgetSpec(input.widget);
    this.deps.data.resetBreaker({ spec, settings: input.settings, context: input.context });
  }

  /**
   * Resolve a `RunWidgetRef` to the `WidgetSpec` `WidgetDataService` runs.
   * `{draftOf}` is the ONLY path that ever reads `draftSpec` — a plain
   * `{type:'custom'}` ref (what every saved layout item carries) always runs
   * the PUBLISHED spec, matching `WidgetActionService.resolveSpec`'s same
   * rule for actions (§4.4: "a draft never executes actions").
   */
  private resolveWidgetSpec(ref: RunWidgetRef): WidgetSpec {
    if ('inline' in ref) {
      const parsed = widgetSpecSchema.safeParse(ref.inline);
      if (!parsed.success) {
        throw new Error(`invalid_spec:${parsed.error.issues[0]?.message ?? 'invalid widget spec'}`);
      }
      return parsed.data;
    }
    if ('draftOf' in ref) {
      const widget = this.deps.store.getWidget(ref.draftOf);
      if (!widget) throw new CustomViewsStoreError('not_found', ref.draftOf);
      if (!widget.draftSpec) throw new CustomViewsStoreError('no_draft', ref.draftOf);
      return widget.draftSpec;
    }
    if (ref.type === 'catalog') {
      const spec = this.deps.catalogSpecs[ref.catalogId];
      // A section entry (tier 1) carries no spec by design (the page owns its
      // data) — from runWidget's point of view that is indistinguishable from
      // an unknown catalog id, mirroring WidgetActionService.resolveSpec.
      if (!spec) throw new CustomViewsStoreError('not_found', ref.catalogId);
      return spec;
    }
    const widget = this.deps.store.getWidget(ref.widgetId);
    if (!widget) throw new CustomViewsStoreError('not_found', ref.widgetId);
    if (!widget.publishedSpec) throw new CustomViewsStoreError('draft_only', ref.widgetId);
    return widget.publishedSpec;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async previewAction(target: WidgetActionTarget): Promise<WidgetActionPreview> {
    const result = await this.deps.actions.preview(target);
    if (!result.ok) throw new Error(result.error);
    return result.preview;
  }

  /**
   * Returned UNCHANGED — the discriminated `ExecuteWidgetActionResult`
   * (navigate / replay / executor result / resolve failure) IS the router's
   * output shape; there is nothing to unwrap or re-throw (§4.4 step 6: "the
   * discriminated ExecuteProposalResult ... passed through unchanged").
   */
  async executeAction(input: WidgetActionTarget & { operationId: string }): Promise<ExecuteWidgetActionResult> {
    return this.deps.actions.executeAction(input);
  }

  // -------------------------------------------------------------------------
  // Schema introspection (§4.6 `dbSchema`)
  // -------------------------------------------------------------------------

  dbSchema(): CustomViewsDbSchemaTable[] {
    const handle = openReadonlySibling(this.deps.db);
    const tables = handle
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;

    return tables.map(({ name }) => {
      const quoted = quoteIdentifier(name);
      const columnRows = handle.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
        name: string;
        type: string;
        pk: number;
        notnull: number;
      }>;
      const columns: CustomViewsDbSchemaColumn[] = columnRows.map((c) => ({
        name: c.name,
        type: c.type,
        pk: c.pk > 0,
        notnull: c.notnull > 0,
      }));
      // raw_events can carry many millions of rows — a COUNT(*) over it is
      // not the "cheap" estimate §4.6 asks for, so it is skipped (null) here.
      const rowEstimate =
        name === 'raw_events'
          ? null
          : ((handle.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get() as { c: number } | undefined)?.c ?? 0);
      return { table: name, columns, rowEstimate };
    });
  }

  // -------------------------------------------------------------------------
  // onWidgetDraft
  // -------------------------------------------------------------------------

  onWidgetDraft(cb: (evt: WidgetDraftEvent) => void): () => void {
    this.draftEvents.on('draft', cb);
    return () => this.draftEvents.off('draft', cb);
  }

  emitWidgetDraft(evt: WidgetDraftEvent): void {
    this.draftEvents.emit('draft', evt);
  }
}

// ---------------------------------------------------------------------------
// createCustomViewsService — index.ts's ONE call
// ---------------------------------------------------------------------------

export interface CreateCustomViewsServiceDeps {
  db: DatabaseLike;
  store: CustomViewsStoreLike;
  /** Catalog SPEC entries by id (`shared/customViews/catalogSpecs.ts`'s `CATALOG_WIDGET_SPECS`). */
  catalogSpecs: Record<string, WidgetSpec>;
  ensureGlobalThreadId: () => string;
  createProposal(input: {
    id: string;
    threadId: string;
    payload: AgentProposalPayload;
    preconditions: AgentProposalPreconditions | null;
  }): AgentProposal;
  prepare(raw: unknown): PrepareProposalResult;
  execute(proposalId: string): Promise<ExecuteProposalResult>;
  getProposal(id: string): AgentProposal | null;
  /** Injectable id/clock seams for tests; default to `randomUUID`/`Date`. */
  newId?: () => string;
  now?: () => Date;
}

/**
 * Construct `WidgetDataService` + `WidgetActionService` from the raw
 * collaborators and wrap them in `CustomViewsService` — the ONE call
 * `main/src/index.ts` makes so boot wiring never has to know the two inner
 * services exist (docs/proposals/CUSTOM-VIEWS.md §9 row S3).
 */
export function createCustomViewsService(deps: CreateCustomViewsServiceDeps): CustomViewsServiceLike {
  const data = new WidgetDataService({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) });
  const actions = new WidgetActionService({
    store: deps.store,
    data,
    catalogSpecs: deps.catalogSpecs,
    db: deps.db,
    ensureGlobalThreadId: deps.ensureGlobalThreadId,
    createProposal: deps.createProposal,
    prepare: deps.prepare,
    execute: deps.execute,
    getProposal: deps.getProposal,
    newId: deps.newId ?? randomUUID,
  });
  return new CustomViewsService({ store: deps.store, data, actions, catalogSpecs: deps.catalogSpecs, db: deps.db });
}

// Re-exported so callers (the router, its tests) can name the query-engine
// input shape without reaching into widgetDataService.ts directly.
export type { WidgetKeyInput };
