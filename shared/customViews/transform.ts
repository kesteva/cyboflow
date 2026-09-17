/**
 * Pure row transforms for Custom Views (docs/proposals/CUSTOM-VIEWS.md §3.1,
 * §4.2). Runs in the main process (so tier-3 frames and tables receive final
 * rows) and is unit-tested directly.
 *
 * `applyTransform` operates on an ALREADY setting-resolved step list — every
 * `TransformStep` field that could carry a `SettingRef` (`filter.value`,
 * `sort.dir`, `limit.n`, `bucketDate.unit`) must have been resolved to a
 * concrete value by `resolveSpecSettings` (validate.ts) before this runs. A
 * step that still carries a `SettingRef` throws a plain Error — that is a
 * caller bug, not a data problem.
 *
 * Keep this file free of Node.js built-ins so it runs in any environment.
 */

import type { Scalar, TransformStep } from '../types/customViews';

type Row = Record<string, Scalar>;

function assertNoSettingRef(value: unknown, where: string): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).setting === 'string') {
    throw new Error(`applyTransform: unresolved SettingRef at ${where} — resolve settings before calling applyTransform`);
  }
}

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

type FilterCmp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

function compareOrdered(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * `eq`/`ne` compare directly (including against `null`). Every other
 * comparator NEVER matches a null row value — a null field is excluded from
 * `gt`/`gte`/`lt`/`lte`/`in`/`contains` filters regardless of the compared
 * value.
 */
function matchesFilter(rowValue: Scalar, cmp: FilterCmp, value: Scalar | Scalar[]): boolean {
  if (cmp === 'eq') return rowValue === (value as Scalar);
  if (cmp === 'ne') return rowValue !== (value as Scalar);
  if (rowValue === null) return false;

  switch (cmp) {
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof value !== 'number' && typeof value !== 'string') return false;
      if (typeof rowValue !== typeof value) return false;
      const cmpResult = compareOrdered(rowValue as number | string, value);
      if (cmp === 'gt') return cmpResult > 0;
      if (cmp === 'gte') return cmpResult >= 0;
      if (cmp === 'lt') return cmpResult < 0;
      return cmpResult <= 0;
    }
    case 'in':
      return Array.isArray(value) && value.includes(rowValue);
    case 'contains':
      return typeof rowValue === 'string' && typeof value === 'string' && rowValue.toLowerCase().includes(value.toLowerCase());
    default:
      return false;
  }
}

function applyFilter(rows: Row[], step: Extract<TransformStep, { op: 'filter' }>): Row[] {
  assertNoSettingRef(step.value, `filter.value (field '${step.field}')`);
  const value = step.value as Scalar | Scalar[];
  return rows.filter((row) => matchesFilter(row[step.field] ?? null, step.cmp, value));
}

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

function compareForSort(a: Scalar, b: Scalar, dir: 'asc' | 'desc'): number {
  // Nulls sort last regardless of direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return dir === 'asc' ? cmp : -cmp;
}

function applySort(rows: Row[], step: Extract<TransformStep, { op: 'sort' }>): Row[] {
  assertNoSettingRef(step.dir, `sort.dir (field '${step.field}')`);
  const dir = step.dir as 'asc' | 'desc';
  // .slice() keeps this pure; Array#sort is spec-stable since ES2019.
  return rows.slice().sort((a, b) => compareForSort(a[step.field] ?? null, b[step.field] ?? null, dir));
}

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

