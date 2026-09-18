/**
 * Unit tests for the drafting agent's output contract
 * (docs/proposals/lane-runbook-bootstrap.md §8, §8.1).
 *
 * This parser is the ONLY thing standing between a model's free-form answer and
 * a file the controller commits to someone's branch. Two properties are worth
 * more than the rest and are pinned individually below:
 *
 *  1. `not-possible` is a FIRST-CLASS success, and it must carry a reason. An
 *     agent that felt obliged to return *something* is exactly how this feature
 *     would manufacture a runbook for a project that has none, so the honest
 *     refusal has to be as easy to express as the answer.
 *  2. An operation whose `kind` this build does not understand is REJECTED, not
 *     dropped. Silently ignoring it would register a runbook whose commands
 *     cannot work — the agent proposed the change precisely because they need
 *     it — while reporting success.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRunbookDraftResult,
  targetFileForOperation,
  RUNG1_OPERATION_KINDS,
  type Rung1Operation,
} from '../runbookDraft';

const RUNBOOK = {
  version: 1,
  modalities: {
    web: {
      build: ['pnpm run build'],
      serve: { cmd: 'pnpm run preview --port ${PORT}' },
      attestation: { kind: 'dom-marker', selector: '[data-verify-build]' },
    },
  },
};

function draft(over: Record<string, unknown> = {}): unknown {
  return { decision: 'runbook', modality: 'web', runbook: RUNBOOK, ...over };
}

describe('parseRunbookDraftResult — not-possible', () => {
  it('accepts a refusal and keeps its reason', () => {
    const parsed = parseRunbookDraftResult({
      decision: 'not-possible',
      reason: 'no script serves the renderer; `dev` starts only the API',
    });
    expect(parsed).toEqual({
      ok: true,
      result: { decision: 'not-possible', reason: 'no script serves the renderer; `dev` starts only the API' },
    });
  });

  it('REJECTS a refusal with no reason', () => {
    // The reason is the only thing a refusal produces: it is what the human
    // reads instead of a verification, and what stops the project paying for the
    // same attempt every sprint. An unexplained refusal is worth almost nothing.
    const parsed = parseRunbookDraftResult({ decision: 'not-possible', reason: '   ' });
    expect(parsed.ok).toBe(false);
  });
});

describe('parseRunbookDraftResult — runbook', () => {
  it('accepts a well-formed draft and returns the parsed runbook', () => {
    const parsed = parseRunbookDraftResult(draft({ notes: 'serve cmd is package.json:12' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.result.decision !== 'runbook') throw new Error('unreachable');
    expect(parsed.result.modality).toBe('web');
    expect(parsed.result.notes).toBe('serve cmd is package.json:12');
    expect(parsed.result.runbook.modalities.web?.serve?.cmd).toBe('pnpm run preview --port ${PORT}');
  });

  it('rejects a runbook that does not declare the modality it was drafted FOR', () => {
    // The store rejects this at registerDraft anyway; catching it here means the
    // controller never writes and commits a file it is about to be told is
    // useless.
    const parsed = parseRunbookDraftResult(draft({ modality: 'cdp-app' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('cdp-app');
  });

  it('ACCEPTS a well-shaped mobile draft — the portable contract declares four modalities now', () => {
    // The mobile widening added `app` to the entry, so `mobile` is no longer a
    // modality the parser refuses. Whether a LANE may draft one is a separate
    // question, answered in the eligibility layer
    // (`bootstrapSupportsModality` / `'auto-derive-unsupported'`) — this parser
    // is shared with the verify-setup flow, which DOES author mobile runbooks,
    // and rejecting here would break that flow to enforce a lane policy.
    const parsed = parseRunbookDraftResult(
      draft({
        modality: 'mobile',
        runbook: {
          version: 1,
          modalities: {
            mobile: {
              build: ['xcodebuild -scheme Demo -destination "generic/platform=iOS Simulator" build'],
              // No `serve`: a simulator run has no port to lease. `app` replaces it.
              app: { platform: 'ios-simulator', bundleId: 'com.example.demo', scheme: 'Demo' },
              attestation: { kind: 'bundle-identity', bundleId: 'com.example.demo' },
            },
          },
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.result.decision !== 'runbook') throw new Error('unreachable');
    expect(parsed.result.modality).toBe('mobile');
    expect(parsed.result.runbook.modalities.mobile?.app?.bundleId).toBe('com.example.demo');
  });

  it('still rejects a modality the portable contract has no room for', () => {
    // The negative control the mobile case above used to be. Without it, the
    // widening reads as "the modality check was removed" rather than "one value
    // moved from the reject list to the accept list".
    const parsed = parseRunbookDraftResult(draft({ modality: 'android' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('android');
  });

  it('delegates the runbook half to the SAME parser the store reads it back with', () => {
    // A draft that passed here and failed at registerDraft would be a contract
    // split with nothing to gain — so an invalid attestation is caught here, by
    // parseVerifyRunbookV1, rather than two steps later.
    const parsed = parseRunbookDraftResult(
      draft({
        runbook: {
          version: 1,
          modalities: { web: { serve: { cmd: 'pnpm dev' }, attestation: { kind: 'telepathy' } } },
        },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('runbook:');
  });

  it('rejects an unrecognized decision outright', () => {
    expect(parseRunbookDraftResult(draft({ decision: 'maybe' })).ok).toBe(false);
    expect(parseRunbookDraftResult('a sentence').ok).toBe(false);
  });
});

describe('parseRunbookDraftResult — the rung-1 operation', () => {
  it('is absent on the ordinary rung-0 draft', () => {
    const parsed = parseRunbookDraftResult(draft());
    if (!parsed.ok || parsed.result.decision !== 'runbook') throw new Error('unreachable');
    expect(parsed.result.operation).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, Rung1Operation]>([
    [
      'add-script',
      { kind: 'add-script', scriptName: 'verify:serve', command: 'vite preview' },
      { kind: 'add-script', scriptName: 'verify:serve', command: 'vite preview' },
    ],
    [
      'port-from-env',
      { kind: 'port-from-env', file: 'vite.config.ts', port: 5173, envVar: 'PORT' },
      { kind: 'port-from-env', file: 'vite.config.ts', port: 5173, envVar: 'PORT' },
    ],
    [
      'relax-strict-port',
      { kind: 'relax-strict-port', file: 'vite.config.ts', setting: 'strictPort' },
      { kind: 'relax-strict-port', file: 'vite.config.ts', setting: 'strictPort' },
    ],
  ])('parses a %s operation', (_label, input, expected) => {
    const parsed = parseRunbookDraftResult(draft({ operation: input }));
    if (!parsed.ok || parsed.result.decision !== 'runbook') throw new Error('unreachable');
    expect(parsed.result.operation).toEqual(expected);
  });

  it('REJECTS an unknown operation kind rather than dropping it', () => {
    // The load-bearing case. Ignoring an operation this build does not
    // understand would commit a runbook whose commands cannot work — the agent
    // proposed the change because they need it — and report success.
    const parsed = parseRunbookDraftResult(draft({ operation: { kind: 'rewrite-webpack-config' } }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    for (const kind of RUNG1_OPERATION_KINDS) expect(parsed.error).toContain(kind);
  });

  it.each([
    ['add-script with no command', { kind: 'add-script', scriptName: 'x' }],
    ['port-from-env with a non-integer port', { kind: 'port-from-env', file: 'a.ts', port: 51.7, envVar: 'P' }],
    ['port-from-env with a negative port', { kind: 'port-from-env', file: 'a.ts', port: -1, envVar: 'P' }],
    ['relax-strict-port with no setting', { kind: 'relax-strict-port', file: 'a.ts' }],
    ['a non-object operation', 'add a script please'],
  ])('rejects %s', (_label, operation) => {
    expect(parseRunbookDraftResult(draft({ operation })).ok).toBe(false);
  });
});

describe('targetFileForOperation', () => {
  it('pins add-script to the root package.json, which carries no file parameter', () => {
    // Stated once here rather than re-derived at each call site: there is no
    // channel through which add-script could be aimed at another file.
    expect(targetFileForOperation({ kind: 'add-script', scriptName: 'a', command: 'b' })).toBe('package.json');
  });

  it('uses the named file for the other two', () => {
    expect(
      targetFileForOperation({ kind: 'relax-strict-port', file: 'apps/web/vite.config.ts', setting: 'strictPort' }),
    ).toBe('apps/web/vite.config.ts');
  });
});
