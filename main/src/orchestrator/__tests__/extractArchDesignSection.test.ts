/**
 * extractArchDesignSection — the SHARED '## Architecture design' section
 * extractor (shared/types/artifacts.ts). Backend content gate and frontend
 * renderer both call this one function, so its edge behavior is pinned here:
 * heading present/absent, case-insensitivity, section-until-next-H2, heading
 * at EOF, CRLF bodies, empty sections, and null/empty inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  extractArchDesignSection,
  replaceArchDesignSection,
  ARCH_DESIGN_SECTION_HEADING,
} from '../../../../shared/types/artifacts';

const HEADING = `## ${ARCH_DESIGN_SECTION_HEADING}`;

describe('extractArchDesignSection', () => {
  it('exports the canonical heading text', () => {
    expect(ARCH_DESIGN_SECTION_HEADING).toBe('Architecture design');
  });

  it('extracts the section when the heading is present', () => {
    const body = '# Idea\n\nIntro.\n\n## Architecture design\n\nUse a queue.\n\n- item one\n';
    expect(extractArchDesignSection(body)).toBe('Use a queue.\n\n- item one');
  });

  it('returns null when the heading is absent', () => {
    expect(extractArchDesignSection('# Idea\n\n## Problem\n\nStuff.')).toBeNull();
  });

  it('returns null for null / undefined / empty bodies', () => {
    expect(extractArchDesignSection(null)).toBeNull();
    expect(extractArchDesignSection(undefined)).toBeNull();
    expect(extractArchDesignSection('')).toBeNull();
  });

  it('matches the heading case-insensitively', () => {
    expect(extractArchDesignSection('## ARCHITECTURE DESIGN\ncontent')).toBe('content');
    expect(extractArchDesignSection('## architecture design\ncontent')).toBe('content');
  });

  it('captures only until the next H2', () => {
    const body = '## Architecture design\n\nDesign body.\n\n## Rollout\n\nNot design.';
    expect(extractArchDesignSection(body)).toBe('Design body.');
  });

  it('does NOT end the section at an H3 (### is not a "## " line)', () => {
    const body = '## Architecture design\n\nTop.\n\n### Components\n\nDetail.\n\n## Next\n\nx';
    expect(extractArchDesignSection(body)).toBe('Top.\n\n### Components\n\nDetail.');
  });

  it('captures to EOF when the heading section is last', () => {
    const body = '# Idea\n\n## Architecture design\n\nFinal section.';
    expect(extractArchDesignSection(body)).toBe('Final section.');
  });

  it('returns null when the heading is at EOF with no content', () => {
    expect(extractArchDesignSection('# Idea\n\n## Architecture design')).toBeNull();
    expect(extractArchDesignSection('# Idea\n\n## Architecture design\n\n')).toBeNull();
  });

  it('returns null when the section is empty (next H2 immediately follows)', () => {
    expect(
      extractArchDesignSection('## Architecture design\n\n## Rollout\n\ncontent'),
    ).toBeNull();
  });

  it('handles CRLF bodies (heading line ends \\r\\n; section trimmed)', () => {
    const body = '# Idea\r\n\r\n## Architecture design\r\n\r\nCRLF content.\r\n\r\n## Next\r\nx';
    expect(extractArchDesignSection(body)).toBe('CRLF content.');
  });

  it('tolerates extra whitespace between ## and the heading text', () => {
    expect(extractArchDesignSection('##   Architecture design\ncontent')).toBe('content');
  });

  it('does NOT match the heading text inline (must be its own line)', () => {
    expect(extractArchDesignSection('We discuss the ## Architecture design here.')).toBeNull();
    expect(extractArchDesignSection('## Architecture design notes\ncontent')).toBeNull();
  });

  it('does NOT terminate the section at "## " lines inside a fenced code block', () => {
    const body =
      '## Architecture design\n\nbefore\n\n```md\n## inside fence\n```\n\nafter\n\n## Next\n\nx';
    expect(extractArchDesignSection(body)).toBe('before\n\n```md\n## inside fence\n```\n\nafter');
  });

  it('does NOT match a heading line inside a fenced code block', () => {
    const body = '```\n## Architecture design\nfenced\n```\n\n## Problem\n\nStuff.';
    expect(extractArchDesignSection(body)).toBeNull();
  });

  it('tolerates ~~~ fences and up to 3 leading spaces on the fence line', () => {
    const body =
      '## Architecture design\n\nkeep\n\n   ~~~yaml\n## not a heading\n   ~~~\n\ntail\n\n## Next\nx';
    expect(extractArchDesignSection(body)).toBe('keep\n\n   ~~~yaml\n## not a heading\n   ~~~\n\ntail');
  });

  it('is NOT spoofed by a bare "##" line followed by the heading text on the next line', () => {
    const body = '##\nArchitecture design\nnot a real section\n';
    expect(extractArchDesignSection(body)).toBeNull();
  });

  it('terminates the section at a bare "##" line (empty ATX heading)', () => {
    const body = '## Architecture design\n\ncontent\n\n##\n\nnot design';
    expect(extractArchDesignSection(body)).toBe('content');
  });

  it('returns the LAST section when the heading appears more than once (revise re-fold)', () => {
    const body =
      '## Architecture design\n\nstale v1\n\n## Risks\n\nr\n\n## Architecture design\n\nfresh v2\n';
    expect(extractArchDesignSection(body)).toBe('fresh v2');
  });
});

describe('replaceArchDesignSection', () => {
  it('swaps a mid-body section, preserving surrounding bytes and the following H2', () => {
    const body = '# Idea\n\nIntro.\n\n## Architecture design\n\nold design.\n\n## Rollout\n\nship it.';
    const out = replaceArchDesignSection(body, `${HEADING}\n\nnew design.`);
    expect(out).toBe('# Idea\n\nIntro.\n\n## Architecture design\n\nnew design.\n\n## Rollout\n\nship it.');
    expect(extractArchDesignSection(out)).toBe('new design.');
  });

  it('swaps a section that runs to EOF (no following H2)', () => {
    const body = '# Idea\n\n## Architecture design\n\noriginal.';
    const out = replaceArchDesignSection(body, `${HEADING}\n\nreplacement.`);
    expect(out).toBe('# Idea\n\n## Architecture design\n\nreplacement.');
    expect(extractArchDesignSection(out)).toBe('replacement.');
  });

  it('appends a new section (heading-led) when the body has none, after a blank line', () => {
    const body = '# Idea\n\nIntro with no arch section.';
    const out = replaceArchDesignSection(body, `${HEADING}\n\nfresh.`);
    expect(out).toBe('# Idea\n\nIntro with no arch section.\n\n## Architecture design\n\nfresh.');
    expect(extractArchDesignSection(out)).toBe('fresh.');
  });

  it('append keeps exactly one blank line when the body already ends with a newline', () => {
    expect(replaceArchDesignSection('body\n', `${HEADING}\ns`)).toBe(`body\n\n${HEADING}\ns`);
    expect(replaceArchDesignSection('body\n\n', `${HEADING}\ns`)).toBe(`body\n\n${HEADING}\ns`);
    expect(replaceArchDesignSection('', `${HEADING}\ns`)).toBe(`${HEADING}\ns`);
  });

  it('replaces the LAST heading when the body carries more than one (last wins, matching extract)', () => {
    const body = `${HEADING}\n\nstale.\n\n## Risks\n\nr\n\n${HEADING}\n\nfresh.`;
    const out = replaceArchDesignSection(body, `${HEADING}\n\nrevised.`);
    // The earlier (stale) heading + its section are preserved byte-for-byte; only the
    // last section is swapped — extract likewise reads the last one.
    expect(out).toBe(`${HEADING}\n\nstale.\n\n## Risks\n\nr\n\n${HEADING}\n\nrevised.`);
    expect(extractArchDesignSection(out)).toBe('revised.');
  });

  it('does not treat a heading-looking line inside a fence as the section (fence-aware)', () => {
    const body = '## Architecture design\n\nreal.\n\n```md\n## Architecture design\nfenced\n```\n\ntail.';
    const out = replaceArchDesignSection(body, `${HEADING}\n\nswapped.`);
    // The whole real section (through EOF; the fenced copy neither starts nor ends it)
    // is replaced; the fenced text was part of that section, so it is swapped out too.
    expect(out).toBe(`${HEADING}\n\nswapped.`);
    expect(extractArchDesignSection(out)).toBe('swapped.');
  });

  it('preserves CRLF bytes outside the swapped section', () => {
    const body = '# Idea\r\n\r\n## Architecture design\r\n\r\nold.\r\n\r\n## Next\r\nx';
    const out = replaceArchDesignSection(body, `${HEADING}\n\nnew.`);
    expect(out).toBe('# Idea\r\n\r\n## Architecture design\n\nnew.\r\n\r\n## Next\r\nx');
    expect(extractArchDesignSection(out)).toBe('new.');
  });

  it('round-trips: extract(replace(body, s)) === extract(s) for a heading-led section', () => {
    const s = `${HEADING}\n\nComponents:\n\n- one\n- two\n`;
    for (const body of [
      '',
      '# Idea\n\nno section',
      `# Idea\n\n${HEADING}\n\nprior\n\n## After\n\nz`,
    ]) {
      expect(extractArchDesignSection(replaceArchDesignSection(body, s))).toBe(
        extractArchDesignSection(s),
      );
    }
  });

  // Fence pairing (makeFenceState): a fence closes only on a MATCHING marker —
  // same char, run ≥ opener. The naive toggle this replaced treated any ```/~~~
  // line as a close, so a ~~~ inside a ``` fence flipped the state and let the
  // fenced '## ' lines below it terminate (or spoof) sections.
  it('a ~~~ line inside a ``` fence is content — fenced H2s stay fenced past it', () => {
    const body = [
      `${HEADING}`,
      '',
      'intro.',
      '```md',
      '~~~',
      '## fenced heading (still inside the ``` fence)',
      '```',
      '',
      'outro.',
      '',
      '## After',
      'z',
    ].join('\n');
    // The fenced '## ...' must NOT terminate the section; '## After' does.
    expect(extractArchDesignSection(body)).toBe(
      'intro.\n```md\n~~~\n## fenced heading (still inside the ``` fence)\n```\n\noutro.',
    );
  });

  it('a shorter closing run does not close a longer opener (````md needs ≥ 4 backticks)', () => {
    const body = [
      `${HEADING}`,
      '',
      '````md',
      '```',
      '## still fenced',
      '````',
      '',
      '## After',
      'z',
    ].join('\n');
    expect(extractArchDesignSection(body)).toBe('````md\n```\n## still fenced\n````');
  });
});
