import { describe, it, expect } from 'vitest';
import { ASSISTANT_REFERENCE } from './assistantReference';

/**
 * Guards the assistant's product-reference content (served by the
 * cyboflow_reference MCP tool): every topic is well-formed and non-empty, keys
 * are kebab-case, and each body sits in a sane size band so a stub ("TODO") or a
 * runaway paste both fail loudly rather than silently shipping to the assistant.
 */
describe('ASSISTANT_REFERENCE', () => {
  const entries = Object.entries(ASSISTANT_REFERENCE);

  it('has a reasonable number of topics', () => {
    expect(entries.length).toBeGreaterThanOrEqual(7);
    expect(entries.length).toBeLessThanOrEqual(12);
  });

  it('uses kebab-case topic keys', () => {
    for (const [key] of entries) {
      expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('every topic has a non-empty title and one-liner', () => {
    for (const [key, topic] of entries) {
      expect(topic.title.trim().length, `${key}.title`).toBeGreaterThan(0);
      expect(topic.oneLiner.trim().length, `${key}.oneLiner`).toBeGreaterThan(0);
    }
  });

  it('every body is within a sane size band (200–8000 chars)', () => {
    for (const [key, topic] of entries) {
      expect(topic.body.trim().length, `${key}.body min`).toBeGreaterThanOrEqual(200);
      expect(topic.body.length, `${key}.body max`).toBeLessThanOrEqual(8000);
    }
  });

  it('covers the four built-in flows', () => {
    for (const key of ['planner-flow', 'sprint-flow', 'compound-flow', 'ship-flow']) {
      expect(ASSISTANT_REFERENCE[key], key).toBeDefined();
    }
  });
});
