import { describe, it, expect } from 'vitest';
import {
  projectClaudeModelRows,
  CLAUDE_CATALOG_LIMIT,
  type RawClaudeModelRow,
} from '../claudeModelCatalogService';

/**
 * Pure-projection tests for the dynamic Claude catalog. The live probe
 * (supportedModels() over a real SDK session) is NOT headlessly verifiable — only
 * this dedupe/exclude/truncate logic is unit-covered.
 */
describe('projectClaudeModelRows', () => {
  it('drops the four pinned families (by alias value AND by resolved concrete id) and auto/default', () => {
    const rows: RawClaudeModelRow[] = [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
      { value: 'claude-opus-5-5', displayName: 'Opus 5.5 (concrete)' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku' },
      { value: 'auto', displayName: 'Auto' },
      { value: 'default', displayName: 'Default' },
      { value: 'claude-opus-5', displayName: 'Opus 5' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6' },
    ];
    // The previous-gen Opus 5 is no longer pinned, so it surfaces as an "Other models" row.
    expect(projectClaudeModelRows(rows).map((o) => o.id)).toEqual(['claude-opus-5', 'claude-opus-4-6']);
  });

  it('projects value/resolvedModel/label/description and falls the label back to the id', () => {
    const rows: RawClaudeModelRow[] = [
      { value: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Prev-gen Opus' },
      { value: 'claude-haiku-4-5-20251001' /* no displayName */ },
    ];
    expect(projectClaudeModelRows(rows)).toEqual([
      { id: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Prev-gen Opus' },
      { id: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001', description: '' },
    ]);
  });

  it('de-dupes rows that resolve to the same canonical wire id (alias row + concrete row)', () => {
    const rows: RawClaudeModelRow[] = [
      { value: 'opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6 (alias)' },
      { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6 (concrete)' },
    ];
    const out = projectClaudeModelRows(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'opus-4-6', label: 'Opus 4.6 (alias)' });
  });

  it('truncates to the limit, preserving input order', () => {
    const rows: RawClaudeModelRow[] = Array.from({ length: CLAUDE_CATALOG_LIMIT + 5 }, (_, i) => ({
      value: `claude-extra-${i}`,
      displayName: `Extra ${i}`,
    }));
    const out = projectClaudeModelRows(rows);
    expect(out).toHaveLength(CLAUDE_CATALOG_LIMIT);
    expect(out[0].id).toBe('claude-extra-0');
    expect(out[CLAUDE_CATALOG_LIMIT - 1].id).toBe(`claude-extra-${CLAUDE_CATALOG_LIMIT - 1}`);
  });

  it('honors an explicit limit and skips blank/malformed rows', () => {
    const rows: RawClaudeModelRow[] = [
      { value: '  ' },
      { value: 'claude-a', displayName: 'A' },
      { value: 'claude-b', displayName: 'B' },
      { value: 'claude-c', displayName: 'C' },
    ];
    expect(projectClaudeModelRows(rows, 2).map((o) => o.id)).toEqual(['claude-a', 'claude-b']);
  });

  it('is case-insensitive when excluding pinned ids', () => {
    const rows: RawClaudeModelRow[] = [
      { value: 'CLAUDE-OPUS-5-5', displayName: 'Opus 5.5 shouty' },
      { value: 'AUTO', displayName: 'Auto shouty' },
      { value: 'claude-keep', displayName: 'Keep' },
    ];
    expect(projectClaudeModelRows(rows).map((o) => o.id)).toEqual(['claude-keep']);
  });
});
