import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../../types';
import { resolveIdeaComponents, resolveIdeaComponentsBatch } from '../resolveIdeaComponents';
import { IDEA_COMPONENT_KEYS } from '../../../../../shared/types/ideaComponents';

/**
 * Minimal ad-hoc schema — the neighbouring `entityRunLinks.test.ts` idiom of
 * hand-rolled CREATE TABLEs rather than running the full migration chain.
 * Column sets are pared to exactly what resolveIdeaComponents.ts reads.
 *
 * `idea_components` itself is the ONE exception: it is read straight from
 * migration 101 (the same way taskChangeRouter.test.ts's
 * buildDbWithIdeaComponents does) rather than hand-rolled, so a future column
 * or CHECK-constraint change cannot silently miss this copy while the suite
 * stays green against a schema the app no longer has.
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE approved_designs (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      superseded_at TEXT,
      -- Migration 133's provenance columns. Derivation is deliberately BLIND to
      -- them (a current row completes 'prototype' whichever pathway wrote it);
      -- they are here so the flow-vs-design-mode test below can assert exactly
      -- that.
      source TEXT NOT NULL DEFAULT 'design-mode',
      source_run_id TEXT
    );
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_epic_id TEXT,
      originating_idea_id TEXT
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      seed_idea_id TEXT,
      seed_idea_ids TEXT
    );
    CREATE TABLE entity_events (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      run_id TEXT
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      atype TEXT NOT NULL
    );
  `);
  return db;
}

function insertIdea(db: Database.Database, id: string, body: string | null): void {
  db.prepare('INSERT INTO ideas (id, body) VALUES (?, ?)').run(id, body);
}

function insertLedgerRow(
  db: Database.Database,
  ideaId: string,
  component: (typeof IDEA_COMPONENT_KEYS)[number],
  fields: {
    state: 'complete' | 'incomplete' | 'skipped';
    source?: 'flow' | 'manual';
    sourceRunId?: string | null;
    sourceSessionId?: string | null;
    builtAgainstVersion?: number | null;
    staleAt?: string | null;
    staleReason?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO idea_components
       (idea_id, project_id, component, state, source, source_run_id, source_session_id,
        built_against_version, stale_at, stale_reason, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(
    ideaId,
    component,
    fields.state,
    fields.source ?? 'flow',
    fields.sourceRunId ?? null,
    fields.sourceSessionId ?? null,
    fields.builtAgainstVersion ?? null,
    fields.staleAt ?? null,
    fields.staleReason ?? null,
  );
}

/** Find one component's resolved state out of the five, by key. */
function pick(
  states: ReturnType<typeof resolveIdeaComponents>,
  component: (typeof IDEA_COMPONENT_KEYS)[number],
) {
  const found = states.find((s) => s.component === component);
  if (!found) throw new Error(`missing component ${component} in resolved states`);
  return found;
}

const IDEA_SPEC_BODY = '## Idea spec\n\nSome spec content.\n';
const ARCH_DESIGN_BODY = '## Architecture design\n\nSome arch content.\n';
const BOTH_SECTIONS_BODY = `${IDEA_SPEC_BODY}\n${ARCH_DESIGN_BODY}`;

