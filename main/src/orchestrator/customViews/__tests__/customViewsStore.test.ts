/**
 * Unit tests for CustomViewsDbStore (migration 132,
 * docs/proposals/CUSTOM-VIEWS.md §3.3) against a real better-sqlite3 temp
 * file DB with migration 132 applied directly (mirrors
 * agentThreadDbStore.test.ts's targeted-migration-file technique).
 *
 * `user_preferences` is created IMPERATIVELY by DatabaseService
 * (main/src/database/database.ts, ~L1047) rather than by a migration file or
 * schema.sql — its DDL is mirrored here so getActiveViewId/setActiveViewId
 * have a real table to work against.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CustomViewsDbStore } from '../customViewsStore';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { CustomViewsStoreError } from '../types';
import type { ViewLayout, WidgetSpec } from '../../../../../shared/types/customViews';

const MIGRATION_132 = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '132_custom_views.sql'), 'utf-8');

// Mirrors database.ts's imperative user_preferences DDL exactly.
const USER_PREFERENCES_DDL = `
  CREATE TABLE user_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(MIGRATION_132);
  db.exec(USER_PREFERENCES_DDL);
  return db;
}

/** A store with deterministic, sequential ids and a tick-forward ISO clock. */
function makeStore(db: Database.Database): CustomViewsDbStore {
  let idSeq = 0;
  let clockSeq = 0;
  const createId = () => `id-${++idSeq}`;
  const now = () => new Date(2026, 0, 1, 0, 0, clockSeq++).toISOString();
  return new CustomViewsDbStore(dbAdapter(db), createId, now);
}

function emptyLayout(): ViewLayout {
  return { version: 1, items: [] };
}

function layoutReferencing(widgetId: string): ViewLayout {
  return {
    version: 1,
    items: [{ instanceId: 'item-1', widget: { type: 'custom', widgetId }, settings: {} }],
  };
}

const widgetSpec: WidgetSpec = {
  version: 1,
  sources: { rows: { type: 'sql', sql: 'SELECT 1 as n' } },
  render: { type: 'shape', shape: 'stat', source: 'rows', value: 'n' },
};

/** Catches the thrown CustomViewsStoreError and returns its `.code`, or fails if a different error (or none) was thrown. */
function codeOf(fn: () => unknown): CustomViewsStoreError['code'] {
  try {
    fn();
  } catch (err) {
    if (err instanceof CustomViewsStoreError) return err.code;
    throw err;
  }
  throw new Error('expected fn() to throw a CustomViewsStoreError');
}

