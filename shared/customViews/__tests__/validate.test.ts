import { describe, expect, it } from 'vitest';
import type { WidgetSpec } from '../../types/customViews';
import {
  customViewNameSchema,
  resolveSpecSettings,
  substituteTemplates,
  viewLayoutSchema,
  widgetSpecSchema,
} from '../validate';

function validSpec(): WidgetSpec {
  return {
    version: 1,
    sources: {
      tasks: {
        type: 'sql',
        sql: 'SELECT id, title, tokens FROM tasks WHERE priority = :priority',
        params: { priority: { setting: 'priority' } },
      },
    },
    transforms: {
      tasks: [
        { op: 'sort', field: 'tokens', dir: 'desc' },
        { op: 'limit', n: { setting: 'limit' } },
      ],
    },
    render: {
      type: 'shape',
      shape: 'table',
      source: 'tasks',
      columns: [{ field: 'title' }, { field: 'tokens', format: 'number' }],
    },
    actions: [
      { id: 'open', label: 'Open', kind: 'open-session', params: { runId: '{row.id}' }, placement: 'row', rowKey: 'id' },
      { id: 'launch', label: 'Launch', kind: 'launch-run', params: { note: 'from widget for {setting.priority}' }, placement: 'header' },
    ],
    settings: [
      {
        name: 'priority',
        label: 'Priority',
        kind: 'select',
        default: 'P1',
        options: [
          { value: 'P0', label: 'P0' },
          { value: 'P1', label: 'P1' },
        ],
      },
      { name: 'limit', label: 'Limit', kind: 'number', default: 10, min: 1, max: 50 },
    ],
    refreshSec: 60,
  };
}

describe('widgetSpecSchema', () => {
  it('accepts a valid spec', () => {
    const result = widgetSpecSchema.safeParse(validSpec());
    expect(result.success).toBe(true);
  });

  it('rejects render.source naming an undeclared source', () => {
    const spec = validSpec();
    spec.render = { ...spec.render, source: 'bogus' } as WidgetSpec['render'];
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'render.source')).toBe(true);
    }
  });

  it('rejects a transforms key naming an undeclared source', () => {
    const spec = validSpec();
    spec.transforms = { ...spec.transforms, bogus: [{ op: 'limit', n: 5 }] };
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'transforms.bogus')).toBe(true);
    }
  });

  it('rejects a row action with no rowKey', () => {
    const spec = validSpec();
    spec.actions = [{ id: 'open', label: 'Open', kind: 'open-session', params: {}, placement: 'row' }];
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'actions.0.rowKey')).toBe(true);
    }
  });

  it('rejects a template token with a disallowed prefix', () => {
    const spec = validSpec();
    spec.actions = [{ id: 'open', label: 'Open', kind: 'open-session', params: { runId: '{oops.id}' }, placement: 'row', rowKey: 'id' }];
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'actions.0.params.runId')).toBe(true);
    }
  });

  it('rejects a {setting.x} template token naming an undeclared setting', () => {
    const spec = validSpec();
    spec.actions = [
      { id: 'launch', label: 'Launch', kind: 'launch-run', params: { note: '{setting.nope}' }, placement: 'header' },
    ];
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'actions.0.params.note')).toBe(true);
    }
  });

  it('rejects a structured {setting: x} source param naming an undeclared setting', () => {
    const spec = validSpec();
    spec.sources.tasks = {
      type: 'sql',
      sql: 'SELECT id FROM tasks WHERE priority = :priority',
      params: { priority: { setting: 'nope' } },
    };
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'sources.tasks.params.priority')).toBe(true);
    }
  });

  it('rejects a structured {setting: x} transform value naming an undeclared setting', () => {
    const spec = validSpec();
    spec.transforms = { tasks: [{ op: 'limit', n: { setting: 'nope' } }] };
    const result = widgetSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'transforms.tasks.0.n')).toBe(true);
    }
  });
});

