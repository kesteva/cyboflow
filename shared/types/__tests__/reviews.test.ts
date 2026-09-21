/**
 * The gate-resolution grammar — `<verdict>[<modifier>]: <note>`.
 *
 * WHY IT EXISTS. Every verdict reader used to sniff the WHOLE resolution for the
 * substring 'reject', so a human note like "revise: the architecture rejects
 * empty input" read as a REJECT and ended the run instead of looping the design
 * steps back. The verdict is now an anchored prefix and the note is free text;
 * these tests pin both halves of the round-trip plus the `null` that keeps every
 * legacy row (and the serialized verdict maps) on its existing reader.
 */
import { describe, it, expect } from 'vitest';
import {
  composeGateResolution,
  parseGateResolution,
  serializeIdeaVerdictMap,
  serializeDesignVerdictMap,
  acceptedResolution,
  GATE_RESOLUTION_MODIFIER_NO_FINDINGS,
  RESOLUTION_PREFIX_PROMOTED,
  SUPERVISOR_RECOMMENDATION_HEADING,
  upsertMarkdownSection,
  readMarkdownSection,
  stripMarkdownSection,
  parseSupervisorRecommendation,
  composeSupervisorRecommendation,
} from '../reviews';

describe('composeGateResolution', () => {
  it('emits all four shapes', () => {
    expect(composeGateResolution({ verdict: 'approve' })).toBe('approve');
    expect(
      composeGateResolution({ verdict: 'approve', modifier: GATE_RESOLUTION_MODIFIER_NO_FINDINGS }),
    ).toBe('approve[no-findings]');
    expect(composeGateResolution({ verdict: 'revise', note: 'only AR-2 matters' })).toBe(
      'revise: only AR-2 matters',
    );
    expect(
      composeGateResolution({ verdict: 'approve', modifier: 'no-findings', note: 'ship it' }),
    ).toBe('approve[no-findings]: ship it');
  });

  it('drops a blank note/modifier so a bare outcome stores the bare verdict word', () => {
    // The pre-grammar behaviour every non-note resolve must keep byte-for-byte.
    expect(composeGateResolution({ verdict: 'reject', note: '   ' })).toBe('reject');
    expect(composeGateResolution({ verdict: 'reject', note: undefined })).toBe('reject');
    expect(composeGateResolution({ verdict: 'revise', modifier: '  ', note: 'x' })).toBe('revise: x');
  });

  it('trims the note it stores', () => {
    expect(composeGateResolution({ verdict: 'revise', note: '  drop AR-11  ' })).toBe(
      'revise: drop AR-11',
    );
  });
});

