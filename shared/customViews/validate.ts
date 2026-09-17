/**
 * Zod validation for Custom Views (docs/proposals/CUSTOM-VIEWS.md §3.1). The
 * tRPC router, the MCP handler (not the registry — the registry keeps
 * `spec_json`/`settings_json` as plain strings) and the renderer's draft
 * editor all validate with these schemas — one source of truth for shape
 * AND cross-field rules.
 *
 * Keep this file free of Node.js built-ins (no `Buffer`, no `node:*` imports)
 * so it runs in the renderer as well as the main process — byte-length
 * checks use `TextEncoder`, which is available in both.
 */

import { z } from 'zod';
import { AGENT_PROPOSAL_KINDS } from '../types/agentThread';
import {
  QUERY_SOURCE_NAMES,
  WIDGET_LIMITS,
  type JsonValue,
  type LayoutItem,
  type Scalar,
  type SettingRef,
  type SourceParam,
  type TransformStep,
  type ViewLayout,
  type WidgetAction,
  type WidgetRender,
  type WidgetSettingField,
  type WidgetSource,
  type WidgetSpec,
  type WidgetValueFormat,
} from '../types/customViews';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isSettingRef(value: unknown): value is SettingRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).setting === 'string';
}

/** Walks a JsonValue, invoking `visit` for every string leaf with its path breadcrumbs. */
function walkStringLeaves(value: JsonValue, path: Array<string | number>, visit: (leaf: string, path: Array<string | number>) => void): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStringLeaves(item, [...path, index], visit));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      walkStringLeaves(item, [...path, key], visit);
    }
  }
  // numbers/booleans/null: nothing to visit
}

/** Every `{...}` template token found in a string leaf, e.g. `"{row.id}"` -> `"row.id"`. */
const TEMPLATE_TOKEN_RE = /\{([^{}]+)\}/g;

function extractTemplateTokens(leaf: string): string[] {
  const tokens: string[] = [];
  for (const match of leaf.matchAll(TEMPLATE_TOKEN_RE)) {
    tokens.push(match[1]);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

export const scalarSchema: z.ZodType<Scalar> = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const settingRefSchema: z.ZodType<SettingRef> = z.object({
  setting: z.string().min(1, 'setting reference must name a non-empty setting'),
});

export const sourceParamSchema: z.ZodType<SourceParam> = z.union([
  z.object({ literal: scalarSchema }),
  settingRefSchema,
  z.object({ context: z.union([z.literal('projectId'), z.literal('nowIso'), z.literal('todayIso')]) }),
]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)])
);

const sqlTextSchema = z.string().min(1, 'sql must not be empty').refine((sql) => utf8ByteLength(sql) <= WIDGET_LIMITS.maxSqlBytes, {
  message: `sql must be at most ${WIDGET_LIMITS.maxSqlBytes} bytes (UTF-8)`,
});

const htmlTextSchema = z
  .string()
  .refine((html) => utf8ByteLength(html) <= WIDGET_LIMITS.maxHtmlBytes, {
    message: `html must be at most ${WIDGET_LIMITS.maxHtmlBytes} bytes (UTF-8)`,
  });

export const widgetSourceSchema: z.ZodType<WidgetSource> = z.union([
  z.object({
    type: z.literal('sql'),
    sql: sqlTextSchema,
    params: z.record(sourceParamSchema).optional(),
  }),
  z.object({
    type: z.literal('query'),
    name: z.enum(QUERY_SOURCE_NAMES),
    input: z.record(sourceParamSchema),
  }),
]);

/** `{ field: string } | { literal: number }` — matches the non-exported `Operand` type in customViews.ts structurally. */
const operandSchema = z.union([z.object({ field: z.string().min(1) }), z.object({ literal: z.number() })]);

