/**
 * projectSettings — the orchestrator's per-PROJECT settings writer.
 *
 * Driven against a real temp DB carrying the full migration chain, so the
 * `solution_thoroughness` CHECK (migration 134) and the `updated_at` bump behave
 * as in production.
 *
 * The load-bearing behaviours: a stamp writes AND notifies; a re-stamp of the
 * SAME level is a silent no-op (the settle reconciliation re-runs this on every
 * terminal launch run, and must not spam the renderer); a LATER, different level
 * overwrites (re-running Launch is how a user revises the answer); and every
 * failure path is swallowed, because a settings stamp must never fail the gate
 * resolution that triggered it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../database/database';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';
import { readSolutionThoroughness, stampSolutionThoroughness } from '../projectSettings';

interface Harness {
  svc: DatabaseService;
  db: DatabaseLike;
  projectId: number;
  dir: string;
}

let active: Harness | null = null;

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cyboflow-projectsettings-'));
  const svc = new DatabaseService(join(dir, 'test.db'));
  svc.setMigrationsDirForTesting(join(__dirname, '..', '..', 'database', 'migrations'));
  svc.initialize();
  const project = svc.createProject('Settings Test', join(dir, 'proj'));
  active = { svc, db: dbAdapter(svc.getDb()), projectId: project.id, dir };
  return active;
}

afterEach(() => {
  if (active) {
    active.svc.close();
    rmSync(active.dir, { recursive: true, force: true });
    active = null;
  }
});

describe('stampSolutionThoroughness', () => {
  it('writes the column, returns true, and notifies the renderer once', () => {
    const h = setup();
    const notified: number[] = [];

    expect(
      stampSolutionThoroughness(
        { db: h.db, emitProjectUpdated: (id) => notified.push(id) },
        { projectId: h.projectId, level: 'v1' },
      ),
    ).toBe(true);

    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('v1');
    expect(notified).toEqual([h.projectId]);
  });

  it('re-stamping the SAME level is a no-op and does NOT notify', () => {
    const h = setup();
    const notified: number[] = [];
    const deps = { db: h.db, emitProjectUpdated: (id: number) => notified.push(id) };

    stampSolutionThoroughness(deps, { projectId: h.projectId, level: 'production' });
    expect(notified).toHaveLength(1);

    expect(stampSolutionThoroughness(deps, { projectId: h.projectId, level: 'production' })).toBe(false);
    expect(notified).toHaveLength(1);
    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('production');
  });

  it('a later, DIFFERENT level overwrites (re-running Launch revises the answer)', () => {
    const h = setup();
    stampSolutionThoroughness({ db: h.db }, { projectId: h.projectId, level: 'prototype' });
    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('prototype');

    expect(stampSolutionThoroughness({ db: h.db }, { projectId: h.projectId, level: 'production' })).toBe(
      true,
    );
    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('production');
  });

  it('returns false and logs (never throws) for a project that does not exist', () => {
    const h = setup();
    const warnings: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      debug: () => undefined,
    };

    expect(
      stampSolutionThoroughness({ db: h.db, logger }, { projectId: 9999, level: 'v1' }),
    ).toBe(false);
    expect(warnings.join(' ')).toMatch(/no such project/i);
  });

  it('swallows a throwing renderer notification — the stamp still commits', () => {
    const h = setup();
    expect(
      stampSolutionThoroughness(
        {
          db: h.db,
          emitProjectUpdated: () => {
            throw new Error('renderer gone');
          },
        },
        { projectId: h.projectId, level: 'v1' },
      ),
    ).toBe(true);
    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('v1');
  });

  it('swallows a throwing DB (fail-soft: a settings stamp never fails its gate)', () => {
    const throwingDb: DatabaseLike = {
      prepare: () => {
        throw new Error('db down');
      },
      transaction: <T,>(fn: (...args: unknown[]) => T) => fn,
    };
    expect(stampSolutionThoroughness({ db: throwingDb }, { projectId: 1, level: 'v1' })).toBe(false);
    expect(readSolutionThoroughness(throwingDb, 1)).toBeNull();
  });
});

describe('readSolutionThoroughness', () => {
  it('is null for a never-stamped project and for an unknown project', () => {
    const h = setup();
    expect(readSolutionThoroughness(h.db, h.projectId)).toBeNull();
    expect(readSolutionThoroughness(h.db, 9999)).toBeNull();
  });
});
