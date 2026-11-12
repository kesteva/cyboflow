/**
 * extractDesignSpecSection / replaceDesignSpecSection — the '## Design spec'
 * sibling of extractArchDesignSection / replaceArchDesignSection (Design Mode
 * v0 Approve fold, docs/ideas/design-mode.md "Approve" Step 2). Both pairs are
 * thin wrappers around the generalized `extractSection`/`replaceSection`
 * engine in shared/types/artifacts.ts, so this file focuses on: the
 * design-spec wrapper's own round-trip behavior (append / in-place replace),
 * that an idea body carrying BOTH an arch-design and a design-spec section
 * lets each replacer touch only its own section, and that a fenced code block
 * containing a fake '## Design spec' line is not mistaken for the heading.
 * extractArchDesignSection/replaceArchDesignSection edge-case coverage
 * (fences, CRLF, last-heading-wins, etc.) stays pinned in
 * extractArchDesignSection.test.ts — unchanged by the generalization.
 */
import { describe, it, expect } from 'vitest';
import {
  extractSection,
  replaceSection,
  extractDesignSpecSection,
  replaceDesignSpecSection,
  DESIGN_SPEC_SECTION_HEADING,
  extractArchDesignSection,
  replaceArchDesignSection,
} from '../../../../shared/types/artifacts';

const DESIGN_HEADING = `## ${DESIGN_SPEC_SECTION_HEADING}`;
const ARCH_HEADING = '## Architecture design';

describe('extractDesignSpecSection', () => {
  it('exports the canonical heading text', () => {
    expect(DESIGN_SPEC_SECTION_HEADING).toBe('Design spec');
  });

  it('extracts the section when the heading is present', () => {
    const body = '# Idea\n\nIntro.\n\n## Design spec\n\nUse a modal.\n\n- item one\n';
    expect(extractDesignSpecSection(body)).toBe('Use a modal.\n\n- item one');
  });

  it('returns null when the heading is absent', () => {
    expect(extractDesignSpecSection('# Idea\n\n## Problem\n\nStuff.')).toBeNull();
  });

  it('returns null for null / undefined / empty bodies', () => {
    expect(extractDesignSpecSection(null)).toBeNull();
    expect(extractDesignSpecSection(undefined)).toBeNull();
    expect(extractDesignSpecSection('')).toBeNull();
  });

  it('matches the heading case-insensitively', () => {
    expect(extractDesignSpecSection('## DESIGN SPEC\ncontent')).toBe('content');
    expect(extractDesignSpecSection('## design spec\ncontent')).toBe('content');
  });

  it('captures only until the next H2', () => {
    const body = '## Design spec\n\nSpec body.\n\n## Rollout\n\nNot spec.';
    expect(extractDesignSpecSection(body)).toBe('Spec body.');
  });

  it('does NOT treat a "## Design spec" line inside a fenced code block as the heading', () => {
    const body = '```md\n## Design spec\nfenced, not real\n```\n\n## Problem\n\nStuff.';
    expect(extractDesignSpecSection(body)).toBeNull();
  });

  it('does NOT terminate a real section at a fenced fake heading of the same text', () => {
    const body =
      '## Design spec\n\nreal intro.\n\n```md\n## Design spec\nfenced fake\n```\n\nreal outro.\n\n## Next\n\nx';
    expect(extractDesignSpecSection(body)).toBe(
      'real intro.\n\n```md\n## Design spec\nfenced fake\n```\n\nreal outro.',
    );
  });
});

