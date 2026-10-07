import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as P from '../relayProtocol';

/** Same value the relay pins for its copy. Change both copies in lockstep, then re-pin both tests. */
const PINNED_SHA256 = '425e1acb1fc577679ea4652682d7f48ee4c9076c2f24d89fb74aef49faa7490d';
const SOURCE = join(__dirname, '..', 'relayProtocol.ts');

describe('vendored relay protocol', () => {
  it('relayProtocol.ts matches the pinned sha256', () => {
    const actual = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
    expect(
      actual,
      'shared/types/relayProtocol.ts changed. It must stay byte-identical to the relay copy: apply the SAME ' +
        'change to the relay copy, then update PINNED_SHA256 in both tests.',
    ).toBe(PINNED_SHA256);
  });

  it('relayProtocol.ts has no imports', () => {
    const source = readFileSync(SOURCE, 'utf-8');
    // `[^;\n]` (not `[^;]`): a multi-line `[^;]*` runs from `export const RELAY_TOOLS … = [` into
    // the word " from " inside a tool description and false-positives on the pinned file.
    expect(source).not.toMatch(/^\s*import\s|^\s*export\s[^;\n]*\sfrom\s|require\(/m);
  });

  it('exports the constants the desktop relies on', () => {
    expect(P.RELAY_PROTOCOL_VERSION).toBe(1);
    expect(P.RELAY_PROTOCOL_HEADER).toBe('Cyboflow-Relay-Protocol');
    expect(P.MAX_INBOUND_PAGE).toBe(100);
    expect(P.MAX_MESSAGE_BYTES).toBe(65536);
    expect(P.PAIRING_TTL_MS).toBe(600000);
    expect(P.DOORBELL_CLOSE_DEVICE_REVOKED).toBe(4401);
    expect(P.RELAY_REVOKE_PENDING).toBe('revoke_pending');
  });
});