const deriveExprSchema = z.union([
  z.object({ add: z.tuple([operandSchema, operandSchema]) }),
  z.object({ sub: z.tuple([operandSchema, operandSchema]) }),
  z.object({ mul: z.tuple([operandSchema, operandSchema]) }),
  z.object({ div: z.tuple([operandSchema, operandSchema]) }),
  z.object({ coalesce: z.tuple([operandSchema, operandSchema]) }),
]);

const filterCmpSchema = z.union([
  z.literal('eq'),
  z.literal('ne'),
  z.literal('gt'),
  z.literal('gte'),
  z.literal('lt'),
  z.literal('lte'),
  z.literal('in'),
  z.literal('contains'),
]);

export const transformStepSchema: z.ZodType<TransformStep> = z.union([
  z.object({
    op: z.literal('filter'),
    field: z.string().min(1),
    cmp: filterCmpSchema,
    value: z.union([scalarSchema, z.array(scalarSchema), settingRefSchema]),
  }),
  z.object({
    op: z.literal('sort'),
    field: z.string().min(1),
    dir: z.union([z.literal('asc'), z.literal('desc'), settingRefSchema]),
  }),
  z.object({
    op: z.literal('limit'),
    n: z.union([z.number().int().positive(), settingRefSchema]),
  }),
  z.object({
    op: z.literal('bucketDate'),
    field: z.string().min(1),
    unit: z.union([z.literal('day'), z.literal('week'), z.literal('month'), settingRefSchema]),
    as: z.string().min(1),
  }),
  z.object({
    op: z.literal('group'),
    by: z.array(z.string().min(1)),
    aggregates: z.array(
      z.object({
        fn: z.union([z.literal('sum'), z.literal('count'), z.literal('avg'), z.literal('min'), z.literal('max')]),
        field: z.string().min(1).optional(),
        as: z.string().min(1),
      })
    ),
  }),
  z.object({
    op: z.literal('derive'),
    as: z.string().min(1),
    expr: deriveExprSchema,
  }),
]);

const widgetValueFormatSchema: z.ZodType<WidgetValueFormat> = z.union([
  z.literal('number'),
  z.literal('tokens'),
  z.literal('usd'),
  z.literal('percent'),
  z.literal('duration'),
]);

export const widgetRenderSchema: z.ZodType<WidgetRender> = z.union([
  z.object({
    type: z.literal('shape'),
    shape: z.literal('stat'),
    source: z.string().min(1),
    value: z.string().min(1),
    label: z.string().optional(),
    format: widgetValueFormatSchema.optional(),
  }),
  z.object({
    type: z.literal('shape'),
    shape: z.literal('table'),
    source: z.string().min(1),
    columns: z.array(
      z.object({
        field: z.string().min(1),
        label: z.string().optional(),
        format: widgetValueFormatSchema.optional(),
      })
    ),
  }),
  z.object({
    type: z.literal('shape'),
    shape: z.literal('columns'),
    source: z.string().min(1),
    x: z.string().min(1),
    series: z.string().min(1),
    y: z.string().min(1),
  }),
  z.object({
    type: z.literal('shape'),
    shape: z.literal('bars'),
    source: z.string().min(1),
    label: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal('shape'),
    shape: z.literal('list'),
    source: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    meta: z.string().optional(),
  }),
  z.object({
    type: z.literal('html'),
    html: htmlTextSchema,
  }),
]);

// Matches `WidgetAction['navigation']` exactly: AgentNavigationTarget's two
// arms ('run' / 'quick-session', shared/types/agentThread.ts) plus the
// widget-only page targets.
const navigationTargetSchema = z.union([
  z.object({ target: z.literal('run'), runId: z.string(), projectId: z.number().optional() }),
  z.object({ target: z.literal('quick-session'), sessionId: z.string(), runId: z.string().optional(), projectId: z.number().optional() }),
  z.object({ target: z.literal('backlog'), projectId: z.number().optional() }),
  z.object({ target: z.literal('insights'), projectId: z.number().optional() }),
  z.object({ target: z.literal('workflows'), projectId: z.number().optional() }),
  z.object({ target: z.literal('project-overview'), projectId: z.number().optional() }),
]);

