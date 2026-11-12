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

  it.each<{ name: string; schema: z.ZodType; args: unknown; channel: string; field: RegExp }>([
    {
      name: 'non-finite number (NaN)',
      schema: z.object({ projectId: z.number().finite() }),
      args: { projectId: NaN },
      channel: 'cyboflow:listRuns',
      field: /projectId/,
    },
    {
      name: 'missing key',
      schema: z.object({ projectId: z.number().finite() }),
      args: {},
      channel: 'cyboflow:listRuns',
      field: /projectId/,
    },
    {
      name: 'empty string',
      schema: z.object({ workflowId: z.string().min(1) }),
      args: { workflowId: '' },
      channel: 'cyboflow:startRun',
      field: /workflowId/,
    },
  ])('$name → { ok: false, error names field }', ({ schema, args, channel, field }) => {
    const result = validateInput(schema, args, channel);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(field);
    }
  });
});