describe('parseGateResolution', () => {
  it('round-trips all four shapes', () => {
    for (const p of [
      { verdict: 'approve' as const },
      { verdict: 'reject' as const, modifier: 'no-findings' },
      { verdict: 'revise' as const, note: 'only AR-2 matters, drop AR-11' },
      { verdict: 'approve' as const, modifier: 'no-findings', note: 'ship it' },
    ]) {
      expect(parseGateResolution(composeGateResolution(p))).toEqual(p);
    }
  });

  it('omits modifier/note rather than returning empty strings', () => {
    expect(parseGateResolution('approve')).toEqual({ verdict: 'approve' });
    expect(parseGateResolution('revise:')).toEqual({ verdict: 'revise' });
    expect(parseGateResolution('revise:    ')).toEqual({ verdict: 'revise' });
  });

  it('normalizes the verdict to lower case and trims the input', () => {
    expect(parseGateResolution('Approve')).toEqual({ verdict: 'approve' });
    expect(parseGateResolution('  REVISE: fix it  ')).toEqual({ verdict: 'revise', note: 'fix it' });
  });

  it('keeps a note that contains colons, newlines and verdict words', () => {
    // The whole point: 'rejects' inside the note must not become the verdict.
    expect(parseGateResolution('revise: the architecture rejects empty input')).toEqual({
      verdict: 'revise',
      note: 'the architecture rejects empty input',
    });
    expect(parseGateResolution('revise: a: b\nsecond line')).toEqual({
      verdict: 'revise',
      note: 'a: b\nsecond line',
    });
  });

  it('returns null for legacy free text and every other prefix convention', () => {
    expect(parseGateResolution('please revise this')).toBeNull();
    expect(parseGateResolution('approved')).toBeNull();
    expect(parseGateResolution('reject — out of scope')).toBeNull();
    expect(parseGateResolution('retry')).toBeNull();
    expect(parseGateResolution('')).toBeNull();
    expect(parseGateResolution(null)).toBeNull();
    expect(parseGateResolution(undefined)).toBeNull();
    expect(parseGateResolution(`${RESOLUTION_PREFIX_PROMOTED}tsk_1`)).toBeNull();
    expect(parseGateResolution(acceptedResolution('docs'))).toBeNull();
    expect(parseGateResolution(serializeIdeaVerdictMap({ 'IDEA-001': 'deny' }))).toBeNull();
    expect(parseGateResolution(serializeDesignVerdictMap({ 'IDEA-001': 'approve' }))).toBeNull();
  });

  it('accepts an unknown modifier without throwing (the handler is what refuses one)', () => {
    expect(parseGateResolution('approve[some-future-flag]')).toEqual({
      verdict: 'approve',
      modifier: 'some-future-flag',
    });
  });

  it('normalizes an upper-case modifier to lower case', () => {
    expect(parseGateResolution('approve[NO-FINDINGS]: keep it')).toEqual({
      verdict: 'approve',
      modifier: 'no-findings',
      note: 'keep it',
    });
  });
});

// ---------------------------------------------------------------------------
// Supervisor recommendation — markdown section upsert/read + the parser
//
// WHY: the recommendation lives INSIDE the item body (no column, no migration),
// so the section boundary rules ARE the data model. These pin the three ways a
// naive implementation corrupts a body: appending a second copy instead of
// replacing, swallowing the following section, and treating a `##` heading that
// is merely QUOTED inside a fenced code block as a real one.
// ---------------------------------------------------------------------------