export const widgetActionSchema: z.ZodType<WidgetAction> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.union([z.enum(AGENT_PROPOSAL_KINDS), z.literal('navigate')]),
  params: jsonValueSchema,
  placement: z.union([z.literal('header'), z.literal('row')]).optional(),
  rowKey: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
  navigation: navigationTargetSchema.optional(),
});

export const widgetSettingFieldSchema: z.ZodType<WidgetSettingField> = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  kind: z.union([z.literal('select'), z.literal('number'), z.literal('project'), z.literal('boolean'), z.literal('text')]),
  options: z.array(z.object({ value: scalarSchema, label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: scalarSchema,
});

// ---------------------------------------------------------------------------
// WidgetSpec — shape + cross-field rules
// ---------------------------------------------------------------------------

const widgetSpecShapeSchema = z.object({
  version: z.literal(1),
  sources: z.record(widgetSourceSchema).refine((sources) => {
    const count = Object.keys(sources).length;
    return count >= 1 && count <= WIDGET_LIMITS.maxSources;
  }, { message: `sources must have between 1 and ${WIDGET_LIMITS.maxSources} entries` }),
  transforms: z.record(z.array(transformStepSchema)).optional(),
  render: widgetRenderSchema,
  actions: z.array(widgetActionSchema).max(WIDGET_LIMITS.maxActions, `actions must have at most ${WIDGET_LIMITS.maxActions} entries`).optional(),
  settings: z.array(widgetSettingFieldSchema).optional(),
  refreshSec: z.number().int().min(WIDGET_LIMITS.minRefreshSec).max(WIDGET_LIMITS.maxRefreshSec).optional(),
});

/**
 * Cross-field rules beyond shape (docs/proposals/CUSTOM-VIEWS.md §3.1):
 *   - `render.source` (shape renders) names a declared source
 *   - every `transforms` key names a declared source
 *   - every action with `placement:'row'` has a `rowKey`
 *   - action `params` template strings may only reference `row.<field>`,
 *     `setting.<declared setting name>`, `context.projectId`
 *   - every structured `{setting: x}` ref (in source params and transform
 *     values) must name a declared setting
 */
export const widgetSpecSchema = widgetSpecShapeSchema.superRefine((spec, ctx) => {
  const sourceNames = new Set(Object.keys(spec.sources));
  const settingNames = new Set((spec.settings ?? []).map((s) => s.name));

  // render.source (shape renders only) must name a declared source.
  if (spec.render.type === 'shape' && !sourceNames.has(spec.render.source)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `render.source '${spec.render.source}' does not name a declared source`,
      path: ['render', 'source'],
    });
  }

  // Every SourceParam that is a SettingRef must name a declared setting.
  for (const [sourceName, source] of Object.entries(spec.sources)) {
    const params = source.type === 'sql' ? source.params : source.input;
    const paramsKey = source.type === 'sql' ? 'params' : 'input';
    for (const [paramKey, param] of Object.entries(params ?? {})) {
      if (isSettingRef(param) && !settingNames.has(param.setting)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `setting reference '${param.setting}' does not name a declared setting`,
          path: ['sources', sourceName, paramsKey, paramKey],
        });
      }
    }
  }

  // Every `transforms` key must name a declared source; SettingRef values
  // within its steps must name a declared setting.
  for (const [sourceName, steps] of Object.entries(spec.transforms ?? {})) {
    if (!sourceNames.has(sourceName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `transforms key '${sourceName}' does not name a declared source`,
        path: ['transforms', sourceName],
      });
    }
    steps.forEach((step, stepIndex) => {
      const checkRef = (value: unknown, field: string) => {
        if (isSettingRef(value) && !settingNames.has(value.setting)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `setting reference '${value.setting}' does not name a declared setting`,
            path: ['transforms', sourceName, stepIndex, field],
          });
        }
      };
      if (step.op === 'filter') checkRef(step.value, 'value');
      else if (step.op === 'sort') checkRef(step.dir, 'dir');
      else if (step.op === 'limit') checkRef(step.n, 'n');
      else if (step.op === 'bucketDate') checkRef(step.unit, 'unit');
    });
  }

  // Actions: row placement requires rowKey; template tokens are scoped.
  (spec.actions ?? []).forEach((action, actionIndex) => {
    if (action.placement === 'row' && !action.rowKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `action '${action.id}' has placement:'row' but no rowKey`,
        path: ['actions', actionIndex, 'rowKey'],
      });
    }

    walkStringLeaves(action.params, ['actions', actionIndex, 'params'], (leaf, leafPath) => {
      for (const token of extractTemplateTokens(leaf)) {
        if (token === 'context.projectId') continue;
        if (token.startsWith('row.') && token.length > 'row.'.length) continue;
        if (token.startsWith('setting.') && token.length > 'setting.'.length) {
          const settingName = token.slice('setting.'.length);
          if (!settingNames.has(settingName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `template token '{${token}}' does not name a declared setting`,
              path: leafPath,
            });
          }
          continue;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `template token '{${token}}' must be 'row.<field>', 'setting.<name>', or 'context.projectId'`,
          path: leafPath,
        });
      }
    });
  });
}) satisfies z.ZodType<WidgetSpec>;