describe('viewLayoutSchema', () => {
  it('accepts a layout with distinct catalog widgets', () => {
    const result = viewLayoutSchema.safeParse({
      version: 1,
      items: [
        { instanceId: 'a', widget: { type: 'catalog', catalogId: 'queue.recommended' }, settings: {} },
        { instanceId: 'b', widget: { type: 'catalog', catalogId: 'queue.blocked-runs' }, settings: {} },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects the same catalog widget appearing twice', () => {
    const result = viewLayoutSchema.safeParse({
      version: 1,
      items: [
        { instanceId: 'a', widget: { type: 'catalog', catalogId: 'queue.recommended' }, settings: {} },
        { instanceId: 'b', widget: { type: 'catalog', catalogId: 'queue.recommended' }, settings: {} },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'items.1.widget.catalogId')).toBe(true);
    }
  });
});

describe('customViewNameSchema', () => {
  it('trims and accepts a 1..60 char name', () => {
    expect(customViewNameSchema.parse('  Ship week  ')).toBe('Ship week');
  });

  it('rejects an empty name and a name over 60 chars', () => {
    expect(customViewNameSchema.safeParse('   ').success).toBe(false);
    expect(customViewNameSchema.safeParse('x'.repeat(61)).success).toBe(false);
    expect(customViewNameSchema.safeParse('x'.repeat(60)).success).toBe(true);
  });
});

describe('resolveSpecSettings', () => {
  it('resolves every SettingRef to a provided or default scalar (deep copy, spec untouched)', () => {
    const spec = validSpec();
    const result = resolveSpecSettings(spec, { priority: 'P0', limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = result.spec.sources.tasks;
    expect(source.type).toBe('sql');
    if (source.type === 'sql') {
      expect(source.params?.priority).toEqual({ literal: 'P0' });
    }
    const limitStep = result.spec.transforms?.tasks[1];
    expect(limitStep).toEqual({ op: 'limit', n: 5 });
    // Original spec is untouched.
    expect(spec.sources.tasks).toEqual({
      type: 'sql',
      sql: 'SELECT id, title, tokens FROM tasks WHERE priority = :priority',
      params: { priority: { setting: 'priority' } },
    });
  });

  it('falls back to the declared default when a setting is not provided', () => {
    const spec = validSpec();
    const result = resolveSpecSettings(spec, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const limitStep = result.spec.transforms?.tasks[1];
    expect(limitStep).toEqual({ op: 'limit', n: 10 });
  });

  it('fails for an unknown setting name', () => {
    const spec = validSpec();
    spec.sources.tasks = {
      type: 'sql',
      sql: 'SELECT id FROM tasks',
      params: { priority: { setting: 'unknown-setting' } },
    };
    const result = resolveSpecSettings(spec, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown-setting');
  });

  it('fails a sort.dir SettingRef that resolves to a non-asc/desc value', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { tasks: { type: 'sql', sql: 'SELECT id, tokens FROM tasks' } },
      transforms: { tasks: [{ op: 'sort', field: 'tokens', dir: { setting: 'dirSetting' } }] },
      render: { type: 'shape', shape: 'table', source: 'tasks', columns: [{ field: 'tokens' }] },
      settings: [{ name: 'dirSetting', label: 'Dir', kind: 'select', default: 'sideways' }],
    };
    const result = resolveSpecSettings(spec, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("'asc' or 'desc'");
  });

  it('fails a limit.n SettingRef that resolves to a non-positive-integer value', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { tasks: { type: 'sql', sql: 'SELECT id, tokens FROM tasks' } },
      transforms: { tasks: [{ op: 'limit', n: { setting: 'limitSetting' } }] },
      render: { type: 'shape', shape: 'table', source: 'tasks', columns: [{ field: 'tokens' }] },
      settings: [{ name: 'limitSetting', label: 'Limit', kind: 'number', default: -1 }],
    };
    const result = resolveSpecSettings(spec, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('positive integer');
  });
});

describe('substituteTemplates', () => {
  it('preserves the number type for a whole-token match', () => {
    const result = substituteTemplates(
      { limit: '{row.n}' },
      { row: { n: 42 }, setting: {}, context: { projectId: null } }
    );
    expect(result).toEqual({ ok: true, value: { limit: 42 } });
  });

  it('splices an embedded token in as its string form', () => {
    const result = substituteTemplates(
      { note: 'run #{row.id} for project {context.projectId}' },
      { row: { id: 7 }, setting: {}, context: { projectId: 3 } }
    );
    expect(result).toEqual({ ok: true, value: { note: 'run #7 for project 3' } });
  });

  it('errors when a row.<field> reference has no row supplied or the field is missing', () => {
    const noRow = substituteTemplates({ id: '{row.id}' }, { setting: {}, context: { projectId: null } });
    expect(noRow.ok).toBe(false);

    const missingField = substituteTemplates(
      { id: '{row.missing}' },
      { row: { id: 1 }, setting: {}, context: { projectId: null } }
    );
    expect(missingField.ok).toBe(false);
  });

  it('never splices into a nested object or array wholesale — only string leaves', () => {
    const result = substituteTemplates(
      { items: ['{row.a}', { nested: '{row.b}' }] },
      { row: { a: 1, b: 'two' }, setting: {}, context: { projectId: null } }
    );
    expect(result).toEqual({ ok: true, value: { items: [1, { nested: 'two' }] } });
  });
});
