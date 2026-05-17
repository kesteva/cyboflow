import { describe, it, expect } from 'vitest';
import { buildCommitFooter } from './commitFooter';

const CYBOFLOW_URL = 'https://github.com/cyboflow/cyboflow';
const CO_AUTHOR = 'Co-Authored-By: Cyboflow <hello@cyboflow.com>';

describe('buildCommitFooter', () => {
  it('returns the canonical Cyboflow footer when enabled', () => {
    const result = buildCommitFooter(true);
    // Verify exact content via helper: URL, co-author, and the gem emoji prefix
    expect(result).toContain(CYBOFLOW_URL);
    expect(result).toContain(CO_AUTHOR);
    expect(result.startsWith('💎')).toBe(true); // 💎
    // The two sections must be separated by a blank line
    expect(result).toContain('\n\n');
    // Exact byte-level check: catches silent rebrand drift (typo'd URL, wrong email, etc.)
    expect(result).toBe(
      '💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)\n\nCo-Authored-By: Cyboflow <hello@cyboflow.com>'
    );
  });

  it('returns empty string when disabled', () => {
    const result = buildCommitFooter(false);
    expect(result).toBe('');
  });
});
