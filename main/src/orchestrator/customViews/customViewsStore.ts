/**
 * CustomViewsDbStore — persistence for Custom Views (migration 132,
 * docs/proposals/CUSTOM-VIEWS.md §3.2/§3.3).
 *
 * Three tables, one store: `custom_views` (named per-surface layouts, CAS'd
 * on `revision`), `custom_widgets` (the user's widget library, with a
 * published/draft split so an in-progress assistant edit never clobbers what
 * every other surface renders — §7.3), and the active-view preference, which
 * piggybacks on the existing `user_preferences` KV table under
 * `customViews.active.<surface>` rather than a fourth table.
 *
 * READ PATHS NEVER THROW ON A MALFORMED ROW. `layout_json` / `*_spec_json`
 * are parsed through the shared zod schemas (`shared/customViews/validate.ts`)
 * on every read; a view whose JSON fails to parse degrades to a
 * `CorruptCustomView` (`layout: null, corrupt: true`) instead of hiding the
 * row or throwing, so the switcher can surface it and offer delete (§3.3).
 * There is no logger dependency — a parse failure is reported to the CALLER
 * via the return shape, not logged here.
 *
 * `deleteWidget` fails CLOSED: it parses every stored view's layout before
 * deleting, and a single unparsable layout anywhere refuses the delete
 * (`corrupt_layout`) rather than risk silently orphaning a reference a
 * corrupt row happens to hold (§3.3).
 *
 * `createId` / `now` are injected (defaulting to `randomUUID` / an ISO
 * `Date`) so tests get deterministic ids and timestamps — mirrors
 * `AgentThreadDbStore`'s `AgentThreadIdFactory` pattern. Timestamps are
 * stamped by the STORE (not left to SQLite's `DATETIME DEFAULT
 * CURRENT_TIMESTAMP`, which is a non-ISO `'YYYY-MM-DD HH:MM:SS'`), so every
 * `createdAt`/`updatedAt` the store returns is an ISO string.
 *
 * Standalone-typecheck invariant: only the narrow `DatabaseLike` (see
 * `../types`) and shared types/validators are imported — no `better-sqlite3`,
 * no `electron`, no `node:fs`.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseLike } from '../types';
import type {
  CustomView,
  CustomViewSurface,
  CustomWidget,
  ViewLayout,
  WidgetSpec,
} from '../../../../shared/types/customViews';
import { customViewNameSchema, viewLayoutSchema, widgetSpecSchema } from '../../../../shared/customViews/validate';
import {
  CustomViewsStoreError,
  type CorruptCustomView,
  type CustomViewsStoreLike,
  type StoredCustomView,
} from './types';

/** `now()` factory — ISO 8601, matching `CustomView`/`CustomWidget`'s `createdAt`/`updatedAt` contract. */
export type NowFactory = () => string;
export type IdFactory = () => string;

interface CustomViewRow {
  id: string;
  surface: CustomViewSurface;
  name: string;
  layout_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface CustomWidgetRow {
  id: string;
  name: string;
  description: string | null;
  published_spec_json: string | null;
  draft_spec_json: string | null;
  authoring_session_id: string | null;
  revision: number;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}

function activeViewPrefKey(surface: CustomViewSurface): string {
  return `customViews.active.${surface}`;
}

/**
 * Parses `layout_json` through the shared zod schema, treating a JSON syntax
 * error exactly like a schema-shape failure — both mean "this row's layout
 * is unusable" and must degrade to `undefined`, never throw. `JSON.parse`
 * itself throws SyntaxError on malformed text, which zod's `safeParse` never
 * sees unless the parse is wrapped here.
 */
function tryParseLayout(layoutJson: string): ViewLayout | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(layoutJson);
  } catch {
    return undefined;
  }
  const result = viewLayoutSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** True when the message names a UNIQUE-constraint violation on `custom_views`'s (surface, name) index. */
function isSurfaceNameUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(message) && (/idx_custom_views_surface_name/i.test(message) || /custom_views/i.test(message));
}