// ---------------------------------------------------------------------------
// Layout / view
// ---------------------------------------------------------------------------

const widgetRefSchema = z.union([
  z.object({ type: z.literal('catalog'), catalogId: z.string().min(1) }),
  z.object({ type: z.literal('custom'), widgetId: z.string().min(1) }),
]);

export const layoutItemSchema: z.ZodType<LayoutItem> = z.object({
  instanceId: z.string().min(1),
  widget: widgetRefSchema,
  settings: z.record(scalarSchema),
  title: z.string().optional(),
  refreshSec: z.number().int().min(WIDGET_LIMITS.minRefreshSec).max(WIDGET_LIMITS.maxRefreshSec).optional(),
  hidden: z.boolean().optional(),
});

/**
 * A catalog widget may appear at most once per layout. The validator cannot
 * tell which catalog ids are singleton "sections" (that mapping lives in the
 * renderer's catalog registry — §5.1), so this rule is applied to EVERY
 * catalog ref, not just section entries. This is deliberately stricter than
 * strictly required for non-singleton spec-entry catalog widgets, but a
 * layout duplicating any catalog widget is a UI mistake either way (the
 * library disables an already-placed entry regardless of kind).
 */
export const viewLayoutSchema = z
  .object({
    version: z.literal(1),
    items: z.array(layoutItemSchema),
  })
  .superRefine((layout, ctx) => {
    const seenCatalogIds = new Map<string, number>();
    layout.items.forEach((item, index) => {
      if (item.widget.type !== 'catalog') return;
      const firstIndex = seenCatalogIds.get(item.widget.catalogId);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `catalog widget '${item.widget.catalogId}' already appears at items[${firstIndex}]`,
          path: ['items', index, 'widget', 'catalogId'],
        });
      } else {
        seenCatalogIds.set(item.widget.catalogId, index);
      }
    });
  }) satisfies z.ZodType<ViewLayout>;

export const customViewNameSchema = z.string().trim().min(1, 'name must not be empty').max(60, 'name must be at most 60 characters');

// ---------------------------------------------------------------------------
// resolveSpecSettings — replace every {setting: name} with a validated scalar
// ---------------------------------------------------------------------------

export type ResolveSpecSettingsResult = { ok: true; spec: WidgetSpec } | { ok: false; error: string };

function lookupSetting(spec: WidgetSpec, name: string): { ok: true; value: Scalar; default: Scalar } | { ok: false; error: string } {
  const field = (spec.settings ?? []).find((s) => s.name === name);
  if (!field) return { ok: false, error: `unknown setting '${name}'` };
  return { ok: true, value: field.default, default: field.default };
}

