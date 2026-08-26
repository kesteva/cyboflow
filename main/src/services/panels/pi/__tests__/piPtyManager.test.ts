import { describe, expect, it } from 'vitest';
import { assertPiRequiredSpawnFlags, PiPtyManager } from '../piPtyManager';
import { evaluatePiVersionPolicy } from '../piVersions';

/**
 * Test seam: exposes the protected argv builder without unchecked casts.
 * Constructor deps are the manager's own narrowed seams; no PTY is spawned.
 */
class ExposedPiPtyManager extends PiPtyManager {
  exposeBuildCommandArgs(o: { prompt: string; model?: string; isContinue?: boolean }): string[] {
    return this.buildCommandArgs({
      panelId: 'p',
      sessionId: 's',
      worktreePath: '/tmp',
      prompt: o.prompt,
      model: o.model,
      isContinue: o.isContinue,
    });
  }
}

function makeExposed(): ExposedPiPtyManager {
  return new ExposedPiPtyManager(
    { getDbSession: () => null } as never,
    undefined,
    { getDefaultAgentPermissionMode: () => 'default' } as never,
  );
}

describe('Pi PTY spawn security invariant', () => {
  it('accepts argv carrying the full discovery-lockdown pair', () => {
    expect(() =>
      assertPiRequiredSpawnFlags(['--no-extensions', '--no-skills', '--model', 'x']),
    ).not.toThrow();
  });

  it('refuses argv missing either lockdown flag (spawn-time assertion)', () => {
    expect(() => assertPiRequiredSpawnFlags(['--no-extensions'])).toThrow(/dropped required flag/);
    expect(() => assertPiRequiredSpawnFlags([])).toThrow(/dropped required flag/);
  });

  it('buildCommandArgs emits lockdown pair first, model, continue, then prompt', () => {
    const args = makeExposed().exposeBuildCommandArgs({
      prompt: 'do a thing',
      model: 'anthropic/claude-opus-4-6',
      isContinue: true,
    });
    expect(args.slice(0, 2)).toEqual(['--no-extensions', '--no-skills']);
    expect(args).toContain('--continue');
    expect(args[args.length - 1]).toBe('do a thing');
  });

  it('space-prefixes a dash-leading prompt (pi has no -- terminator)', () => {
    const args = makeExposed().exposeBuildCommandArgs({
      prompt: '-rm -rf /',
      isContinue: false,
    });
    expect(args[args.length - 1]).toBe(' -rm -rf /');
    expect(() => assertPiRequiredSpawnFlags(args)).not.toThrow();
  });
});

describe('evaluatePiVersionPolicy', () => {
  it('floors below 0.84.0 with a reason and accepts the tested version', () => {
    expect(evaluatePiVersionPolicy('0.80.1')).toEqual({
      ok: false,
      aboveTested: false,
      reason: 'below-floor',
    });
    expect(evaluatePiVersionPolicy('0.84.2')).toEqual({
      ok: true,
      aboveTested: false,
      reason: undefined,
    });
    expect(evaluatePiVersionPolicy('0.85.0').aboveTested).toBe(true);
  });

  it('fails closed on unparseable version output', () => {
    expect(evaluatePiVersionPolicy('pi-unknown')).toMatchObject({ ok: false, reason: 'unparseable' });
  });
});