export class CustomViewsDbStore implements CustomViewsStoreLike {
  constructor(
    private readonly db: DatabaseLike,
    private readonly createId: IdFactory = randomUUID,
    private readonly now: NowFactory = () => new Date().toISOString(),
  ) {}

  // ---------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------

  listViews(surface: CustomViewSurface): StoredCustomView[] {
    const rows = this.db
      .prepare(
        `SELECT id, surface, name, layout_json, revision, created_at, updated_at
           FROM custom_views
          WHERE surface = ?
          ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(surface) as CustomViewRow[];
    return rows.map((row) => this.toStoredView(row));
  }

  getView(id: string): StoredCustomView | null {
    const row = this.db
      .prepare(
        `SELECT id, surface, name, layout_json, revision, created_at, updated_at
           FROM custom_views
          WHERE id = ?`,
      )
      .get(id) as CustomViewRow | undefined;
    return row ? this.toStoredView(row) : null;
  }

  createView(input: { surface: CustomViewSurface; name: string; layout: ViewLayout }): CustomView {
    // Shape/cross-field validation is NOT one of CustomViewsStoreError's codes
    // (name_taken/unknown_widget/etc. are store-level SEMANTIC errors, not
    // "this input is malformed") — a bad name or layout throws the schema's
    // own ZodError, same as any other programmer-error input. The router
    // (S3) is expected to validate before calling in, so this is
    // defense-in-depth, not the primary validation surface.
    const name = customViewNameSchema.parse(input.name);
    const layout = viewLayoutSchema.parse(input.layout);

    const run = this.db.transaction(() => {
      this.assertWidgetRefsExist(layout);

      const id = this.createId();
      const stamp = this.now();
      try {
        this.db
          .prepare(
            `INSERT INTO custom_views (id, surface, name, layout_json, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(id, input.surface, name, JSON.stringify(layout), stamp, stamp);
      } catch (err) {
        if (isSurfaceNameUniqueViolation(err)) {
          throw new CustomViewsStoreError('name_taken', `a view named '${name}' already exists on '${input.surface}'`);
        }
        throw err;
      }
      return id;
    });