describe('replaceDesignSpecSection', () => {
  it('appends a new section (heading-led) when the body has none, after a blank line', () => {
    const body = '# Idea\n\nIntro with no design-spec section.';
    const out = replaceDesignSpecSection(body, `${DESIGN_HEADING}\n\nfresh.`);
    expect(out).toBe('# Idea\n\nIntro with no design-spec section.\n\n## Design spec\n\nfresh.');
    expect(extractDesignSpecSection(out)).toBe('fresh.');
  });

  it('replaces an existing section in place, preserving surrounding bytes', () => {
    const body = '# Idea\n\nIntro.\n\n## Design spec\n\nold spec.\n\n## Rollout\n\nship it.';
    const out = replaceDesignSpecSection(body, `${DESIGN_HEADING}\n\nnew spec.`);
    expect(out).toBe('# Idea\n\nIntro.\n\n## Design spec\n\nnew spec.\n\n## Rollout\n\nship it.');
    expect(extractDesignSpecSection(out)).toBe('new spec.');
  });

  it('round-trips: extract(replace(body, s)) === extract(s) for a heading-led section', () => {
    const s = `${DESIGN_HEADING}\n\nComponents:\n\n- one\n- two\n`;
    for (const body of [
      '',
      '# Idea\n\nno section',
      `# Idea\n\n${DESIGN_HEADING}\n\nprior\n\n## After\n\nz`,
    ]) {
      expect(extractDesignSpecSection(replaceDesignSpecSection(body, s))).toBe(
        extractDesignSpecSection(s),
      );
    }
  });

  describe('coexisting with an Architecture design section', () => {
    // A body carrying BOTH sections: each replacer must touch only its own
    // section (H2_LINE_RE terminates each scan at the other's heading), so
    // replacing one never disturbs the other's bytes.
    const body = [
      '# Idea',
      '',
      ARCH_HEADING,
      '',
      'old architecture.',
      '',
      DESIGN_HEADING,
      '',
      'old spec.',
      '',
      '## Rollout',
      '',
      'ship it.',
    ].join('\n');

    it('extractDesignSpecSection reads only the design-spec section', () => {
      expect(extractDesignSpecSection(body)).toBe('old spec.');
      expect(extractArchDesignSection(body)).toBe('old architecture.');
    });

    it('replacing the design-spec section leaves the architecture-design section byte-identical', () => {
      const out = replaceDesignSpecSection(body, `${DESIGN_HEADING}\n\nnew spec.`);
      expect(extractArchDesignSection(out)).toBe('old architecture.');
      expect(extractDesignSpecSection(out)).toBe('new spec.');
      expect(out).toBe(
        [
          '# Idea',
          '',
          ARCH_HEADING,
          '',
          'old architecture.',
          '',
          DESIGN_HEADING,
          '',
          'new spec.',
          '',
          '## Rollout',
          '',
          'ship it.',
        ].join('\n'),
      );
    });

    it('replacing the architecture-design section leaves the design-spec section byte-identical', () => {
      const out = replaceArchDesignSection(body, `${ARCH_HEADING}\n\nnew architecture.`);
      expect(extractDesignSpecSection(out)).toBe('old spec.');
      expect(extractArchDesignSection(out)).toBe('new architecture.');
      expect(out).toBe(
        [
          '# Idea',
          '',
          ARCH_HEADING,
          '',
          'new architecture.',
          '',
          DESIGN_HEADING,
          '',
          'old spec.',
          '',
          '## Rollout',
          '',
          'ship it.',
        ].join('\n'),
      );
    });

    it('order reversed (design spec before architecture) — each replacer still stops at the other heading', () => {
      const reversed = [
        '# Idea',
        '',
        DESIGN_HEADING,
        '',
        'old spec.',
        '',
        ARCH_HEADING,
        '',
        'old architecture.',
        '',
        '## Rollout',
        '',
        'ship it.',
      ].join('\n');
      expect(extractDesignSpecSection(reversed)).toBe('old spec.');
      expect(extractArchDesignSection(reversed)).toBe('old architecture.');

      const out = replaceDesignSpecSection(reversed, `${DESIGN_HEADING}\n\nnew spec.`);
      expect(extractArchDesignSection(out)).toBe('old architecture.');
      expect(extractDesignSpecSection(out)).toBe('new spec.');
    });
  });
});

describe('extractSection / replaceSection (the shared generalized engine)', () => {
  // The arch-design and design-spec wrappers are thin delegations to these —
  // exercise the generic entry points directly with an arbitrary heading regex
  // to confirm the engine itself is not hard-coded to either heading text.
  const CUSTOM_HEADING_RE = /^##[ \t]+Custom Section[ \t]*$/i;

  it('extracts and replaces a section under a caller-supplied heading regex', () => {
    const body = '# Doc\n\n## Custom Section\n\noriginal.\n\n## Next\n\nx';
    expect(extractSection(body, CUSTOM_HEADING_RE)).toBe('original.');
    const out = replaceSection(body, CUSTOM_HEADING_RE, '## Custom Section\n\nreplaced.');
    expect(out).toBe('# Doc\n\n## Custom Section\n\nreplaced.\n\n## Next\n\nx');
    expect(extractSection(out, CUSTOM_HEADING_RE)).toBe('replaced.');
  });
});
