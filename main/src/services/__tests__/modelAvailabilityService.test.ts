import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ModelAvailabilityService,
  isModelUsable,
  isModelUnavailableError,
} from '../modelAvailabilityService';
import {
  isAliasUsable,
  guardedModelByAlias,
  guardedModelByConcreteId,
  type ModelAvailabilityMap,
} from '../../../../shared/types/modelAvailability';

const FABLE = 'claude-fable-5';

describe('ModelAvailabilityService', () => {
  beforeEach(() => {
    ModelAvailabilityService._resetForTesting();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    ModelAvailabilityService._resetForTesting();
  });

  describe('seeded state + isUsable', () => {
    it('seeds guarded models as unknown → optimistically usable', () => {
      const svc = ModelAvailabilityService.initialize();
      expect(svc.isUsable(FABLE)).toBe(true);
      expect(svc.snapshot()[FABLE]).toMatchObject({ status: 'unknown', reason: null, checkedAt: null });
    });

    it('non-guarded ids are always usable', () => {
      const svc = ModelAvailabilityService.initialize();
      expect(svc.isUsable('claude-opus-4-8[1m]')).toBe(true);
      expect(svc.isUsable('claude-sonnet-5')).toBe(true);
      expect(svc.isUsable(undefined)).toBe(true);
      expect(svc.isUsable('some-future-model')).toBe(true);
    });

    it('accepts a [1m]-suffixed guarded id (marker stripped for matching)', () => {
      const svc = ModelAvailabilityService.initialize();
      svc.markUnavailable(FABLE, '404');
      expect(svc.isUsable('claude-fable-5[1m]')).toBe(false);
    });
  });

  describe('mark + snapshot + change events', () => {
    it('markUnavailable flips usability and records the reason', () => {
      const svc = ModelAvailabilityService.initialize({ now: () => 123 });
      svc.markUnavailable(FABLE, '404 not_found');
      expect(svc.isUsable(FABLE)).toBe(false);
      expect(svc.snapshot()[FABLE]).toEqual({
        concreteId: FABLE,
        status: 'unavailable',
        reason: '404 not_found',
        checkedAt: 123,
      });
    });

    it('markAvailable clears the reason and restores usability', () => {
      const svc = ModelAvailabilityService.initialize();
      svc.markUnavailable(FABLE, 'gone');
      svc.markAvailable(FABLE);
      expect(svc.isUsable(FABLE)).toBe(true);
      expect(svc.snapshot()[FABLE]).toMatchObject({ status: 'available', reason: null });
    });

    it('emits "changed" only on a real status transition', () => {
      const svc = ModelAvailabilityService.initialize();
      const changed = vi.fn();
      svc.on('changed', changed);
      svc.markUnavailable(FABLE, 'a');
      svc.markUnavailable(FABLE, 'b'); // same status → no new event
      svc.markAvailable(FABLE); // transition → event
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ [FABLE]: expect.objectContaining({ status: 'available' }) }));
    });

    it('ignores marks for non-guarded ids (untracked, no event)', () => {
      const svc = ModelAvailabilityService.initialize();
      const changed = vi.fn();
      svc.on('changed', changed);
      svc.markUnavailable('claude-opus-4-8', 'nope');
      expect(changed).not.toHaveBeenCalled();
      expect(svc.snapshot()['claude-opus-4-8']).toBeUndefined();
    });
  });

  describe('isModelUsable module helper', () => {
    it('defaults to usable when the service is uninitialized', () => {
      expect(isModelUsable(FABLE)).toBe(true);
    });

    it('reflects the singleton once initialized', () => {
      const svc = ModelAvailabilityService.initialize();
      svc.markUnavailable(FABLE, 'x');
      expect(isModelUsable(FABLE)).toBe(false);
      expect(isModelUsable('claude-opus-4-8')).toBe(true);
    });
  });

  describe('refresh (best-effort Models-API probe)', () => {
    it('skips the probe entirely when no credential is in the environment', async () => {
      const fetchImpl = vi.fn();
      const svc = ModelAvailabilityService.initialize({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await svc.refresh();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(svc.isUsable(FABLE)).toBe(true); // stays optimistic
    });

    it('marks unavailable on a 404 and available on a 200', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 });
      const svc = ModelAvailabilityService.initialize({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await svc.refresh();
      expect(svc.isUsable(FABLE)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models/claude-fable-5',
        expect.objectContaining({ method: 'GET' }),
      );

      const fetchOk = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const svc2 = ModelAvailabilityService.initialize({ fetchImpl: fetchOk as unknown as typeof fetch });
      await svc2.refresh();
      expect(svc2.isUsable(FABLE)).toBe(true);
    });

    it('leaves state unchanged on a transient (5xx) or network error', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const svc = ModelAvailabilityService.initialize({
        fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch,
      });
      await svc.refresh();
      expect(svc.snapshot()[FABLE].status).toBe('unknown'); // not flipped

      const svc2 = ModelAvailabilityService.initialize({
        fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch,
      });
      await svc2.refresh();
      expect(svc2.snapshot()[FABLE].status).toBe('unknown');
    });

    it('sends the api-key header and honors ANTHROPIC_BASE_URL', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-abc';
      process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com/';
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const svc = ModelAvailabilityService.initialize({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await svc.refresh();
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://proxy.example.com/v1/models/claude-fable-5',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-key': 'sk-abc', 'anthropic-version': '2023-06-01' }),
        }),
      );
    });
  });
});