describe('resolveIdeaComponents / resolveIdeaComponentsBatch', () => {
  it('always returns all five components, in IDEA_COMPONENT_KEYS order', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    expect(states.map((s) => s.component)).toEqual([...IDEA_COMPONENT_KEYS]);
  });

  it('derives every component correctly for a bare/legacy idea with no ledger rows', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', BOTH_SECTIONS_BODY);
    db.prepare('INSERT INTO approved_designs (id, idea_id, superseded_at) VALUES (?, ?, NULL)').run(
      'ad-1',
      'idea-1',
    );
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'idea-1');
    db.prepare('INSERT INTO tasks (id, originating_idea_id) VALUES (?, ?)').run('tsk-1', 'idea-1');

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');

    expect(pick(states, 'idea-spec')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'architecture')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'prototype')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'epics')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'stories')).toMatchObject({ state: 'complete', source: 'derived' });

    // Every derived entry carries null lineage/staleness fields.
    for (const s of states) {
      expect(s.sourceRunId).toBeNull();
      expect(s.sourceSessionId).toBeNull();
      expect(s.builtAgainstVersion).toBeNull();
      expect(s.staleAt).toBeNull();
      expect(s.staleReason).toBeNull();
      expect(s.updatedAt).toBeNull();
    }
  });

  it('derives incomplete for every component when nothing exists', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'Just a plain body, no headings.');

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    for (const s of states) {
      expect(s.state).toBe('incomplete');
      expect(s.source).toBe('derived');
    }
  });

  it('a ledger row overrides derivation: incomplete row wins while the heading exists', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', ARCH_DESIGN_BODY);
    insertLedgerRow(db, 'idea-1', 'architecture', { state: 'incomplete', source: 'manual' });

    const architecture = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'architecture');
    expect(architecture.state).toBe('incomplete');
    expect(architecture.source).toBe('manual');
  });

  it('a ledger row overrides derivation: complete row wins while nothing exists', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'no headings here');
    // 'architecture' — not 'epics'/'stories', which carry the entity-existence
    // override (their own describe block below).
    insertLedgerRow(db, 'idea-1', 'architecture', {
      state: 'complete',
      source: 'flow',
      sourceRunId: 'run-1',
    });

    const arch = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'architecture');
    expect(arch.state).toBe('complete');
    expect(arch.source).toBe('flow');
    expect(arch.sourceRunId).toBe('run-1');
  });

  describe('entity-existence override (epics/stories complete with zero entities)', () => {
    it("downgrades a 'stories' complete stamp to stale incomplete when the idea has NO tasks", () => {
      const db = buildDb();
      insertIdea(db, 'idea-1', 'body');
      insertLedgerRow(db, 'idea-1', 'stories', { state: 'complete', source: 'flow', sourceRunId: 'run-1' });

      const stories = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'stories');
      expect(stories.state).toBe('incomplete');
      // staleAt falls back to the stamp's updatedAt so the UI's "needs review"
      // (incomplete + staleAt non-null) fires.
      expect(stories.staleAt).toBe('2026-01-01T00:00:00Z');
      expect(stories.staleReason).toContain('decomposition deleted');
      // Lineage survives the downgrade — the stamp is still the row of record.
      expect(stories.sourceRunId).toBe('run-1');
    });

    it("downgrades an 'epics' complete stamp the same way when the idea has NO epics", () => {
      const db = buildDb();
      insertIdea(db, 'idea-1', 'body');
      insertLedgerRow(db, 'idea-1', 'epics', { state: 'complete' });

      const epics = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'epics');
      expect(epics.state).toBe('incomplete');
      expect(epics.staleAt).not.toBeNull();
    });

    it('does NOT fire while the entities exist (done/archived rows still count)', () => {
      const db = buildDb();
      insertIdea(db, 'idea-1', 'body');
      insertLedgerRow(db, 'idea-1', 'stories', { state: 'complete' });
      db.prepare('INSERT INTO tasks (id, originating_idea_id) VALUES (?, ?)').run('t1', 'idea-1');

      expect(pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'stories').state).toBe('complete');
    });

    it("leaves 'skipped' and 'incomplete' rows verbatim (judgments the ledger owns)", () => {
      const db = buildDb();
      insertIdea(db, 'idea-1', 'body');
      insertLedgerRow(db, 'idea-1', 'epics', { state: 'skipped', source: 'manual' });
      insertLedgerRow(db, 'idea-1', 'stories', { state: 'incomplete' });

      const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
      expect(pick(states, 'epics')).toMatchObject({ state: 'skipped', staleAt: null });
      expect(pick(states, 'stories')).toMatchObject({ state: 'incomplete', staleAt: null });
    });

    it('a pre-existing staleAt on the row is preserved rather than overwritten', () => {
      const db = buildDb();
      insertIdea(db, 'idea-1', 'body');
      insertLedgerRow(db, 'idea-1', 'stories', {
        state: 'complete',
        staleAt: '2026-03-01T00:00:00Z',
        staleReason: 'idea body changed',
      });

      const stories = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'stories');
      expect(stories.state).toBe('incomplete');
      expect(stories.staleAt).toBe('2026-03-01T00:00:00Z');
      expect(stories.staleReason).toContain('decomposition deleted');
    });
  });

  it('returns skipped only from a ledger row, and derivation never produces it', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'no headings here');
    insertLedgerRow(db, 'idea-1', 'stories', { state: 'skipped', source: 'manual' });

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    expect(pick(states, 'stories')).toMatchObject({ state: 'skipped', source: 'manual' });

    // Every OTHER (derived) component must never be 'skipped'.
    for (const s of states) {
      if (s.source === 'derived') expect(s.state).not.toBe('skipped');
    }
  });

  it('round-trips stale_at: a complete row with stale_at set comes back with staleAt non-null', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertLedgerRow(db, 'idea-1', 'idea-spec', {
      state: 'complete',
      source: 'flow',
      staleAt: '2026-02-01T00:00:00Z',
      staleReason: 'idea body changed',
    });

    const ideaSpec = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'idea-spec');
    expect(ideaSpec.state).toBe('complete');
    expect(ideaSpec.staleAt).toBe('2026-02-01T00:00:00Z');
    expect(ideaSpec.staleReason).toBe('idea body changed');
  });

  // A task minted UNDER AN EPIC carries a NULL originating_idea_id and reaches
  // its idea through `tasks.parent_epic_id -> epics.originating_idea_id` — the
  // codebase's own lineage model (see runEntityOwnership.ts). Reading only the
  // direct column derived 'stories: incomplete' for an idea whose entire
  // decomposition already exists, so the planner redid it.
  it('stories completes for an EPIC-CHILD task whose direct originating_idea_id is NULL', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'idea-1');
    db.prepare(
      'INSERT INTO tasks (id, parent_epic_id, originating_idea_id) VALUES (?, ?, NULL)',
    ).run('tsk-1', 'epc-1');

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    expect(pick(states, 'stories')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'epics')).toMatchObject({ state: 'complete', source: 'derived' });
  });

  it('an epic-child task under ANOTHER idea\'s epic does not complete stories here', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertIdea(db, 'idea-2', null);
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-2', 'idea-2');
    db.prepare(
      'INSERT INTO tasks (id, parent_epic_id, originating_idea_id) VALUES (?, ?, NULL)',
    ).run('tsk-2', 'epc-2');

    expect(pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'stories')).toMatchObject({
      state: 'incomplete',
    });
    expect(pick(resolveIdeaComponents(dbAdapter(db), 'idea-2'), 'stories')).toMatchObject({
      state: 'complete',
    });
  });

  it('an ORPHAN task (no idea, no parent epic) completes stories for nobody', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare(
      'INSERT INTO tasks (id, parent_epic_id, originating_idea_id) VALUES (?, NULL, NULL)',
    ).run('tsk-orphan');

    expect(pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'stories')).toMatchObject({
      state: 'incomplete',
    });
  });

  it('prototype completes via an approved_designs current row', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare('INSERT INTO approved_designs (id, idea_id, superseded_at) VALUES (?, ?, NULL)').run(
      'ad-1',
      'idea-1',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('complete');
    expect(prototype.source).toBe('derived');
  });

  it('a FLOW-sourced approved_designs row derives prototype exactly like a design-mode one', () => {
    // Migration 133 added `source`; derivation must stay blind to it. The read
    // model's WHERE clause is `superseded_at IS NULL` and nothing else, so a
    // Launch/Planner/Ship bind completes the component the same way a Design
    // Mode approval does — the provenance only matters to the BINDER (which
    // refuses to overwrite a design-mode row), never to this read.
    const flowDb = buildDb();
    insertIdea(flowDb, 'idea-1', null);
    flowDb
      .prepare(
        'INSERT INTO approved_designs (id, idea_id, superseded_at, source, source_run_id) VALUES (?, ?, NULL, ?, ?)',
      )
      .run('ad-flow', 'idea-1', 'flow', 'run-launch');

    const designModeDb = buildDb();
    insertIdea(designModeDb, 'idea-1', null);
    designModeDb
      .prepare(
        'INSERT INTO approved_designs (id, idea_id, superseded_at, source, source_run_id) VALUES (?, ?, NULL, ?, NULL)',
      )
      .run('ad-dm', 'idea-1', 'design-mode');

    const flow = pick(resolveIdeaComponents(dbAdapter(flowDb), 'idea-1'), 'prototype');
    const designMode = pick(resolveIdeaComponents(dbAdapter(designModeDb), 'idea-1'), 'prototype');
    expect(flow).toEqual(designMode);
    expect(flow.state).toBe('complete');
    expect(flow.source).toBe('derived');
  });

  it('a SUPERSEDED approved_designs row does NOT complete prototype on its own', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare(
      'INSERT INTO approved_designs (id, idea_id, superseded_at) VALUES (?, ?, ?)',
    ).run('ad-1', 'idea-1', '2026-01-01T00:00:00Z');

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('incomplete');
  });

  it('prototype completes via a ui-prototype artifact on a run linked to the idea', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-1', 'idea-1');
    db.prepare('INSERT INTO artifacts (id, run_id, atype) VALUES (?, ?, ?)').run(
      'art-1',
      'run-1',
      'ui-prototype',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('complete');
    expect(prototype.source).toBe('derived');
  });

  it('prototype completes via an interactive-prototype artifact reached through entity_events lineage', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    // No seed_idea_id/seed_idea_ids link — only entity_events lineage on the idea itself.
    db.prepare('INSERT INTO workflow_runs (id) VALUES (?)').run('run-1');
    db.prepare("INSERT INTO entity_events (entity_type, entity_id, run_id) VALUES ('idea', 'idea-1', 'run-1')").run();
    db.prepare('INSERT INTO artifacts (id, run_id, atype) VALUES (?, ?, ?)').run(
      'art-1',
      'run-1',
      'interactive-prototype',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('complete');
  });

  it('an unlinked ui-prototype artifact (a different idea owns the run) does not complete prototype', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertIdea(db, 'idea-2', null);
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-2', 'idea-2');
    db.prepare('INSERT INTO artifacts (id, run_id, atype) VALUES (?, ?, ?)').run(
      'art-2',
      'run-2',
      'ui-prototype',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('incomplete');
  });

  it('batch returns an entry for EVERY requested id, including an idea that does not exist', () => {
    const db = buildDb();
    insertIdea(db, 'idea-real', null);

    const batch = resolveIdeaComponentsBatch(dbAdapter(db), ['idea-real', 'idea-ghost']);

    expect(batch.has('idea-real')).toBe(true);
    expect(batch.has('idea-ghost')).toBe(true);
    const ghostStates = batch.get('idea-ghost');
    expect(ghostStates).toBeDefined();
    expect(ghostStates?.map((s) => s.component)).toEqual([...IDEA_COMPONENT_KEYS]);
    for (const s of ghostStates ?? []) {
      expect(s.state).toBe('incomplete');
      expect(s.source).toBe('derived');
    }
  });

  it('batch resolves distinct ideas independently in one call (ledger row on one does not leak to another)', () => {
    const db = buildDb();
    insertIdea(db, 'idea-a', ARCH_DESIGN_BODY);
    insertIdea(db, 'idea-b', null);
    insertLedgerRow(db, 'idea-a', 'architecture', { state: 'skipped', source: 'manual' });

    const batch = resolveIdeaComponentsBatch(dbAdapter(db), ['idea-a', 'idea-b']);
    const a = batch.get('idea-a');
    const b = batch.get('idea-b');
    expect(a?.find((s) => s.component === 'architecture')).toMatchObject({ state: 'skipped', source: 'manual' });
    expect(b?.find((s) => s.component === 'architecture')).toMatchObject({ state: 'incomplete', source: 'derived' });
  });

  it('empty id array yields an empty map', () => {
    const db = buildDb();
    const batch = resolveIdeaComponentsBatch(dbAdapter(db), []);
    expect(batch.size).toBe(0);
  });

  it('issues a bounded number of prepare() calls, not one per idea', () => {
    const db = buildDb();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `idea-${i}`;
      ids.push(id);
      insertIdea(db, id, i % 2 === 0 ? ARCH_DESIGN_BODY : null);
    }

    let prepareCount = 0;
    const counting: DatabaseLike = {
      prepare: (sql: string) => {
        prepareCount += 1;
        return db.prepare(sql);
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
      name: db.name,
    };

    resolveIdeaComponentsBatch(counting, [ids[0]]);
    const countForOne = prepareCount;

    prepareCount = 0;
    resolveIdeaComponentsBatch(counting, ids);
    const countForFifty = prepareCount;

    // Both fit in a single chunk (well under the 400/id chunk size), so the
    // query COUNT must be identical regardless of how many ideas were asked
    // for — the whole point of the grouped-query design.
    expect(countForFifty).toBe(countForOne);
    // Sanity: this is a small constant, not e.g. hundreds.
    expect(countForFifty).toBeLessThan(20);
  });
});
