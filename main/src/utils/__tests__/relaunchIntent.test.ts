import { describe, it, expect, vi, beforeEach } from 'vitest';
import { armRelaunchIfRequested, cancelRelaunchOnQuit, requestRelaunchOnQuit } from '../relaunchIntent';

beforeEach(() => cancelRelaunchOnQuit());

describe('relaunchIntent', () => {
  it('arms nothing without a request', () => {
    const relaunch = vi.fn();
    armRelaunchIfRequested(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('arms once per request', () => {
    const relaunch = vi.fn();
    requestRelaunchOnQuit();
    armRelaunchIfRequested(relaunch);
    armRelaunchIfRequested(relaunch);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('a cancelled quit leaves no relaunch for a later quit', () => {
    const relaunch = vi.fn();
    requestRelaunchOnQuit();
    cancelRelaunchOnQuit();
    armRelaunchIfRequested(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
  });
});