describe('isModelUnavailableError', () => {
  it('matches model-not-found / no-access phrasings', () => {
    expect(isModelUnavailableError('model claude-fable-5 not found')).toBe(true);
    expect(isModelUnavailableError('The requested model does not exist')).toBe(true);
    expect(isModelUnavailableError('404 not_found_error: model unavailable')).toBe(true);
    expect(isModelUnavailableError('invalid model id')).toBe(true);
    expect(isModelUnavailableError('You do not have access to model claude-fable-5')).toBe(true);
    expect(isModelUnavailableError('this model has been retired')).toBe(true);
  });

  it('does NOT match unrelated runtime errors', () => {
    expect(isModelUnavailableError('rate limit exceeded')).toBe(false);
    expect(isModelUnavailableError('tool execution failed: ENOENT')).toBe(false);
    expect(isModelUnavailableError('the model responded slowly')).toBe(false); // "model" but no unavailability signal
    expect(isModelUnavailableError('connection reset')).toBe(false);
  });
});

describe('shared guarded-model helpers (frontend picker grey-out logic)', () => {
  it('guardedModelByAlias matches case/space-insensitively; undefined otherwise', () => {
    expect(guardedModelByAlias('fable')?.concreteId).toBe(FABLE);
    expect(guardedModelByAlias(' Fable ')?.concreteId).toBe(FABLE);
    expect(guardedModelByAlias('opus')).toBeUndefined();
    expect(guardedModelByAlias(null)).toBeUndefined();
  });

  it('guardedModelByConcreteId strips a [1m] marker before matching', () => {
    expect(guardedModelByConcreteId('claude-fable-5')?.alias).toBe('fable');
    expect(guardedModelByConcreteId('claude-fable-5[1m]')?.alias).toBe('fable');
    expect(guardedModelByConcreteId('claude-opus-4-8[1m]')).toBeUndefined();
  });

  it('isAliasUsable: non-guarded aliases always usable; guarded reflects the map', () => {
    const usableMap: ModelAvailabilityMap = {};
    expect(isAliasUsable('fable', usableMap)).toBe(true); // unknown → optimistic
    expect(isAliasUsable('opus', usableMap)).toBe(true);
    expect(isAliasUsable('auto', usableMap)).toBe(true);

    const goneMap: ModelAvailabilityMap = {
      [FABLE]: { concreteId: FABLE, status: 'unavailable', reason: '404', checkedAt: 1 },
    };
    expect(isAliasUsable('fable', goneMap)).toBe(false);
    expect(isAliasUsable('opus', goneMap)).toBe(true); // non-guarded unaffected

    const backMap: ModelAvailabilityMap = {
      [FABLE]: { concreteId: FABLE, status: 'available', reason: null, checkedAt: 2 },
    };
    expect(isAliasUsable('fable', backMap)).toBe(true);
  });
});
