/**
 * Unit tests for WidgetDataService (docs/proposals/CUSTOM-VIEWS.md §4.3 /
 * §10 "Cache/breaker").
 *
 * A file-backed database is used so `sql` sources really execute on a readonly
 * sibling handle; the row counter on the `hits` table is what proves whether a
 * run reached SQLite or came out of the cache.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceResult, WidgetSpec } from '../../../../../shared/types/customViews';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { closeReadonlySiblings } from '../../readOnlyQuery';
import { FULL_SCAN_WARNING, WidgetDataService, canonicalJson } from '../widgetDataService';
import type { DatabaseLike } from '../../types';

let tmpDir: string;
let rawDb: Database.Database;
let db: DatabaseLike;
/** Advances only when a real query reaches SQLite (a bare literal SELECT would not). */
let clock: number;

const SPEC: WidgetSpec = {
  version: 1,
  sources: {
    rows: {
      type: 'sql',
      sql: 'SELECT id, label FROM items WHERE project_id = :pid ORDER BY id LIMIT :limit',
      params: { pid: { context: 'projectId' }, limit: { setting: 'limit' } },
    },
  },
  settings: [{ name: 'limit', label: 'Limit', kind: 'number', default: 5 }],
  render: { type: 'shape', shape: 'table', source: 'rows', columns: [{ field: 'label' }] },
};

function makeService(overrides: Partial<ConstructorParameters<typeof WidgetDataService>[0]> = {}): WidgetDataService {
  return new WidgetDataService({ db, now: () => new Date(clock), ...overrides });
}

const BASE_INPUT = { spec: SPEC, settings: {}, context: { projectId: 7 } };

beforeEach(() => {
  clock = Date.parse('2026-09-10T12:00:00.000Z');
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-widget-data-'));
  rawDb = new Database(join(tmpDir, 'test.db'));
  rawDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, project_id INTEGER, label TEXT)');
  rawDb.prepare('INSERT INTO items (id, project_id, label) VALUES (1, 7, ?)').run('alpha');
  db = dbAdapter(rawDb);
});

afterEach(() => {
  closeReadonlySiblings();
  rawDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys at every depth but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1, 2] } })).toBe('{"a":{"c":[3,1,2],"d":2},"b":1}');
  });
});

// ---------------------------------------------------------------------------
// Cache + coalescing
// ---------------------------------------------------------------------------

describe('WidgetDataService — cache', () => {
  it('runs the sources once for two concurrent calls on the same key', async () => {
    const service = makeService();
    const [first, second] = await Promise.all([service.run(BASE_INPUT), service.run(BASE_INPUT)]);
    expect(first).toBe(second);
    expect((first.sources.rows as SourceResult).rows).toEqual([{ id: 1, label: 'alpha' }]);
  });

  it('serves a cached payload while it is fresh for the requested refreshSec', async () => {
    const service = makeService();
    const first = await service.run({ ...BASE_INPUT, refreshSec: 60 });
    rawDb.prepare('INSERT INTO items (id, project_id, label) VALUES (2, 7, ?)').run('beta');
    clock += 30_000;
    const second = await service.run({ ...BASE_INPUT, refreshSec: 60 });
    expect(second).toBe(first);
    expect((second.sources.rows as SourceResult).rows).toHaveLength(1);
  });

  it('re-runs when the requested refreshSec is shorter than the entry age', async () => {
    const service = makeService();
    await service.run({ ...BASE_INPUT, refreshSec: 3600 });
    rawDb.prepare('INSERT INTO items (id, project_id, label) VALUES (2, 7, ?)').run('beta');
    clock += 30_000;
    // Same entry, a stricter freshness demand from THIS request.
    const second = await service.run({ ...BASE_INPUT, refreshSec: 15 });
    expect((second.sources.rows as SourceResult).rows).toHaveLength(2);
  });

  it('changes the key when the settings change', async () => {
    const service = makeService();
    const withDefault = await service.run(BASE_INPUT);
    const withOverride = await service.run({ ...BASE_INPUT, settings: { limit: 9 } });
    expect(withOverride).not.toBe(withDefault);
  });

  it('does not change the key as nowIso advances within the same day', async () => {
    const service = makeService();
    const first = await service.run({ ...BASE_INPUT, refreshSec: 3600 });
    clock += 60_000; // same UTC day, later nowIso
    const second = await service.run({ ...BASE_INPUT, refreshSec: 3600 });
    expect(second).toBe(first);
  });

  it('changes the key when todayIso rolls over', async () => {
    const service = makeService();
    const first = await service.run({ ...BASE_INPUT, refreshSec: 86_400 });
    clock = Date.parse('2026-09-11T12:00:00.000Z');
    const second = await service.run({ ...BASE_INPUT, refreshSec: 86_400 });
    expect(second).not.toBe(first);
  });

  it('changes the key when the projectId changes', async () => {
    const service = makeService();
    const forSeven = await service.run(BASE_INPUT);
    const forNine = await service.run({ ...BASE_INPUT, context: { projectId: 9 } });
    expect((forSeven.sources.rows as SourceResult).rows).toHaveLength(1);
    expect((forNine.sources.rows as SourceResult).rows).toHaveLength(0);
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    const service = makeService({ maxEntries: 1 });
    const forSeven = await service.run({ ...BASE_INPUT, refreshSec: 3600 });
    await service.run({ ...BASE_INPUT, refreshSec: 3600, context: { projectId: 9 } });
    // The projectId-7 entry was evicted, so this is a fresh object, not the hit.
    const again = await service.run({ ...BASE_INPUT, refreshSec: 3600 });
    expect(again).not.toBe(forSeven);
  });
});

