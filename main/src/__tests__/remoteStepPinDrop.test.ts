import { describe, it, expect } from 'vitest';
import { shouldDropPinForRemoteRun } from '../programmaticRunnerComposition';

describe('shouldDropPinForRemoteRun', () => {
  it('drops local-only runtimes on a remote run', () => {
    for (const r of ['pi-sdk', 'omp', 'claude-pty', 'codex-pty']) {
      expect(shouldDropPinForRemoteRun(r, true)).toBe(true);
    }
  });
  it('keeps SDK runtimes on a remote run', () => {
    expect(shouldDropPinForRemoteRun('claude-sdk', true)).toBe(false);
    expect(shouldDropPinForRemoteRun('codex-sdk', true)).toBe(false);
  });
  it('never drops on a local run, and ignores an absent pin', () => {
    expect(shouldDropPinForRemoteRun('pi-sdk', false)).toBe(false);
    expect(shouldDropPinForRemoteRun(undefined, true)).toBe(false);
  });
});
