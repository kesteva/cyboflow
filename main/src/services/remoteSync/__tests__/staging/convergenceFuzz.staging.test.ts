/**
 * CONVERGENCE FUZZ against the STAGING sync service (desktop doc, "Testing" 2:
 * "the single most valuable test"). Random backlog operations on two machines,
 * random sync interleavings, and random client-side faults (requests that never
 * leave, responses lost after the server committed). After the faults stop and
 * both machines settle, their synced projections must hash equal to each other
 * and to the server's.
 *
 * Seeded and reproducible: CYBOFLOW_SYNC_FUZZ_SEEDS="1,2,3" picks the seeds,
 * CYBOFLOW_SYNC_FUZZ_STEPS the operations per seed. Skipped unless
 * CYBOFLOW_SYNC_STAGING_SECRET is set.
 */
import { describe, expect, it } from 'vitest';
import { TwoMachines, stagingEnabled, type Machine } from './stagingHarness';
import { projectionHash } from '../../canonical';

const SEEDS = (process.env.CYBOFLOW_SYNC_FUZZ_SEEDS ?? '1,2,3').split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
const STEPS = Number(process.env.CYBOFLOW_SYNC_FUZZ_STEPS ?? 40);

/** mulberry32: a tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ids(m: Machine, table: 'ideas' | 'epics' | 'tasks'): string[] {
  return (m.db.prepare(`SELECT id FROM ${table} WHERE project_id = ? ORDER BY id`).all(m.projectId) as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

async function randomOp(m: Machine, r: () => number, log: string[]): Promise<void> {
  const pick = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]);
  const tasks = ids(m, 'tasks');
  const epics = ids(m, 'epics');
  const ideas = ids(m, 'ideas');
  const any = pick([...tasks, ...epics, ...ideas]);
  const roll = r();
  const word = `w${Math.floor(r() * 1000)}`;
  let desc = '';
  try {
    if (roll < 0.18 || tasks.length < 2) {
      desc = 'create task';
      await m.edit({ entityType: 'task', title: `task ${word}`, parentEpicId: r() < 0.3 ? pick(epics) : undefined });
    } else if (roll < 0.24) {
      desc = 'create epic';
      await m.edit({ entityType: 'epic', title: `epic ${word}`, originatingIdeaId: r() < 0.5 ? pick(ideas) : undefined });
    } else if (roll < 0.28) {
      desc = 'create idea';
      await m.edit({ entityType: 'idea', title: `idea ${word}` });
    } else if (roll < 0.48 && any) {
      desc = `edit title ${any}`;
      await m.edit({ taskId: any, fields: { title: `title ${word}` } });
    } else if (roll < 0.58 && any) {
      desc = `edit body ${any}`;
      await m.edit({ taskId: any, fields: { body: r() < 0.2 ? null : `body ${word}`, priority: pick(['P0', 'P1', 'P2', 'P3'] as const) } });
    } else if (roll < 0.68 && tasks.length > 0) {
      const t = pick(tasks) as string;
      desc = `stage ${t}`;
      await m.edit({ taskId: t, stageId: m.stageId(pick([1, 6, 9, 10]) as number) });
    } else if (roll < 0.74 && any) {
      desc = `archive ${any}`;
      await m.edit({ taskId: any, archived: r() < 0.6 });
    } else if (roll < 0.84 && tasks.length >= 2) {
      const a = pick(tasks) as string;
      const b = pick(tasks.filter((x) => x !== a)) as string;
      desc = `depend ${a}>${b}`;
      await m.edit({ taskId: a, dependsOnTaskId: b, removeDependency: r() < 0.3 });
    } else if (roll < 0.9 && tasks.length > 0) {
      const t = pick(tasks) as string;
      desc = `reparent ${t}`;
      await m.edit({ taskId: t, parentEpicId: r() < 0.7 ? (pick(epics) ?? null) : null });
    } else if (any) {
      desc = `delete ${any}`;
      await m.router.applyDelete(m.projectId, { actor: 'user', taskId: any });
    }
    log.push(`${m.device.code} ${desc}`);
  } catch (err) {
    // Local validation refusals (a cycle, idea_needs_epic, a vanished id) are
    // part of the fuzz: the op simply did not happen.
    log.push(`${m.device.code} ${desc} (refused: ${err instanceof Error ? err.message.slice(0, 60) : String(err)})`);
  }
}

describe.skipIf(!stagingEnabled)('remote sync convergence fuzz (staging)', () => {
  for (const seed of SEEDS) {
    it(
      `converges under random ops and faults (seed ${seed})`,
      async () => {
        const r = rng(seed);
        const t = await TwoMachines.create();
        const log: string[] = [];
        try {
          for (let step = 0; step < STEPS; step += 1) {
            const m = r() < 0.5 ? t.a : t.b;
            await randomOp(m, r, log);
            if (r() < 0.35) {
              const syncer = r() < 0.5 ? t.a : t.b;
              const f = r();
              if (f < 0.12) syncer.net.faults.push({ kind: 'drop_response', match: /POST .*\/push$/ });
              else if (f < 0.2) syncer.net.faults.push({ kind: 'fail_before', match: /\/v1\// });
              else if (f < 0.26) syncer.net.faults.push({ kind: 'drop_response', match: /GET .*\/changes/ });
              const outcome = await syncer.sync();
              log.push(`${syncer.device.code} sync → ${outcome.status}`);
            }
          }
          t.a.net.faults.length = 0;
          t.b.net.faults.length = 0;
          if (process.env.CYBOFLOW_SYNC_FUZZ_VERBOSE) process.stdout.write(`seed ${seed}\n${log.join('\n')}\n`);
          await t.settle(8);
          const ha = projectionHash(t.a.engine.syncedState(t.a.projectId));
          const hb = projectionHash(t.b.engine.syncedState(t.b.projectId));
          if (ha !== hb) {
            throw new Error(`seed ${seed}: projections diverged\n${log.join('\n')}`);
          }
          expect(await t.a.engine.checksum(t.a.projectId)).toBe('match');
          expect(await t.b.engine.checksum(t.b.projectId)).toBe('match');
          // Quiescence: nothing left dirty or waiting.
          for (const m of [t.a, t.b]) {
            const waiting = m.store.listInbox(m.projectId).filter((e) => Object.values(e.inbox).some((i) => i.reason !== 'deferred'));
            expect(waiting.map((e) => [e.entityId, e.inbox])).toEqual([]);
          }
        } finally {
          await t.dispose();
        }
      },
      600_000,
    );
  }
});