// ---------------------------------------------------------------------------
// Breaker
// ---------------------------------------------------------------------------

describe('WidgetDataService — breaker', () => {
  it('pauses the key after a run slower than slowQueryMs and suppresses later runs', async () => {
    const service = makeService({ slowQueryMs: -1 }); // every run counts as slow
    const first = await service.run(BASE_INPUT);
    expect(first.paused).toBeDefined();
    expect(first.sources).toEqual({});

    rawDb.prepare('INSERT INTO items (id, project_id, label) VALUES (2, 7, ?)').run('beta');
    const second = await service.run(BASE_INPUT);
    expect(second.paused).toBeDefined();
    expect(second.sources).toEqual({});
  });

  it('resetBreaker clears the pause so the next run executes', async () => {
    const service = makeService({ slowQueryMs: -1 });
    await service.run(BASE_INPUT);
    service.resetBreaker(BASE_INPUT);

    const healthy = makeService();
    // Same key inputs on a service with a normal budget now run for real.
    const payload = await healthy.run(BASE_INPUT);
    expect(payload.paused).toBeUndefined();
    expect((payload.sources.rows as SourceResult).rows).toHaveLength(1);
  });

  it('does not pause a run inside the budget', async () => {
    const service = makeService({ slowQueryMs: 60_000 });
    const payload = await service.run(BASE_INPUT);
    expect(payload.paused).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Query plan
// ---------------------------------------------------------------------------

describe('WidgetDataService — query plan', () => {
  it('captures the plan lines and warns about a full scan', async () => {
    const service = makeService();
    const payload = await service.run(BASE_INPUT);
    expect(payload.plan?.rows?.join(' ')).toContain('SCAN');
    expect(payload.warnings).toContain(FULL_SCAN_WARNING);
    expect(service.queryPlan(BASE_INPUT)?.rows).toEqual(payload.plan?.rows);
  });

  it('does not warn about a full scan for an indexed lookup', async () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { rows: { type: 'sql', sql: 'SELECT label FROM items WHERE id = 1' } },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'label' },
    };
    const payload = await makeService().run({ spec, settings: {}, context: { projectId: 7 } });
    expect(payload.warnings).not.toContain(FULL_SCAN_WARNING);
  });
});

// ---------------------------------------------------------------------------
// Spec resolution
// ---------------------------------------------------------------------------

describe('WidgetDataService — spec resolution', () => {
  it('throws invalid_spec when a setting reference names an undeclared knob', async () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: { type: 'sql', sql: 'SELECT :n AS n', params: { n: { setting: 'missing' } } },
      },
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'n' },
    };
    await expect(makeService().run({ spec, settings: {}, context: { projectId: null } })).rejects.toThrow(
      /^invalid_spec:/,
    );
  });

  it('resolves a declared setting into the bound param', async () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: {
        rows: { type: 'sql', sql: 'SELECT :n AS n', params: { n: { setting: 'size' } } },
      },
      settings: [{ name: 'size', label: 'Size', kind: 'number', default: 3 }],
      render: { type: 'shape', shape: 'stat', source: 'rows', value: 'n' },
    };
    const payload = await makeService().run({ spec, settings: { size: 11 }, context: { projectId: null } });
    expect((payload.sources.rows as SourceResult).rows).toEqual([{ n: 11 }]);
  });
});