describe('upsertMarkdownSection', () => {
  const H = SUPERVISOR_RECOMMENDATION_HEADING;

  it('appends the section after one blank line when the body has none', () => {
    expect(upsertMarkdownSection('Gate body.', H, 'Recommended: approve — ship it')).toBe(
      'Gate body.\n\n## Supervisor recommendation\n\nRecommended: approve — ship it\n',
    );
  });

  it('creates the section from an empty body without leading blank lines', () => {
    expect(upsertMarkdownSection('', H, 'hello')).toBe('## Supervisor recommendation\n\nhello\n');
  });

  it('always ends with exactly one trailing newline', () => {
    const out = upsertMarkdownSection('Body.\n\n\n', H, 'x\n\n');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('replaces an existing section IN PLACE and keeps the following section', () => {
    const body = ['# Gate', '', '## Supervisor recommendation', '', 'old text', '', '## Findings', '', 'AR-1'].join('\n');
    expect(upsertMarkdownSection(body, H, 'new text')).toBe(
      ['# Gate', '', '## Supervisor recommendation', '', 'new text', '', '## Findings', '', 'AR-1', ''].join('\n'),
    );
  });

  it('removes duplicate sections, keeping the first position', () => {
    const body = [
      '## Supervisor recommendation',
      '',
      'first',
      '',
      '## Other',
      '',
      'keep me',
      '',
      '## Supervisor recommendation',
      '',
      'second',
    ].join('\n');
    const out = upsertMarkdownSection(body, H, 'only');
    expect(out.match(/## Supervisor recommendation/g)).toHaveLength(1);
    expect(out).toContain('only');
    expect(out).toContain('keep me');
    expect(out).not.toContain('second');
  });

  it('ignores a heading that only appears inside a fenced code block', () => {
    const body = ['Template:', '', '```md', '## Supervisor recommendation', '', 'example', '```'].join('\n');
    const out = upsertMarkdownSection(body, H, 'real');
    // The fenced example is untouched and the real section is APPENDED.
    expect(out.match(/## Supervisor recommendation/g)).toHaveLength(2);
    expect(out).toContain('example');
    expect(out.indexOf('real')).toBeGreaterThan(out.indexOf('example'));
  });

  it('ends the section at the next H1 as well as the next H2', () => {
    const body = ['## Supervisor recommendation', '', 'old', '', '# Appendix', '', 'tail'].join('\n');
    const out = upsertMarkdownSection(body, H, 'new');
    expect(out).toContain('# Appendix');
    expect(out).toContain('tail');
    expect(out).not.toContain('old');
  });

  it('matches the heading case-insensitively and tolerates trailing whitespace', () => {
    const body = '## supervisor RECOMMENDATION   \n\nold\n';
    expect(upsertMarkdownSection(body, H, 'new')).toBe('## Supervisor recommendation\n\nnew\n');
  });
});

describe('readMarkdownSection', () => {
  const H = SUPERVISOR_RECOMMENDATION_HEADING;

  it('returns the section body without its heading', () => {
    const body = '# Gate\n\n## Supervisor recommendation\n\nline one\nline two\n\n## Next\n\nother\n';
    expect(readMarkdownSection(body, H)).toBe('line one\nline two');
  });

  it('returns null when the section is absent, the body is empty, or nullish', () => {
    expect(readMarkdownSection('## Other\n\nx', H)).toBeNull();
    expect(readMarkdownSection('', H)).toBeNull();
    expect(readMarkdownSection(null, H)).toBeNull();
    expect(readMarkdownSection(undefined, H)).toBeNull();
  });

  it('does not see a heading that is only quoted inside a fence', () => {
    expect(readMarkdownSection('```\n## Supervisor recommendation\n\nfake\n```\n', H)).toBeNull();
  });

  it('round-trips with upsertMarkdownSection', () => {
    const out = upsertMarkdownSection('Body.', H, 'Recommended: revise — tighten AR-2');
    expect(readMarkdownSection(out, H)).toBe('Recommended: revise — tighten AR-2');
  });
});

describe('stripMarkdownSection', () => {
  const H = SUPERVISOR_RECOMMENDATION_HEADING;

  it('removes the section and leaves the rest byte-identical', () => {
    const body = '# Gate\n\nintro\n\n## Supervisor recommendation\n\nplanted\n\n## Findings\n\nAR-1\n';
    expect(stripMarkdownSection(body, H)).toBe('# Gate\n\nintro\n\n## Findings\n\nAR-1\n');
  });

  it('normalizes trailing whitespace to exactly one newline when it strips', () => {
    const out = stripMarkdownSection('Body.\n\n## Supervisor recommendation\n\nplanted\n\n\n', H);
    expect(out).toBe('Body.\n');
  });

  it('returns the empty string when the section was the whole body', () => {
    expect(stripMarkdownSection('## Supervisor recommendation\n\nplanted\n', H)).toBe('');
  });

  it('does not see a heading that only appears inside a fenced code block', () => {
    const body = ['Template:', '', '```md', '## Supervisor recommendation', '', 'example', '```'].join('\n');
    expect(stripMarkdownSection(body, H)).toBe(body);
  });

  it('returns the SAME string when there is no such section', () => {
    const body = 'Body.\n\n## Findings\n\nAR-1\n\n\n';
    // Same string, not a re-normalized copy: the common create path is untouched.
    expect(stripMarkdownSection(body, H)).toBe(body);
    expect(stripMarkdownSection('', H)).toBe('');
  });

  it('removes EVERY copy of the section, not just the first', () => {
    const body = [
      '## Supervisor recommendation',
      '',
      'first',
      '',
      '## Other',
      '',
      'keep me',
      '',
      '## Supervisor recommendation',
      '',
      'second',
    ].join('\n');
    const out = stripMarkdownSection(body, H);
    expect(out).toBe('## Other\n\nkeep me\n');
    expect(parseSupervisorRecommendation(out)).toBeNull();
  });

  it('undoes an upsert', () => {
    const base = 'Gate body.\n';
    const withSection = upsertMarkdownSection(base, H, 'Recommended: approve — ship it');
    expect(stripMarkdownSection(withSection, H)).toBe(base);
  });
});

describe('parseSupervisorRecommendation', () => {
  const wrap = (md: string): string => upsertMarkdownSection('Gate body.', SUPERVISOR_RECOMMENDATION_HEADING, md);

  it.each([
    ['approve', 'approve'],
    ['reject', 'reject'],
    ['continue', 'continue'],
    ['rerun', 'rerun'],
    ['dismiss', 'dismiss'],
  ])('parses choice %s', (choice, expected) => {
    expect(parseSupervisorRecommendation(wrap(`Recommended: ${choice} — because`))).toEqual({
      choice: expected,
      sentence: 'because',
    });
  });

  it('accepts a hyphen or a colon separator and an upper-case choice', () => {
    expect(parseSupervisorRecommendation(wrap('Recommended: Approve - because'))?.choice).toBe('approve');
    expect(parseSupervisorRecommendation(wrap('Recommended: RERUN: because'))?.choice).toBe('rerun');
  });

  it('reads past blank lines to the first non-blank line and keeps the rationale out', () => {
    const body = wrap('Recommended: approve — one sentence\n\nA longer rationale that must not leak into `sentence`.');
    expect(parseSupervisorRecommendation(body)).toEqual({ choice: 'approve', sentence: 'one sentence' });
  });

  it('IGNORES a Recommended: line outside the section', () => {
    const body = 'Recommended: reject — a reviewer quoting itself\n\n## Findings\n\nAR-1\n';
    expect(parseSupervisorRecommendation(body)).toBeNull();
  });

  it('returns null for a malformed section, an unknown choice, or an empty sentence', () => {
    expect(parseSupervisorRecommendation(wrap('just prose'))).toBeNull();
    expect(parseSupervisorRecommendation(wrap('Recommended: maybe — hedging'))).toBeNull();
    // CX-3: `revise` is no longer a recommendation choice — a body still
    // carrying one (written before it was retired) parses as nothing, so the
    // card renders no chip rather than emphasizing Reject.
    expect(parseSupervisorRecommendation(wrap('Recommended: revise — x'))).toBeNull();
    expect(parseSupervisorRecommendation(wrap('Recommended: approve —'))).toBeNull();
    expect(parseSupervisorRecommendation(null)).toBeNull();
  });

  it('requires the Recommended: line to LEAD the section', () => {
    expect(parseSupervisorRecommendation(wrap('Preamble.\n\nRecommended: approve — late'))).toBeNull();
  });
});

describe('composeSupervisorRecommendation', () => {
  it('composes the machine-readable line, with the rationale after one blank line', () => {
    expect(composeSupervisorRecommendation('rerun', 'the review still blocks')).toBe(
      'Recommended: rerun — the review still blocks',
    );
    expect(composeSupervisorRecommendation('dismiss', 'nothing worth logging', 'AR-1 and AR-2 are stylistic.')).toBe(
      'Recommended: dismiss — nothing worth logging\n\nAR-1 and AR-2 are stylistic.',
    );
  });

  it('round-trips through the parser', () => {
    const md = composeSupervisorRecommendation('reject', 'AR-2 is real', 'Rationale.');
    const body = upsertMarkdownSection('Gate body.', SUPERVISOR_RECOMMENDATION_HEADING, md);
    expect(parseSupervisorRecommendation(body)).toEqual({ choice: 'reject', sentence: 'AR-2 is real' });
  });
});