    const id = run();
    const created = this.getView(id);
    if (!created || 'corrupt' in created) {
      throw new Error(`CustomViewsDbStore: failed to read back created view ${id}`);
    }
    return created;
  }

  updateView(input: { id: string; expectedRevision: number; name?: string; layout?: ViewLayout }): CustomView {
    // See createView's comment: shape validation throws the schema's own
    // ZodError, not a CustomViewsStoreError code.
    const parsedName: string | undefined = input.name !== undefined ? customViewNameSchema.parse(input.name) : undefined;
    const parsedLayout: ViewLayout | undefined = input.layout !== undefined ? viewLayoutSchema.parse(input.layout) : undefined;

    const run = this.db.transaction(() => {
      if (parsedLayout) {
        this.assertWidgetRefsExist(parsedLayout);
      }

      const stamp = this.now();
      let changes: number;
      try {
        changes = this.db
          .prepare(
            `UPDATE custom_views
                SET name = COALESCE(?, name),
                    layout_json = COALESCE(?, layout_json),
                    revision = revision + 1,
                    updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(parsedName ?? null, parsedLayout ? JSON.stringify(parsedLayout) : null, stamp, input.id, input.expectedRevision).changes;
      } catch (err) {
        if (isSurfaceNameUniqueViolation(err)) {
          throw new CustomViewsStoreError('name_taken', `a view named '${parsedName ?? input.name}' already exists on this surface`);
        }
        throw err;
      }

      if (changes === 0) {
        const exists = this.db.prepare(`SELECT 1 FROM custom_views WHERE id = ?`).get(input.id);
        throw new CustomViewsStoreError(exists ? 'concurrency' : 'not_found');
      }
    });

    run();
    const updated = this.getView(input.id);
    if (!updated || 'corrupt' in updated) {
      throw new Error(`CustomViewsDbStore: failed to read back updated view ${input.id}`);
    }
    return updated;
  }

  deleteView(id: string): boolean {
    const existing = this.getView(id);
    const result = this.db.prepare(`DELETE FROM custom_views WHERE id = ?`).run(id);
    const deleted = result.changes > 0;
    if (deleted && existing) {
      const activeId = this.getActiveViewId(existing.surface);
      if (activeId === id) {
        this.setActiveViewId(existing.surface, null);
      }
    }
    return deleted;
  }

  /** Throws `unknown_widget` for the first `{type:'custom'}` ref that does not name an existing widget row. */
  private assertWidgetRefsExist(layout: ViewLayout): void {
    const stmt = this.db.prepare(`SELECT 1 FROM custom_widgets WHERE id = ?`);
    for (const item of layout.items) {
      if (item.widget.type !== 'custom') continue;
      const found = stmt.get(item.widget.widgetId);
      if (!found) {
        throw new CustomViewsStoreError('unknown_widget', item.widget.widgetId);
      }
    }
  }

  private toStoredView(row: CustomViewRow): StoredCustomView {
    const layout = tryParseLayout(row.layout_json);
    if (!layout) {
      const corrupt: CorruptCustomView = {
        id: row.id,
        surface: row.surface,
        name: row.name,
        revision: row.revision,
        layout: null,
        corrupt: true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      return corrupt;
    }
    return {
      id: row.id,
      surface: row.surface,
      name: row.name,
      layout,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------
  // Widgets
  // ---------------------------------------------------------------------

  listWidgets(): CustomWidget[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, published_spec_json, draft_spec_json, authoring_session_id,
                revision, thread_id, created_at, updated_at
           FROM custom_widgets
          ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as CustomWidgetRow[];
    return rows.map((row) => this.toWidget(row));
  }

  getWidget(id: string): CustomWidget | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, published_spec_json, draft_spec_json, authoring_session_id,
                revision, thread_id, created_at, updated_at
           FROM custom_widgets
          WHERE id = ?`,
      )
      .get(id) as CustomWidgetRow | undefined;
    return row ? this.toWidget(row) : null;
  }

  saveDraft(input: {
    id?: string;
    name: string;
    description?: string | null;
    spec: WidgetSpec;
    authoringSessionId: string;
    threadId?: string | null;
  }): CustomWidget {
    const stamp = this.now();
    const specJson = JSON.stringify(input.spec);

    if (!input.id) {
      const id = this.createId();
      this.db
        .prepare(
          `INSERT INTO custom_widgets
             (id, name, description, published_spec_json, draft_spec_json, authoring_session_id,
              revision, thread_id, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)`,
        )
        .run(id, input.name, input.description ?? null, specJson, input.authoringSessionId, input.threadId ?? null, stamp, stamp);
      return this.mustGetWidget(id);
    }

    const existing = this.db
      .prepare(`SELECT authoring_session_id FROM custom_widgets WHERE id = ?`)
      .get(input.id) as { authoring_session_id: string | null } | undefined;
    if (!existing) {
      throw new CustomViewsStoreError('not_found', input.id);
    }
    if (existing.authoring_session_id !== null && existing.authoring_session_id !== input.authoringSessionId) {
      throw new CustomViewsStoreError('session_mismatch', input.id);
    }

    this.db
      .prepare(
        `UPDATE custom_widgets
            SET draft_spec_json = ?,
                name = ?,
                description = ?,
                authoring_session_id = ?,
                thread_id = ?,
                revision = revision + 1,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(specJson, input.name, input.description ?? null, input.authoringSessionId, input.threadId ?? null, stamp, input.id);
    return this.mustGetWidget(input.id);
  }

  publishDraft(input: { id: string; authoringSessionId: string }): CustomWidget {
    const row = this.db
      .prepare(`SELECT draft_spec_json, authoring_session_id FROM custom_widgets WHERE id = ?`)
      .get(input.id) as { draft_spec_json: string | null; authoring_session_id: string | null } | undefined;
    if (!row) {
      throw new CustomViewsStoreError('not_found', input.id);
    }
    if (row.draft_spec_json === null) {
      throw new CustomViewsStoreError('no_draft', input.id);
    }
    if (row.authoring_session_id !== input.authoringSessionId) {
      throw new CustomViewsStoreError('session_mismatch', input.id);
    }

    const stamp = this.now();
    this.db
      .prepare(
        `UPDATE custom_widgets
            SET published_spec_json = draft_spec_json,
                draft_spec_json = NULL,
                authoring_session_id = NULL,
                revision = revision + 1,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(stamp, input.id);
    return this.mustGetWidget(input.id);
  }

  discardDraft(input: { id: string; authoringSessionId: string }): CustomWidget | null {
    const row = this.db
      .prepare(`SELECT authoring_session_id, published_spec_json FROM custom_widgets WHERE id = ?`)
      .get(input.id) as { authoring_session_id: string | null; published_spec_json: string | null } | undefined;
    if (!row) {
      return null;
    }
    if (row.authoring_session_id !== input.authoringSessionId) {
      throw new CustomViewsStoreError('session_mismatch', input.id);
    }

    if (row.published_spec_json === null) {
      this.db.prepare(`DELETE FROM custom_widgets WHERE id = ?`).run(input.id);
      return null;
    }

    const stamp = this.now();
    this.db
      .prepare(
        `UPDATE custom_widgets
            SET draft_spec_json = NULL,
                authoring_session_id = NULL,
                revision = revision + 1,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(stamp, input.id);
    return this.mustGetWidget(input.id);
  }

  deleteWidget(id: string): boolean {
    const run = this.db.transaction(() => {
      const viewRows = this.db
        .prepare(`SELECT id, layout_json FROM custom_views`)
        .all() as Array<{ id: string; layout_json: string }>;
      for (const viewRow of viewRows) {
        const layout = tryParseLayout(viewRow.layout_json);
        if (!layout) {
          // Fail closed: an unparsable layout anywhere might reference this
          // widget and we cannot prove otherwise — refuse the delete rather
          // than risk silently orphaning a reference (§3.3).
          throw new CustomViewsStoreError('corrupt_layout', viewRow.id);
        }
        const inUse = layout.items.some((item) => item.widget.type === 'custom' && item.widget.widgetId === id);
        if (inUse) {
          throw new CustomViewsStoreError('in_use', viewRow.id);
        }
      }
      return this.db.prepare(`DELETE FROM custom_widgets WHERE id = ?`).run(id).changes > 0;
    });
    return run();
  }

  private mustGetWidget(id: string): CustomWidget {
    const widget = this.getWidget(id);
    if (!widget) {
      throw new Error(`CustomViewsDbStore: failed to read back widget ${id}`);
    }
    return widget;
  }

  /**
   * Parses `published_spec_json` / `draft_spec_json` through `widgetSpecSchema`.
   * An unparsable spec degrades to `null` for that field (never throws) — the
   * shared `CustomWidget` type has no `corrupt` flag (unlike `StoredCustomView`),
   * so there is nowhere to surface a parse failure short of dropping the value.
   */
  private toWidget(row: CustomWidgetRow): CustomWidget {
    const publishedSpec = row.published_spec_json ? this.parseSpecOrNull(row.published_spec_json) : null;
    const draftSpec = row.draft_spec_json ? this.parseSpecOrNull(row.draft_spec_json) : null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      publishedSpec,
      draftSpec,
      authoringSessionId: row.authoring_session_id,
      revision: row.revision,
      threadId: row.thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseSpecOrNull(json: string): WidgetSpec | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return null;
    }
    const parsed = widgetSpecSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  // ---------------------------------------------------------------------
  // Active view preference (existing `user_preferences` KV table)
  // ---------------------------------------------------------------------

  getActiveViewId(surface: CustomViewSurface): string | null {
    const row = this.db
      .prepare(`SELECT value FROM user_preferences WHERE key = ?`)
      .get(activeViewPrefKey(surface)) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setActiveViewId(surface: CustomViewSurface, viewId: string | null): void {
    const key = activeViewPrefKey(surface);
    if (viewId === null) {
      this.db.prepare(`DELETE FROM user_preferences WHERE key = ?`).run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO user_preferences (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(key, viewId);
  }
}
