import { describe, it, expect } from 'vitest';
import { buildCommitFooter, isCommitFooterEnabled, appendCommitFooter } from './commitFooter';
import type { ConfigManager } from '../services/configManager';

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

// Helper to create a minimal ConfigManager mock
function makeConfigManager(enableCyboflowFooter?: boolean): ConfigManager {
  return {
    getConfig: () => ({ enableCyboflowFooter }),
  } as unknown as ConfigManager;
}

describe('isCommitFooterEnabled', () => {
  it('returns true when configManager is undefined', () => {
    expect(isCommitFooterEnabled(undefined)).toBe(true);
  });

  it('returns true when enableCyboflowFooter is undefined (default-on)', () => {
    expect(isCommitFooterEnabled(makeConfigManager(undefined))).toBe(true);
  });

  it('returns false only when enableCyboflowFooter === false (explicit opt-out)', () => {
    expect(isCommitFooterEnabled(makeConfigManager(false))).toBe(false);
  });
});

describe('appendCommitFooter', () => {
  it('returns message unchanged when disabled', () => {
    const msg = 'my commit message';
    expect(appendCommitFooter(msg, makeConfigManager(false))).toBe(msg);
  });

  it("returns message + '\\n\\n' + footer when enabled (byte-equal)", () => {
    const msg = 'my commit message';
    const footer = buildCommitFooter(true);
    expect(appendCommitFooter(msg, makeConfigManager(true))).toBe(`${msg}\n\n${footer}`);
  });

  it('handles undefined configManager same as missing key (default-on)', () => {
    const msg = 'my commit message';
    const footer = buildCommitFooter(true);
    expect(appendCommitFooter(msg, undefined)).toBe(`${msg}\n\n${footer}`);
  });
});
