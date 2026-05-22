import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateInput } from '../validateInput';

describe('validateInput', () => {
  it('valid args → { ok: true, value }', () => {
    const schema = z.object({ projectId: z.number().finite() });
    const result = validateInput(schema, { projectId: 42 }, 'cyboflow:listRuns');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projectId).toBe(42);
    }
  });

  it('wrong type → { ok: false, error contains channel and field }', () => {
    const schema = z.object({ projectId: z.number().finite() });
    const result = validateInput(schema, { projectId: 'bad' }, 'cyboflow:listRuns');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/cyboflow:listRuns/);
      expect(result.error).toMatch(/projectId/);
    }
  });

  it('non-finite number (NaN) → { ok: false, error names field }', () => {
    const schema = z.object({ projectId: z.number().finite() });
    const result = validateInput(schema, { projectId: NaN }, 'cyboflow:listRuns');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/projectId/);
    }
  });

  it('missing key → { ok: false, error names field }', () => {
    const schema = z.object({ projectId: z.number().finite() });
    const result = validateInput(schema, {}, 'cyboflow:listRuns');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/projectId/);
    }
  });

  it('empty string → { ok: false, error names field }', () => {
    const schema = z.object({ workflowId: z.string().min(1) });
    const result = validateInput(schema, { workflowId: '' }, 'cyboflow:startRun');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/workflowId/);
    }
  });
});
