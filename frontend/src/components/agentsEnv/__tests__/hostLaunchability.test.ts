import { describe, expect, it } from 'vitest';
import { hostLaunchability } from '../hostLaunchability';
import { makeHost, makeLocalHost, makePreflight } from './fixtures';

const ready = (over = {}) =>
  makeHost({ effectiveTier: 'full', detectedTier: 'full', remoteReady: true, preflight: makePreflight({ runtimes: { claudeSdk: true, codexSdk: true, claudeCli: true, codexCli: true } }), ...over });
const reason = (h: ReturnType<typeof makeHost>, o: Parameters<typeof hostLaunchability>[1] = { kind: 'workflow' }) => {
  const v = hostLaunchability(h, o);
  return v.ok ? null : v.reason;
};

describe('hostLaunchability', () => {
  it('This Mac is always ok', () => {
    expect(hostLaunchability(makeLocalHost(), { kind: 'workflow', runtime: 'claude-interactive' })).toEqual({ ok: true });
  });
  it('a ready full-tier host is ok for SDK runtimes', () => {
    expect(hostLaunchability(ready(), { kind: 'workflow', runtime: 'claude-sdk' })).toEqual({ ok: true });
    expect(hostLaunchability(ready(), { kind: 'session', runtime: 'codex-sdk' })).toEqual({ ok: true });
  });
  it('explains each refusal', () => {
    expect(reason(ready({ archivedAt: '2026-10-01T00:00:00Z' }))).toBe('Archived');
    expect(reason(ready(), { kind: 'workflow', featureStatus: { killed: true } })).toBe('Remote environments are turned off');
    expect(reason(ready({ lifecycleState: 'unreachable' }))).toBe('Unreachable');
    expect(reason(ready({ lifecycleState: 'asleep' }))).toBe('Asleep');
    expect(reason(ready({ effectiveTier: null }))).toBe('Run a check first');
    expect(reason(ready({ effectiveTier: 'cli' }))).toBe('Terminal only');
    expect(reason(ready({ effectiveTier: 'cli', userCapTier: 'cli' }))).toBe('Terminal only (limited by you)');
    expect(reason(ready({ remoteReady: false }))).toBe('Install cyboflow tools first');
    expect(reason(ready(), { kind: 'session', runtime: 'claude-interactive' })).toBe(
      'Only Claude and Codex SDK sessions run on remote environments',
    );
  });
  it('checks the per-runtime sign-in flag', () => {
    const h = ready({ preflight: makePreflight({ runtimes: { claudeSdk: false, codexSdk: false, claudeCli: true, codexCli: true } }) });
    expect(reason(h, { kind: 'workflow', runtime: 'claude-sdk' })).toBe('Claude is not signed in there');
    expect(reason(h, { kind: 'workflow', runtime: 'codex-sdk' })).toBe('Codex is not signed in there');
  });
});
