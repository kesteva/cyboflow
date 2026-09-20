/**
 * The adversarial-review document parser.
 *
 * The producer is a language model, so every test here is really about the same
 * property: the parse DEGRADES rather than failing. A canonical document parses
 * exactly; a sloppy one still yields entries; a document with nothing in it yields
 * empty arrays instead of throwing at the gate that needs to open.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAdversarialReviewDoc,
  adversarialSeverityToReviewSeverity,
  maxAdversarialId,
  ADVERSARIAL_SEVERITIES,
} from '../adversarialReview';

const CANONICAL = `## Result

### Blocking

#### AR-1 — The spend flow has no error state
**Severity:** blocker   **Area:** prototype
**What:** Every screen assumes the payment succeeds.
**Why it matters:** The first real failure leaves the user on a dead screen with no way back.
**Fix:** Add a failure screen to the prototype and name it in the design spec.

#### AR-2 — Task criteria never mention reachability
**Severity:** major   **Area:** criteria
**What:** No task requires its screen to be reachable from the entry point.
**Why it matters:** Each task passes alone while the app has no navigation.
**Fix:** Add a reachability criterion to every screen-owning task.

### Findings

#### AR-3 — The architecture names a queue it never uses
**Severity:** minor   **Area:** architecture
**What:** A job queue appears in the diagram and nowhere else.
**Why it matters:** A later reader builds it.
**Fix:** Drop it or say what it is for.

#### AR-4 — Copy is inconsistent between two screens
**Severity:** advisory   **Area:** prototype
**What:** "Spend" on one screen, "Purchase" on the other.
**Why it matters:** Small, but it will be copied into the build.
**Fix:** Pick one.
`;

describe('parseAdversarialReviewDoc — canonical document', () => {
  it('splits the two buckets and reads every field', () => {
    const parsed = parseAdversarialReviewDoc(CANONICAL);

    expect(parsed.blocking.map((f) => f.id)).toEqual(['AR-1', 'AR-2']);
    expect(parsed.findings.map((f) => f.id)).toEqual(['AR-3', 'AR-4']);

    expect(parsed.blocking[0]).toEqual({
      id: 'AR-1',
      title: 'The spend flow has no error state',
      severity: 'blocker',
      area: 'prototype',
      what: 'Every screen assumes the payment succeeds',
      why: 'The first real failure leaves the user on a dead screen with no way back',
      fix: 'Add a failure screen to the prototype and name it in the design spec',
    });
    expect(parsed.blocking[1].severity).toBe('major');
    expect(parsed.findings[0].severity).toBe('minor');
    expect(parsed.findings[1].severity).toBe('advisory');
    expect(parsed.findings[1].area).toBe('prototype');
  });
});

describe('parseAdversarialReviewDoc — the PROMOTED (artifact) heading form', () => {
  // The step agent composes the reported artifact by PROMOTING the subagent's
  // nested `## Result` > `### Blocking` / `### Findings` to top-level `## Blocking`
  // / `## Findings`, keeping each `#### AR-n` entry. Both depths must parse, because
  // the artifact is the promoted form while a Revise threads the raw form back in.
  const PROMOTED = `## Blocking

#### AR-1 — The spend flow has no error state
**Severity:** blocker   **Area:** prototype
**What:** Every screen assumes the payment succeeds.
**Why it matters:** The first failure is a dead end.
**Fix:** Add a failure screen.

## Findings

#### AR-2 — An unused queue in the architecture
**Severity:** minor   **Area:** architecture

#### AR-3 — Copy drifts between two screens
**Severity:** advisory   **Area:** prototype
`;

  it('parses top-level ## Blocking / ## Findings into the right buckets', () => {
    const parsed = parseAdversarialReviewDoc(PROMOTED);
    expect(parsed.blocking.map((f) => f.id)).toEqual(['AR-1']);
    expect(parsed.findings.map((f) => f.id)).toEqual(['AR-2', 'AR-3']);
    expect(parsed.blocking[0]).toMatchObject({
      severity: 'blocker',
      area: 'prototype',
      fix: 'Add a failure screen',
    });
    expect(parsed.findings[0].severity).toBe('minor');
    expect(parsed.findings[1].severity).toBe('advisory');
  });

  it('yields the SAME entries as the nested form of the same content', () => {
    const nested = `## Result\n\n### Blocking\n${PROMOTED.split('## Blocking')[1].split('## Findings')[0]}### Findings\n${PROMOTED.split('## Findings')[1]}`;
    expect(parseAdversarialReviewDoc(nested)).toEqual(parseAdversarialReviewDoc(PROMOTED));
  });

  it('keeps AR ids numbered ONCE across both sections (they never restart under Findings)', () => {
    const parsed = parseAdversarialReviewDoc(PROMOTED);
    const ids = [...parsed.blocking, ...parsed.findings].map((f) => f.id);
    expect(ids).toEqual(['AR-1', 'AR-2', 'AR-3']);
    // Every id is unique across the whole document — this is what makes the
    // approve-side idempotence key (the AR-n title prefix) safe.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles a promoted document whose Blocking section is empty', () => {
    const parsed = parseAdversarialReviewDoc(
      '## Blocking\n\nNone.\n\n## Findings\n\n#### AR-1 — Only advisory\n**Severity:** advisory\n',
    );
    expect(parsed.blocking).toEqual([]);
    expect(parsed.findings.map((f) => f.id)).toEqual(['AR-1']);
  });
});

describe('parseAdversarialReviewDoc — empty and degenerate documents', () => {
  it('reads `None.` under a heading as zero entries', () => {
    const parsed = parseAdversarialReviewDoc('## Result\n\n### Blocking\n\nNone.\n\n### Findings\n\nNone.\n');
    expect(parsed).toEqual({ blocking: [], findings: [], prior: [] });
  });

  it('returns empty arrays for null / empty / heading-less input', () => {
    for (const input of [null, undefined, '', 'Just some prose with no headings at all.']) {
      expect(parseAdversarialReviewDoc(input)).toEqual({ blocking: [], findings: [], prior: [] });
    }
  });

  it('keeps a blocking entry that omits every field, defaulting its severity to the SECTION', () => {
    const parsed = parseAdversarialReviewDoc('## Blocking\n\n#### AR-7 — Something is wrong\n');
    expect(parsed.blocking).toEqual([
      { id: 'AR-7', title: 'Something is wrong', severity: 'blocker' },
    ]);
    expect(parsed.findings).toEqual([]);
  });

  it('defaults an advisory-section entry with no severity to advisory', () => {
    const parsed = parseAdversarialReviewDoc('## Findings\n\n#### AR-8 — A note\n');
    expect(parsed.findings[0].severity).toBe('advisory');
  });

  it('files an entry written before ANY section heading as a finding rather than dropping it', () => {
    const parsed = parseAdversarialReviewDoc('#### AR-9 — Orphan entry\n**Severity:** minor\n');
    expect(parsed.blocking).toEqual([]);
    expect(parsed.findings[0]).toMatchObject({ id: 'AR-9', severity: 'minor' });
  });

  it('falls back to the section severity when the declared one is unrecognized', () => {
    const parsed = parseAdversarialReviewDoc('## Blocking\n\n#### AR-1 — X\n**Severity:** catastrophic\n');
    expect(parsed.blocking[0].severity).toBe('blocker');
  });
});

describe('parseAdversarialReviewDoc — sloppy formatting', () => {
  it('normalizes AR ids and tolerates any dash, hash depth, and case', () => {
    const parsed = parseAdversarialReviewDoc(
      ['## BLOCKING', '', '##### ar 12 – lowercase and en dash', '**severity:** MAJOR'].join('\n'),
    );
    expect(parsed.blocking[0].id).toBe('AR-12');
    expect(parsed.blocking[0].title).toBe('lowercase and en dash');
    expect(parsed.blocking[0].severity).toBe('major');
  });

  it('reads several fields packed onto one line', () => {
    const parsed = parseAdversarialReviewDoc(
      '## Findings\n\n#### AR-2 — Packed\n**Severity:** minor **Area:** spec **Fix:** rewrite it\n',
    );
    expect(parsed.findings[0]).toMatchObject({ severity: 'minor', area: 'spec', fix: 'rewrite it' });
  });

  it('matches a field key on its first word, so `Fix (proposed):` still lands on fix', () => {
    const parsed = parseAdversarialReviewDoc(
      '## Findings\n\n#### AR-3 — Loose keys\n**Why it matters:** because\n**Fix (proposed):** do the thing\n',
    );
    expect(parsed.findings[0].why).toBe('because');
    expect(parsed.findings[0].fix).toBe('do the thing');
  });

  it('titles a title-less entry with its own id rather than leaving it blank', () => {
    const parsed = parseAdversarialReviewDoc('## Blocking\n\n#### AR-5\n');
    expect(parsed.blocking[0].title).toBe('AR-5');
  });

  it('leaves the current bucket alone across an unrelated heading', () => {
    const parsed = parseAdversarialReviewDoc(
      ['## Blocking', '', '#### AR-1 — First', '', '### Notes', '', '#### AR-2 — Second'].join('\n'),
    );
    expect(parsed.blocking.map((f) => f.id)).toEqual(['AR-1', 'AR-2']);
    expect(parsed.findings).toEqual([]);
  });
});

describe('parseAdversarialReviewDoc — the `Prior entries` carry-forward ledger', () => {
  const LEDGER = [
    '- AR-1 (blocker) — resolved — the failure screen is in the prototype now',
    '- AR-2 (major) — unresolved — the criterion still says nothing about reachability',
    '- AR-3 (minor) — resolved-with-regression (see AR-6) — the queue is gone, the retry is not',
    '- AR-4 (advisory) — set-aside — steering excluded it this lap',
    '- AR-5 — withdrawn',
  ].join('\n');

  it('reads a ledger under the PROMOTED `## Prior entries` heading', () => {
    const parsed = parseAdversarialReviewDoc(`## Blocking\n\nNone.\n\n## Findings\n\nNone.\n\n## Prior entries\n\n${LEDGER}\n`);
    expect(parsed.prior).toEqual([
      {
        id: 'AR-1',
        previousSeverity: 'blocker',
        status: 'resolved',
        note: 'the failure screen is in the prototype now',
      },
      {
        id: 'AR-2',
        previousSeverity: 'major',
        status: 'unresolved',
        note: 'the criterion still says nothing about reachability',
      },
      {
        id: 'AR-3',
        previousSeverity: 'minor',
        status: 'resolved-with-regression',
        ref: 'AR-6',
        note: 'the queue is gone, the retry is not',
      },
      {
        id: 'AR-4',
        previousSeverity: 'advisory',
        status: 'set-aside',
        note: 'steering excluded it this lap',
      },
      { id: 'AR-5', status: 'withdrawn' },
    ]);
  });

  it('reads the SAME ledger under the subagent\'s nested `### Prior entries` heading', () => {
    const promoted = parseAdversarialReviewDoc(`## Prior entries\n\n${LEDGER}\n`);
    const nested = parseAdversarialReviewDoc(`## Result\n\n### Prior entries\n\n${LEDGER}\n`);
    expect(nested.prior).toEqual(promoted.prior);
  });

  it('yields an empty ledger for a first review and for an old two-section document', () => {
    expect(parseAdversarialReviewDoc('## Prior entries\n\nNone.\n').prior).toEqual([]);
    expect(parseAdversarialReviewDoc(CANONICAL).prior).toEqual([]);
  });

  it('DROPS a line whose status word is not one of the five rather than guessing one', () => {
    const parsed = parseAdversarialReviewDoc(
      ['## Prior entries', '', '- AR-1 (blocker) — mostly fixed — close enough', '- AR-2 (minor) — resolved'].join('\n'),
    );
    expect(parsed.prior).toEqual([{ id: 'AR-2', previousSeverity: 'minor', status: 'resolved' }]);
  });

  it('ignores a ledger that is only an EXAMPLE inside a fenced block', () => {
    const parsed = parseAdversarialReviewDoc(
      [
        '## Prior entries',
        '',
        '```',
        '- AR-n (blocker|major|minor|advisory) — resolved | unresolved — <one line>',
        '```',
        '',
        '- AR-1 (blocker) — resolved',
      ].join('\n'),
    );
    expect(parsed.prior).toEqual([{ id: 'AR-1', previousSeverity: 'blocker', status: 'resolved' }]);
  });

  it('ignores a whole `## Prior entries` section written inside a fence', () => {
    const parsed = parseAdversarialReviewDoc(
      ['## Blocking', '', '#### AR-1 — Real', '', '```', '## Prior entries', '- AR-9 — resolved', '```'].join('\n'),
    );
    expect(parsed.prior).toEqual([]);
    expect(parsed.blocking.map((f) => f.id)).toEqual(['AR-1']);
  });

  it('tolerates a hyphen separator, a missing severity, and a missing note', () => {
    const parsed = parseAdversarialReviewDoc(
      ['## Prior entries', '', '- AR-7 - unresolved - still open', '* ar 8 — resolved'].join('\n'),
    );
    expect(parsed.prior).toEqual([
      { id: 'AR-7', status: 'unresolved', note: 'still open' },
      { id: 'AR-8', status: 'resolved' },
    ]);
  });

  it('never lets the ledger leak into blocking/findings, even when it uses `#### AR-n` headings', () => {
    const parsed = parseAdversarialReviewDoc(
      [
        '## Blocking',
        '',
        '#### AR-2 — Still broken',
        '**Severity:** blocker',
        '',
        '## Prior entries',
        '',
        '#### AR-1 — Resolved last round',
        '**Severity:** blocker',
        '',
        '- AR-1 (blocker) — resolved',
      ].join('\n'),
    );
    expect(parsed.blocking.map((f) => f.id)).toEqual(['AR-2']);
    expect(parsed.findings).toEqual([]);
    expect(parsed.prior).toEqual([{ id: 'AR-1', previousSeverity: 'blocker', status: 'resolved' }]);
  });
});

describe('maxAdversarialId', () => {
  it('returns 0 for a document with no AR ids, and for null / empty input', () => {
    for (const input of [null, undefined, '', '## Blocking\n\nNone.\n']) {
      expect(maxAdversarialId(input)).toBe(0);
    }
  });

  it('returns the highest id anywhere in the doc, ledger and prose included', () => {
    expect(maxAdversarialId(CANONICAL)).toBe(4);
    expect(
      maxAdversarialId('## Blocking\n\n#### AR-2 — X\n\n## Prior entries\n\n- AR-11 (minor) — resolved\n'),
    ).toBe(11);
    // Sloppy spellings count too — they are the same spent id.
    expect(maxAdversarialId('see ar 12 and AR-3')).toBe(12);
  });

  it('ignores the `ar` inside ordinary prose words followed by a number', () => {
    // A review doc is prose-heavy; without a leading word boundary the `ar` in
    // `year` / `linear` / `similar` matches and inflates the spent-id range the
    // re-review prompt quotes back to the reviewer.
    const prose = [
      '## Blocking',
      '',
      'None.',
      '',
      '## Findings',
      '',
      '**Why it matters:** in year 2026 the queue overflows.',
      'It is a linear 4-step flow, and similar 3 screens appear near 5 places.',
    ].join('\n');
    expect(maxAdversarialId(prose)).toBe(0);
    expect(maxAdversarialId(`${prose}\n\n#### AR-2 — X\n`)).toBe(2);
  });
});

describe('adversarialSeverityToReviewSeverity', () => {
  it('maps blocker/major to error, minor to warning, advisory to info', () => {
    expect(adversarialSeverityToReviewSeverity('blocker')).toBe('error');
    expect(adversarialSeverityToReviewSeverity('major')).toBe('error');
    expect(adversarialSeverityToReviewSeverity('minor')).toBe('warning');
    expect(adversarialSeverityToReviewSeverity('advisory')).toBe('info');
  });

  it('is total over the severity union', () => {
    for (const s of ADVERSARIAL_SEVERITIES) {
      expect(['error', 'warning', 'info']).toContain(adversarialSeverityToReviewSeverity(s));
    }
  });
});
