/**
 * Every tier-2 built-in catalog widget spec (docs/proposals/CUSTOM-VIEWS.md
 * §5.1, §9 row S3) must clear the SAME `widgetSpecSchema` the router validates
 * an inline/custom widget with — a built-in gets no free pass on shape or the
 * cross-field rules (declared sources, `render.source` naming a real source,
 * `{setting}` refs naming a declared setting, row-placement actions carrying
 * `rowKey`, template tokens scoped to `row.<field>` / `setting.<name>` /
 * `context.projectId`).
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_WIDGET_SPECS } from '../catalogSpecs';
import { widgetSpecSchema } from '../validate';

describe('CATALOG_WIDGET_SPECS', () => {
  it('carries exactly the five tier-2 built-ins named in the plan', () => {
    expect(Object.keys(CATALOG_WIDGET_SPECS).sort()).toEqual(
      [
        'insights.daily-usage',
        'insights.workflow-stats',
        'stats.tokens-today',
        'stats.open-review-items',
        'sessions.recent',
      ].sort(),
    );
  });

  it.each(Object.entries(CATALOG_WIDGET_SPECS))('%s passes widgetSpecSchema', (_id, spec) => {
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success, result.success ? '' : JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it("sessions.recent's row action declares a rowKey", () => {
    const spec = CATALOG_WIDGET_SPECS['sessions.recent'];
    const rowAction = spec?.actions?.find((a) => a.placement === 'row');
    expect(rowAction).toBeDefined();
    expect(rowAction?.rowKey).toBe('id');
  });

  it('every stat/table/columns/list render names a declared source', () => {
    for (const [id, spec] of Object.entries(CATALOG_WIDGET_SPECS)) {
      if (spec.render.type === 'shape') {
        expect(Object.keys(spec.sources), id).toContain(spec.render.source);
      }
    }
  });

  it('every SQL source is a bare SELECT (no writes, no PRAGMA/ATTACH)', () => {
    for (const [id, spec] of Object.entries(CATALOG_WIDGET_SPECS)) {
      for (const [name, source] of Object.entries(spec.sources)) {
        if (source.type !== 'sql') continue;
        expect(/^\s*SELECT/i.test(source.sql), `${id}.${name}`).toBe(true);
        expect(/\b(ATTACH|PRAGMA|INSERT|UPDATE|DELETE)\b/i.test(source.sql), `${id}.${name}`).toBe(false);
      }
    }
  });
});
