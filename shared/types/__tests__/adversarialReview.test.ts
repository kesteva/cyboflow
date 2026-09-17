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
    expect(parsed).toEqual({ blocking: [], findings: [] });
  });

  it('returns empty arrays for null / empty / heading-less input', () => {
    for (const input of [null, undefined, '', 'Just some prose with no headings at all.']) {
      expect(parseAdversarialReviewDoc(input)).toEqual({ blocking: [], findings: [] });
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
