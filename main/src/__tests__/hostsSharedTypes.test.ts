import { describe, it, expect } from 'vitest';
import { redactSecrets, SSH_TARGET_RE } from '../../../shared/types/hosts';

describe('redactSecrets', () => {
  it('redacts sk-ant keys', () => {
    expect(redactSecrets('key=sk-ant-api03-AbC_d-123 end')).toBe('key=sk-ant-[REDACTED] end');
  });
  it('redacts long sk- keys but not short ones', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz0123')).toBe('sk-[REDACTED]');
    expect(redactSecrets('sk-short')).toBe('sk-short');
  });
  it('redacts every occurrence and leaves other text', () => {
    expect(redactSecrets('a sk-ant-x1 b sk-ant-y2')).toBe('a sk-ant-[REDACTED] b sk-ant-[REDACTED]');
    expect(redactSecrets('plain text')).toBe('plain text');
  });
});

describe('SSH_TARGET_RE', () => {
  it('accepts aliases, user@host, ipv6 literals and ports-like forms', () => {
    for (const ok of ['cybo-mbp', 'me@host.example.com', 'user+tag@10.0.0.1', '[::1]', 'a'.repeat(253)]) {
      expect(SSH_TARGET_RE.test(ok), ok).toBe(true);
    }
  });
  it('rejects option-like, spaced, shell-meta, empty and oversize targets', () => {
    for (const bad of ['-oProxyCommand=x', '-v', '', 'a b', 'a;b', '$(x)', 'a`b`', 'a\nb', "a'b", 'a'.repeat(254)]) {
      expect(SSH_TARGET_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