function applyLimit(rows: Row[], step: Extract<TransformStep, { op: 'limit' }>): Row[] {
  assertNoSettingRef(step.n, 'limit.n');
  const n = step.n as number;
  return rows.slice(0, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// bucketDate
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Monday (UTC, ISO week start) of the week containing `date`. */
function mondayOfIsoWeekUtc(date: Date): Date {
  // getUTCDay(): 0=Sun..6=Sat. ISO week starts Monday, so shift to 0=Mon..6=Sun.
  const isoDayIndex = (date.getUTCDay() + 6) % 7;
  const dayStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(dayStartMs - isoDayIndex * 86_400_000);
}

/**
 * Parses an ISO-8601 string or a SQLite `'YYYY-MM-DD HH:MM:SS'` string as
 * UTC. A naive (no-zone) date-time is treated as UTC — the codebase
 * convention for `sessions.db` timestamp columns. A zoned/`Z`-suffixed
 * string is parsed with its own offset. Returns `null` when unparsable.
 */
function parseIsoOrSqliteUtc(value: string): Date | null {
  const dateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (dateTimeMatch) {
    const [, y, mo, d, h, mi, s, zone] = dateTimeMatch;
    if (zone) {
      const parsed = new Date(value.replace(' ', 'T'));
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnlyMatch) {
    const [, y, mo, d] = dateOnlyMatch;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

function bucketDateValue(raw: Scalar, unit: 'day' | 'week' | 'month'): Scalar {
  if (typeof raw !== 'string') return null;
  const parsed = parseIsoOrSqliteUtc(raw);
  if (!parsed) return null;
  if (unit === 'day') return formatUtcDate(parsed);
  if (unit === 'week') return formatUtcDate(mondayOfIsoWeekUtc(parsed));
  return `${parsed.getUTCFullYear()}-${pad2(parsed.getUTCMonth() + 1)}-01`;
}

function applyBucketDate(rows: Row[], step: Extract<TransformStep, { op: 'bucketDate' }>): Row[] {
  assertNoSettingRef(step.unit, `bucketDate.unit (field '${step.field}')`);
  const unit = step.unit as 'day' | 'week' | 'month';
  return rows.map((row) => ({ ...row, [step.as]: bucketDateValue(row[step.field] ?? null, unit) }));
}

// ---------------------------------------------------------------------------
// group
// ---------------------------------------------------------------------------

function groupKey(row: Row, by: string[]): string {
  return JSON.stringify(by.map((field) => row[field] ?? null));
}

function applyGroup(rows: Row[], step: Extract<TransformStep, { op: 'group' }>): Row[] {
  const order: string[] = [];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupKey(row, step.by);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const bucket = groups.get(key) as Row[];
    const out: Row = {};
    for (const field of step.by) out[field] = bucket[0][field] ?? null;
    for (const agg of step.aggregates) {
      out[agg.as] = computeAggregate(bucket, agg.fn, agg.field);
    }
    return out;
  });
}

function computeAggregate(bucket: Row[], fn: 'sum' | 'count' | 'avg' | 'min' | 'max', field: string | undefined): Scalar {
  if (fn === 'count') {
    if (!field) return bucket.length;
    return bucket.filter((row) => row[field] !== null && row[field] !== undefined).length;
  }

  const numericValues = field !== undefined ? bucket.map((row) => row[field]).filter((v): v is number => typeof v === 'number') : [];

  if (fn === 'sum') return numericValues.reduce((acc, v) => acc + v, 0);
  if (numericValues.length === 0) return null;
  if (fn === 'avg') return numericValues.reduce((acc, v) => acc + v, 0) / numericValues.length;
  if (fn === 'min') return Math.min(...numericValues);
  return Math.max(...numericValues);
}

// ---------------------------------------------------------------------------
// derive
// ---------------------------------------------------------------------------

type Operand = { field: string } | { literal: number };
type DeriveOp = 'add' | 'sub' | 'mul' | 'div' | 'coalesce';

function operandRaw(row: Row, operand: Operand): Scalar {
  return 'literal' in operand ? operand.literal : row[operand.field] ?? null;
}

function operandNumeric(row: Row, operand: Operand): number | null {
  if ('literal' in operand) return operand.literal;
  const value = row[operand.field];
  return typeof value === 'number' ? value : null;
}

function applyDerive(rows: Row[], step: Extract<TransformStep, { op: 'derive' }>): Row[] {
  const [opName, operands] = Object.entries(step.expr)[0] as [DeriveOp, [Operand, Operand]];
  const [left, right] = operands;

  return rows.map((row) => {
    let value: Scalar;
    if (opName === 'coalesce') {
      const leftRaw = operandRaw(row, left);
      value = leftRaw !== null ? leftRaw : operandRaw(row, right);
    } else {
      const a = operandNumeric(row, left);
      const b = operandNumeric(row, right);
      if (a === null || b === null) {
        value = null;
      } else if (opName === 'add') {
        value = a + b;
      } else if (opName === 'sub') {
        value = a - b;
      } else if (opName === 'mul') {
        value = a * b;
      } else {
        value = b === 0 ? null : a / b;
      }
    }
    return { ...row, [step.as]: value };
  });
}

// ---------------------------------------------------------------------------
// applyTransform
// ---------------------------------------------------------------------------

/**
 * Applies an ordered, already setting-resolved list of transform steps to
 * one source's rows, returning a NEW array (rows are never mutated).
 */
export function applyTransform(rows: Array<Record<string, Scalar>>, steps: TransformStep[]): Array<Record<string, Scalar>> {
  let current = rows;
  for (const step of steps) {
    switch (step.op) {
      case 'filter':
        current = applyFilter(current, step);
        break;
      case 'sort':
        current = applySort(current, step);
        break;
      case 'limit':
        current = applyLimit(current, step);
        break;
      case 'bucketDate':
        current = applyBucketDate(current, step);
        break;
      case 'group':
        current = applyGroup(current, step);
        break;
      case 'derive':
        current = applyDerive(current, step);
        break;
      default: {
        const _exhaustive: never = step;
        throw new Error(`applyTransform: unknown op (exhaustive switch violated): ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  return current;
}