/**
 * Resolves every `{setting: name}` reference in a spec's source params and
 * transform values to a concrete `Scalar`, using `settings[name]` when
 * provided, else the field's declared default. Returns a DEEP COPY; the
 * input spec is never mutated. Booleans are left as booleans (the SQL layer
 * coerces them to 1/0 at bind time).
 */
export function resolveSpecSettings(spec: WidgetSpec, settings: Record<string, Scalar>): ResolveSpecSettingsResult {
  const resolveScalar = (name: string): { ok: true; value: Scalar } | { ok: false; error: string } => {
    const declared = lookupSetting(spec, name);
    if (!declared.ok) return declared;
    const value = Object.prototype.hasOwnProperty.call(settings, name) ? settings[name] : declared.default;
    return { ok: true, value: value ?? declared.default };
  };

  const resolveSourceParam = (param: SourceParam): { ok: true; value: SourceParam } | { ok: false; error: string } => {
    if (isSettingRef(param)) {
      const resolved = resolveScalar(param.setting);
      if (!resolved.ok) return resolved;
      return { ok: true, value: { literal: resolved.value } };
    }
    return { ok: true, value: param };
  };

  const sources: Record<string, WidgetSource> = {};
  for (const [sourceName, source] of Object.entries(spec.sources)) {
    if (source.type === 'sql') {
      const params: Record<string, SourceParam> = {};
      for (const [key, param] of Object.entries(source.params ?? {})) {
        const resolved = resolveSourceParam(param);
        if (!resolved.ok) return { ok: false, error: `sources.${sourceName}.params.${key}: ${resolved.error}` };
        params[key] = resolved.value;
      }
      sources[sourceName] = source.params ? { ...source, params } : { ...source };
    } else {
      const input: Record<string, SourceParam> = {};
      for (const [key, param] of Object.entries(source.input)) {
        const resolved = resolveSourceParam(param);
        if (!resolved.ok) return { ok: false, error: `sources.${sourceName}.input.${key}: ${resolved.error}` };
        input[key] = resolved.value;
      }
      sources[sourceName] = { ...source, input };
    }
  }

  const transforms: Record<string, TransformStep[]> | undefined = spec.transforms
    ? {}
    : undefined;
  if (spec.transforms && transforms) {
    for (const [sourceName, steps] of Object.entries(spec.transforms)) {
      const resolvedSteps: TransformStep[] = [];
      for (const step of steps) {
        if (step.op === 'filter' && isSettingRef(step.value)) {
          const resolved = resolveScalar(step.value.setting);
          if (!resolved.ok) return { ok: false, error: `transforms.${sourceName}.filter.value: ${resolved.error}` };
          resolvedSteps.push({ ...step, value: resolved.value });
        } else if (step.op === 'sort' && isSettingRef(step.dir)) {
          const resolved = resolveScalar(step.dir.setting);
          if (!resolved.ok) return { ok: false, error: `transforms.${sourceName}.sort.dir: ${resolved.error}` };
          if (resolved.value !== 'asc' && resolved.value !== 'desc') {
            return { ok: false, error: `transforms.${sourceName}.sort.dir: setting '${step.dir.setting}' must resolve to 'asc' or 'desc'` };
          }
          resolvedSteps.push({ ...step, dir: resolved.value });
        } else if (step.op === 'limit' && isSettingRef(step.n)) {
          const resolved = resolveScalar(step.n.setting);
          if (!resolved.ok) return { ok: false, error: `transforms.${sourceName}.limit.n: ${resolved.error}` };
          if (typeof resolved.value !== 'number' || !Number.isInteger(resolved.value) || resolved.value <= 0) {
            return { ok: false, error: `transforms.${sourceName}.limit.n: setting '${step.n.setting}' must resolve to a positive integer` };
          }
          resolvedSteps.push({ ...step, n: resolved.value });
        } else if (step.op === 'bucketDate' && isSettingRef(step.unit)) {
          const resolved = resolveScalar(step.unit.setting);
          if (!resolved.ok) return { ok: false, error: `transforms.${sourceName}.bucketDate.unit: ${resolved.error}` };
          if (resolved.value !== 'day' && resolved.value !== 'week' && resolved.value !== 'month') {
            return { ok: false, error: `transforms.${sourceName}.bucketDate.unit: setting '${step.unit.setting}' must resolve to 'day', 'week', or 'month'` };
          }
          resolvedSteps.push({ ...step, unit: resolved.value });
        } else {
          resolvedSteps.push(step);
        }
      }
      transforms[sourceName] = resolvedSteps;
    }
  }

  return {
    ok: true,
    spec: {
      ...spec,
      sources,
      ...(transforms ? { transforms } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// substituteTemplates — replace row/setting/context tokens in action params
// ---------------------------------------------------------------------------

export interface SubstituteTemplatesContext {
  row?: Record<string, Scalar>;
  setting: Record<string, Scalar>;
  context: { projectId: number | null };
}

export type SubstituteTemplatesResult = { ok: true; value: JsonValue } | { ok: false; error: string };

const WHOLE_TOKEN_RE = /^\{([^{}]+)\}$/;

function resolveToken(token: string, ctx: SubstituteTemplatesContext): { ok: true; value: Scalar } | { ok: false; error: string } {
  if (token === 'context.projectId') return { ok: true, value: ctx.context.projectId };
  if (token.startsWith('row.')) {
    const field = token.slice('row.'.length);
    if (!ctx.row || !Object.prototype.hasOwnProperty.call(ctx.row, field)) {
      return { ok: false, error: `row.${field} is not available (no row supplied or field missing)` };
    }
    return { ok: true, value: ctx.row[field] };
  }
  if (token.startsWith('setting.')) {
    const name = token.slice('setting.'.length);
    if (!Object.prototype.hasOwnProperty.call(ctx.setting, name)) {
      return { ok: false, error: `setting.${name} is not available` };
    }
    return { ok: true, value: ctx.setting[name] };
  }
  return { ok: false, error: `template token '{${token}}' must be 'row.<field>', 'setting.<name>', or 'context.projectId'` };
}

/**
 * Substitutes `{row.x}` / `{setting.x}` / `{context.projectId}` tokens found
 * in string leaves of `params`. A string that is EXACTLY one token resolves
 * to the underlying scalar (preserving its type — a number stays a number);
 * a token embedded in a longer string is spliced in as its string form.
 * Objects/arrays are walked but never replaced wholesale — only their string
 * leaves are substituted.
 */
export function substituteTemplates(params: JsonValue, ctx: SubstituteTemplatesContext): SubstituteTemplatesResult {
  const substituteLeaf = (leaf: string): { ok: true; value: JsonValue } | { ok: false; error: string } => {
    const wholeMatch = WHOLE_TOKEN_RE.exec(leaf);
    if (wholeMatch) {
      const resolved = resolveToken(wholeMatch[1], ctx);
      if (!resolved.ok) return resolved;
      return { ok: true, value: resolved.value };
    }
    let error: string | null = null;
    const replaced = leaf.replace(TEMPLATE_TOKEN_RE, (_match, token: string) => {
      if (error) return '';
      const resolved = resolveToken(token, ctx);
      if (!resolved.ok) {
        error = resolved.error;
        return '';
      }
      return resolved.value === null ? '' : String(resolved.value);
    });
    if (error) return { ok: false, error };
    return { ok: true, value: replaced };
  };

  const substitute = (value: JsonValue): { ok: true; value: JsonValue } | { ok: false; error: string } => {
    if (typeof value === 'string') return substituteLeaf(value);
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (const item of value) {
        const resolved = substitute(item);
        if (!resolved.ok) return resolved;
        out.push(resolved.value);
      }
      return { ok: true, value: out };
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        const resolved = substitute(item);
        if (!resolved.ok) return resolved;
        out[key] = resolved.value;
      }
      return { ok: true, value: out };
    }
    return { ok: true, value };
  };

  return substitute(params);
}
