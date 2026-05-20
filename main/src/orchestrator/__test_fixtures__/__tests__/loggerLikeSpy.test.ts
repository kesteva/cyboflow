/**
 * Smoke-tests for makeSpyLogger fixture.
 *
 * Locks in the dual contract:
 *   1. calls array shape — each entry has { level, message, ctx? }.
 *   2. Per-method vi.fn spy-ability — mock.calls[0] reflects each invocation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeSpyLogger } from '../loggerLikeSpy';

describe('makeSpyLogger', () => {
  let logger: ReturnType<typeof makeSpyLogger>;

  beforeEach(() => {
    logger = makeSpyLogger();
  });

  // -------------------------------------------------------------------------
  // calls array shape
  // -------------------------------------------------------------------------

  it('pushes { level, message } onto calls when ctx is omitted', () => {
    logger.info('hello');

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toEqual({ level: 'info', message: 'hello' });
  });

  it('pushes { level, message, ctx } onto calls when ctx is provided', () => {
    logger.warn('something happened', { code: 42, path: '/tmp' });

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toEqual({
      level: 'warn',
      message: 'something happened',
      ctx: { code: 42, path: '/tmp' },
    });
  });

  it('accumulates calls across multiple method invocations in order', () => {
    logger.info('first');
    logger.error('second', { detail: 'boom' });
    logger.debug('third');

    expect(logger.calls).toHaveLength(3);
    expect(logger.calls[0].level).toBe('info');
    expect(logger.calls[1].level).toBe('error');
    expect(logger.calls[2].level).toBe('debug');
  });

  it('records all four log levels', () => {
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    logger.debug('d');

    const levels = logger.calls.map((c) => c.level);
    expect(levels).toEqual(['info', 'warn', 'error', 'debug']);
  });

  // -------------------------------------------------------------------------
  // Per-method vi.fn spy-ability
  // -------------------------------------------------------------------------

  it('each method is individually spy-able via .mock.calls', () => {
    logger.info('msg-a', { x: 1 });

    // Per-method spy surface
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('msg-a', { x: 1 });

    // calls array surface — same invocation reflected in both
    expect(logger.calls[0]).toEqual({ level: 'info', message: 'msg-a', ctx: { x: 1 } });
  });

  it('warn mock.calls[0] and calls[0] both reflect the invocation', () => {
    logger.warn('watch out', { key: 'val' });

    expect(logger.warn).toHaveBeenCalledWith('watch out', { key: 'val' });
    expect(logger.calls[0]).toEqual({
      level: 'warn',
      message: 'watch out',
      ctx: { key: 'val' },
    });
  });

  it('error and debug methods are also vi.fn spies', () => {
    logger.error('bad');
    logger.debug('trace', { step: 2 });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('bad');

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith('trace', { step: 2 });
  });

  it('does NOT include ctx key when ctx is undefined', () => {
    logger.info('bare message');

    // The ctx key must be absent (not present as undefined) so strict equality works.
    expect('ctx' in logger.calls[0]).toBe(false);
  });
});