describe('CustomViewsDbStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('views: create/list/get', () => {
    it('creates a view and reads it back via getView and listViews', () => {
      const store = makeStore(db);
      const created = store.createView({ surface: 'review-queue', name: 'My View', layout: emptyLayout() });
      expect(created.id).toBe('id-1');
      expect(created.surface).toBe('review-queue');
      expect(created.name).toBe('My View');
      expect(created.layout).toEqual(emptyLayout());
      expect(created.revision).toBe(1);
      expect(typeof created.createdAt).toBe('string');
      expect(created.createdAt).toBe(created.updatedAt);

      expect(store.getView('id-1')).toEqual(created);
      expect(store.listViews('review-queue')).toEqual([created]);
      expect(store.listViews('project-overview')).toEqual([]);
    });

    it('returns null for a missing view', () => {
      const store = makeStore(db);
      expect(store.getView('nope')).toBeNull();
    });

    it('name_taken is case-insensitive within a surface but not across surfaces', () => {
      const store = makeStore(db);
      store.createView({ surface: 'review-queue', name: 'My View', layout: emptyLayout() });

      expect(codeOf(() => store.createView({ surface: 'review-queue', name: 'my view', layout: emptyLayout() }))).toBe(
        'name_taken',
      );
      // Same (any-case) name on the OTHER surface is fine.
      expect(() =>
        store.createView({ surface: 'project-overview', name: 'MY VIEW', layout: emptyLayout() }),
      ).not.toThrow();
    });
  });

  describe('unknown_widget', () => {
    it('createView rejects a layout referencing a non-existent custom widget', () => {
      const store = makeStore(db);
      expect(
        codeOf(() => store.createView({ surface: 'review-queue', name: 'V1', layout: layoutReferencing('missing-widget') })),
      ).toBe('unknown_widget');
      // Nothing was inserted.
      expect(store.listViews('review-queue')).toEqual([]);
    });

    it('createView succeeds when the referenced widget exists', () => {
      const store = makeStore(db);
      const widget = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      store.publishDraft({ id: widget.id, authoringSessionId: 'sess-1' });

      const view = store.createView({ surface: 'review-queue', name: 'V1', layout: layoutReferencing(widget.id) });
      expect(view.layout.items[0].widget).toEqual({ type: 'custom', widgetId: widget.id });
    });

    it('updateView rejects a new layout referencing a non-existent widget and leaves the row unchanged', () => {
      const store = makeStore(db);
      const created = store.createView({ surface: 'review-queue', name: 'V1', layout: emptyLayout() });

      expect(
        codeOf(() =>
          store.updateView({ id: created.id, expectedRevision: created.revision, layout: layoutReferencing('missing') }),
        ),
      ).toBe('unknown_widget');

      const reread = store.getView(created.id);
      expect(reread).toEqual(created); // revision did not bump; layout unchanged
    });
  });

  describe('updateView CAS', () => {
    it('bumps revision and updated_at on a matching expectedRevision', () => {
      const store = makeStore(db);
      const created = store.createView({ surface: 'review-queue', name: 'V1', layout: emptyLayout() });

      const updated = store.updateView({ id: created.id, expectedRevision: 1, name: 'V1 renamed' });
      expect(updated.revision).toBe(2);
      expect(updated.name).toBe('V1 renamed');
      expect(updated.layout).toEqual(emptyLayout()); // untouched when layout is omitted
      expect(updated.updatedAt).not.toBe(created.updatedAt);
      expect(updated.createdAt).toBe(created.createdAt);
    });

    it('a stale expectedRevision fails with concurrency and leaves the row untouched', () => {
      const store = makeStore(db);
      const created = store.createView({ surface: 'review-queue', name: 'V1', layout: emptyLayout() });
      store.updateView({ id: created.id, expectedRevision: 1, name: 'V1 renamed' }); // now at revision 2

      expect(codeOf(() => store.updateView({ id: created.id, expectedRevision: 1, name: 'stale write' }))).toBe(
        'concurrency',
      );
      expect(store.getView(created.id)?.name).toBe('V1 renamed');
    });

    it('updating a missing id fails with not_found', () => {
      const store = makeStore(db);
      expect(codeOf(() => store.updateView({ id: 'nope', expectedRevision: 1, name: 'x' }))).toBe('not_found');
    });

    it('renaming to a name already taken on the surface fails with name_taken', () => {
      const store = makeStore(db);
      store.createView({ surface: 'review-queue', name: 'Taken', layout: emptyLayout() });
      const other = store.createView({ surface: 'review-queue', name: 'Other', layout: emptyLayout() });

      expect(codeOf(() => store.updateView({ id: other.id, expectedRevision: 1, name: 'taken' }))).toBe('name_taken');
    });
  });

  describe('corrupt layout surfaces as CorruptCustomView', () => {
    it('getView/listViews degrade a malformed layout_json to a corrupt marker instead of throwing', () => {
      const store = makeStore(db);
      db.prepare(
        `INSERT INTO custom_views (id, surface, name, layout_json, revision, created_at, updated_at)
         VALUES ('bad-1', 'review-queue', 'Broken', 'not json at all', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();

      const fetched = store.getView('bad-1');
      expect(fetched).toEqual({
        id: 'bad-1',
        surface: 'review-queue',
        name: 'Broken',
        revision: 1,
        layout: null,
        corrupt: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const listed = store.listViews('review-queue');
      expect(listed).toEqual([fetched]);
    });

    it('a structurally-invalid-but-parseable layout_json (fails schema, not JSON.parse) also degrades to corrupt', () => {
      const store = makeStore(db);
      db.prepare(
        `INSERT INTO custom_views (id, surface, name, layout_json, revision, created_at, updated_at)
         VALUES ('bad-2', 'review-queue', 'WrongShape', '{"version":2,"items":[]}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();

      const result = store.getView('bad-2');
      expect(result !== null && 'corrupt' in result && result.corrupt).toBe(true);
    });
  });

  describe('deleteView', () => {
    it('deletes a view and returns true; deleting again returns false', () => {
      const store = makeStore(db);
      const created = store.createView({ surface: 'review-queue', name: 'V1', layout: emptyLayout() });
      expect(store.deleteView(created.id)).toBe(true);
      expect(store.getView(created.id)).toBeNull();
      expect(store.deleteView(created.id)).toBe(false);
    });

    it('clears the active-view preference for that surface when the deleted view was active', () => {
      const store = makeStore(db);
      const created = store.createView({ surface: 'review-queue', name: 'V1', layout: emptyLayout() });
      store.setActiveViewId('review-queue', created.id);
      expect(store.getActiveViewId('review-queue')).toBe(created.id);

      store.deleteView(created.id);
      expect(store.getActiveViewId('review-queue')).toBeNull();
    });

    it('leaves the active-view preference alone when the deleted view was NOT the active one', () => {
      const store = makeStore(db);
      const active = store.createView({ surface: 'review-queue', name: 'Active', layout: emptyLayout() });
      const other = store.createView({ surface: 'review-queue', name: 'Other', layout: emptyLayout() });
      store.setActiveViewId('review-queue', active.id);

      store.deleteView(other.id);
      expect(store.getActiveViewId('review-queue')).toBe(active.id);
    });
  });

  describe('widgets: saveDraft', () => {
    it('creates a new widget with a draft and no published spec when id is omitted', () => {
      const store = makeStore(db);
      const widget = store.saveDraft({ name: 'W1', description: 'desc', spec: widgetSpec, authoringSessionId: 'sess-1' });
      expect(widget.name).toBe('W1');
      expect(widget.description).toBe('desc');
      expect(widget.publishedSpec).toBeNull();
      expect(widget.draftSpec).toEqual(widgetSpec);
      expect(widget.authoringSessionId).toBe('sess-1');
      expect(widget.revision).toBe(1);

      expect(store.getWidget(widget.id)).toEqual(widget);
      expect(store.listWidgets()).toEqual([widget]);
    });

    it('updates the draft of an existing widget and bumps revision when the session matches', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });

      const secondSpec: WidgetSpec = { ...widgetSpec, refreshSec: 120 };
      const updated = store.saveDraft({
        id: created.id,
        name: 'W1 renamed',
        spec: secondSpec,
        authoringSessionId: 'sess-1',
      });
      expect(updated.name).toBe('W1 renamed');
      expect(updated.draftSpec).toEqual(secondSpec);
      expect(updated.revision).toBe(2);
    });

    it('claims an unowned draft (authoring_session_id null, e.g. right after publish) for a new session', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      store.publishDraft({ id: created.id, authoringSessionId: 'sess-1' }); // clears authoring_session_id

      expect(() =>
        store.saveDraft({ id: created.id, name: 'W1 v2', spec: widgetSpec, authoringSessionId: 'sess-2' }),
      ).not.toThrow();
      expect(store.getWidget(created.id)?.authoringSessionId).toBe('sess-2');
    });

    it('session_mismatch when a different session tries to save over an in-progress draft', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });

      expect(
        codeOf(() => store.saveDraft({ id: created.id, name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-2' })),
      ).toBe('session_mismatch');
    });

    it('not_found when saving over a missing widget id', () => {
      const store = makeStore(db);
      expect(codeOf(() => store.saveDraft({ id: 'nope', name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' }))).toBe(
        'not_found',
      );
    });
  });

  describe('publishDraft', () => {
    it('promotes draft to published, clears the draft and session, and bumps revision', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });

      const published = store.publishDraft({ id: created.id, authoringSessionId: 'sess-1' });
      expect(published.publishedSpec).toEqual(widgetSpec);
      expect(published.draftSpec).toBeNull();
      expect(published.authoringSessionId).toBeNull();
      expect(published.revision).toBe(2);
    });

    it('no_draft when there is no pending draft to publish', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      store.publishDraft({ id: created.id, authoringSessionId: 'sess-1' });

      expect(codeOf(() => store.publishDraft({ id: created.id, authoringSessionId: 'sess-1' }))).toBe('no_draft');
    });

    it('session_mismatch when publishing with the wrong session', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      expect(codeOf(() => store.publishDraft({ id: created.id, authoringSessionId: 'sess-2' }))).toBe('session_mismatch');
    });

    it('not_found when publishing a missing widget id', () => {
      const store = makeStore(db);
      expect(codeOf(() => store.publishDraft({ id: 'nope', authoringSessionId: 'sess-1' }))).toBe('not_found');
    });
  });

  describe('discardDraft', () => {
    it('deletes the row entirely when discarding a never-published widget', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });

      const result = store.discardDraft({ id: created.id, authoringSessionId: 'sess-1' });
      expect(result).toBeNull();
      expect(store.getWidget(created.id)).toBeNull();
    });

    it('clears only the draft (keeps the published spec) when the widget has already been published', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      store.publishDraft({ id: created.id, authoringSessionId: 'sess-1' });
      const secondSpec: WidgetSpec = { ...widgetSpec, refreshSec: 300 };
      store.saveDraft({ id: created.id, name: 'W1', spec: secondSpec, authoringSessionId: 'sess-3' });

      const result = store.discardDraft({ id: created.id, authoringSessionId: 'sess-3' });
      expect(result).not.toBeNull();
      expect(result?.draftSpec).toBeNull();
      expect(result?.publishedSpec).toEqual(widgetSpec);
      expect(result?.authoringSessionId).toBeNull();
    });

    it('returns null (no-op) for a missing widget id', () => {
      const store = makeStore(db);
      expect(store.discardDraft({ id: 'nope', authoringSessionId: 'sess-1' })).toBeNull();
    });

    it('session_mismatch when discarding with the wrong session', () => {
      const store = makeStore(db);
      const created = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      expect(codeOf(() => store.discardDraft({ id: created.id, authoringSessionId: 'sess-2' }))).toBe('session_mismatch');
    });
  });

  describe('deleteWidget', () => {
    it('deletes an unreferenced widget and returns true', () => {
      const store = makeStore(db);
      const widget = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      expect(store.deleteWidget(widget.id)).toBe(true);
      expect(store.getWidget(widget.id)).toBeNull();
    });

    it('returns false for a missing widget id (no in_use/corrupt_layout blocking rows exist)', () => {
      const store = makeStore(db);
      expect(store.deleteWidget('nope')).toBe(false);
    });

    it('in_use when a view references the widget', () => {
      const store = makeStore(db);
      const widget = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      store.publishDraft({ id: widget.id, authoringSessionId: 'sess-1' });
      const view = store.createView({ surface: 'review-queue', name: 'V1', layout: layoutReferencing(widget.id) });

      expect(codeOf(() => store.deleteWidget(widget.id))).toBe('in_use');
      // Nothing was deleted.
      expect(store.getWidget(widget.id)).not.toBeNull();
      expect(store.getView(view.id)).not.toBeNull();
    });

    it('corrupt_layout fails closed: an unparsable layout anywhere blocks deleting ANY widget', () => {
      const store = makeStore(db);
      const widget = store.saveDraft({ name: 'W1', spec: widgetSpec, authoringSessionId: 'sess-1' });
      // A view completely unrelated to `widget`, but with a corrupt layout.
      db.prepare(
        `INSERT INTO custom_views (id, surface, name, layout_json, revision, created_at, updated_at)
         VALUES ('bad-1', 'review-queue', 'Broken', 'not json', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();

      expect(codeOf(() => store.deleteWidget(widget.id))).toBe('corrupt_layout');
      expect(store.getWidget(widget.id)).not.toBeNull();
    });
  });

  describe('active view id', () => {
    it('defaults to null, round-trips a set value, and null deletes it', () => {
      const store = makeStore(db);
      expect(store.getActiveViewId('review-queue')).toBeNull();

      store.setActiveViewId('review-queue', 'view-a');
      expect(store.getActiveViewId('review-queue')).toBe('view-a');

      store.setActiveViewId('review-queue', 'view-b');
      expect(store.getActiveViewId('review-queue')).toBe('view-b');

      store.setActiveViewId('review-queue', null);
      expect(store.getActiveViewId('review-queue')).toBeNull();
    });

    it('is keyed independently per surface', () => {
      const store = makeStore(db);
      store.setActiveViewId('review-queue', 'view-rq');
      store.setActiveViewId('project-overview', 'view-po');

      expect(store.getActiveViewId('review-queue')).toBe('view-rq');
      expect(store.getActiveViewId('project-overview')).toBe('view-po');
    });
  });
});
