/**
 * services/database.ts no longer opens its own DatabaseService at import time:
 * index.ts registers the one instance after the schema-version gate and
 * initialize(), and the `databaseService` export forwards to it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseService } from '../../database/database';

beforeEach(() => {
  vi.resetModules();
});

describe('services/database registry', () => {
  it('opens nothing at import and throws if used before registration', async () => {
    const mod = await import('../database');
    expect(() => mod.databaseService.getSession('s1')).toThrow(/before index\.ts registered it/);
  });

  it('forwards calls to the registered instance with `this` bound to it', async () => {
    const mod = await import('../database');
    const fake = {
      marker: 'registered',
      getSession(this: { marker: string }, id: string) {
        return { id, via: this.marker };
      },
    };
    mod.setDatabaseService(fake as unknown as DatabaseService);

    const detached = mod.databaseService.getSession;
    expect(detached('s1')).toEqual({ id: 's1', via: 'registered' });
  });
});
