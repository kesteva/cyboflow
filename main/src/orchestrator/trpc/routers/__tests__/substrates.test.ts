/**
 * Integration tests for cyboflow.substrates.resolveEffective — the batch-cap
 * preview seam that MUST mirror what WorkflowRegistry.createRun stamps.
 *
 * The precedence the picker relies on:
 *   1. A non-null forced pin (ctx.getForcedSubstrate — demo-mode 'sdk' or the
 *      global interactive-PTY-only lock) OUTRANKS and ignores requestedSubstrate.
 *   2. With no pin, it falls through to resolveSubstrate(requested + env), whose
 *      hard floor is 'sdk'.
 *   3. createContext defaults getForcedSubstrate to () => null when omitted.
 *
 * A regression here previews the wrong selection cap N (15 sdk / 10 interactive)
 * under a lock — the retire target the batch calls out.
 */
import { describe, it, expect } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { SUBSTRATE_ENV_VAR } from '../../../substrateResolver';
import type { CliSubstrate } from '../../../../../../shared/types/substrate';

function callerWith(forced: CliSubstrate | null | undefined): ReturnType<typeof appRouter.createCaller> {
  // `undefined` exercises the createContext default (() => null); a function
  // exercises an explicit pin.
  const deps = forced === undefined ? {} : { getForcedSubstrate: () => forced };
  return appRouter.createCaller(createContext(deps));
}

describe('cyboflow.substrates.resolveEffective', () => {
  it('a forced pin outranks and ignores requestedSubstrate', async () => {
    const caller = callerWith('interactive');
    const res = await caller.cyboflow.substrates.resolveEffective({
      requestedSubstrate: 'sdk',
    });
    expect(res).toEqual({ substrate: 'interactive' });
  });

  it('a forced sdk pin wins even against a requested interactive substrate', async () => {
    const caller = callerWith('sdk');
    const res = await caller.cyboflow.substrates.resolveEffective({
      requestedSubstrate: 'interactive',
    });
    expect(res).toEqual({ substrate: 'sdk' });
  });

  it('falls through to the resolver ladder when the pin is null (honors requested)', async () => {
    const caller = callerWith(null);
    const res = await caller.cyboflow.substrates.resolveEffective({
      requestedSubstrate: 'interactive',
    });
    expect(res).toEqual({ substrate: 'interactive' });
  });

  it('defaults getForcedSubstrate to () => null when omitted, then floors to sdk', async () => {
    const prev = process.env[SUBSTRATE_ENV_VAR];
    delete process.env[SUBSTRATE_ENV_VAR];
    try {
      const caller = callerWith(undefined);
      const res = await caller.cyboflow.substrates.resolveEffective({});
      expect(res).toEqual({ substrate: 'sdk' });
    } finally {
      if (prev === undefined) delete process.env[SUBSTRATE_ENV_VAR];
      else process.env[SUBSTRATE_ENV_VAR] = prev;
    }
  });
});
