/**
 * WidgetDataService — cache, per-request freshness and the repeat-suppression
 * breaker in front of `runWidgetSources` (docs/proposals/CUSTOM-VIEWS.md §4.3).
 *
 * Cache key = sha256 over the canonical JSON of the RESOLVED spec plus
 * `{ projectId, todayIso }`. `nowIso` is deliberately excluded: it is resolved
 * at run time, and folding it into the key would defeat both the cache and the
 * breaker on every call. `todayIso` IS included, because it changes what a
 * "today" query means.
 *
 * Freshness is PER REQUEST, not per entry: two layout items pointing at the
 * same resolved spec share one entry and differ only in how stale a payload
 * they will accept, so `refreshSec` is an argument to `run`, never state.
 *
 * The breaker is REPEAT SUPPRESSION, not a time budget. A run whose total
 * elapsed time exceeds `slowQueryMs` marks its key paused; later calls return
 * `{ paused: { tookMs } }` without querying until the resolved spec changes (a
 * new key) or the user clicks Retry (`resetBreaker`). It does NOT stop the
 * first slow run — better-sqlite3 is synchronous and has no interrupt. That is
 * accepted for v1 and bounded by the widget SQL validator (no recursive CTEs,
 * no multi-statement), the output caps, the refresh floor, and the fact that
 * every widget is previewed once through the assistant before it is saved.
 *
 * All state is per app instance and dies with the process.
 */
import { createHash } from 'node:crypto';
import type BetterSqlite3Database from 'better-sqlite3';
import type {
  Scalar,
  WidgetDataPayload,
  WidgetSpec,
} from '../../../../shared/types/customViews';
import { WIDGET_LIMITS } from '../../../../shared/types/customViews';
import { resolveSpecSettings } from '../../../../shared/customViews/validate';
import { coerceBindParams, openReadonlySibling } from '../readOnlyQuery';
import type { DatabaseLike } from '../types';
import { collectQueryPlan, resolveParamBag, runWidgetSources } from './sourceRunner';

/**
 * `WidgetDataPayload` with the per-source error arm the runner can produce.
 *
 * The shared `WidgetDataPayload.sources` types every slot as a successful
 * `SourceResult`; §4.2 requires a failed source to land `{ error }` in its own
 * slot instead of failing the widget, so this widening is what the service
 * actually returns. It is assignable FROM `WidgetDataPayload`, so the shared
 * type stays the contract for the success case.
 */
/** @deprecated alias — the shared `WidgetDataPayload` now carries the per-source error arm. */
export type WidgetRunPayload = WidgetDataPayload;

/** The advisory a `SCAN` line in any source's query plan raises. */
export const FULL_SCAN_WARNING = 'full scan (see query plan)';

export interface WidgetDataServiceOptions {
  db: DatabaseLike;
  /** Injectable clock; defaults to `Date`. */
  now?: () => Date;
  /** Total elapsed ms above which a key is marked paused. */
  slowQueryMs?: number;
  /** LRU ceiling on cached entries. */
  maxEntries?: number;
}

/** The key inputs — everything that decides WHICH cache entry a call lands on. */
export interface WidgetKeyInput {
  spec: WidgetSpec;
  settings: Record<string, Scalar>;
  context: { projectId: number | null };
}

export interface WidgetRunInput extends WidgetKeyInput {
  /** The layout item's override or the spec default; clamped to the shared bounds. */
  refreshSec?: number;
}

interface CacheEntry {
  payload: WidgetRunPayload;
  /** Epoch ms — compared against `refreshSec` per request. */
  computedAt: number;
  /** `EXPLAIN QUERY PLAN` lines per sql source, captured on the FIRST run of this key. */
  plan?: Record<string, string[]>;
  /** Set once a run exceeded `slowQueryMs`; suppresses every later run of this key. */
  paused?: { tookMs: number };
}

// ---------------------------------------------------------------------------
// Canonical JSON + key
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted at every depth, so two structurally identical
 * specs that were built in a different key order hash the same. Arrays keep
 * their order (it is meaningful — transform steps are ordered).
 */
export function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input !== null && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = canonicalize((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WidgetDataService {
  private readonly db: DatabaseLike;
  private readonly now: () => Date;
  private readonly slowQueryMs: number;
  private readonly maxEntries: number;

  /** Insertion-ordered = LRU order; a hit re-inserts to move the entry to the end. */
  private readonly cache = new Map<string, CacheEntry>();
  /** One in-flight promise per key, so concurrent misses run the sources once. */
  private readonly inFlight = new Map<string, Promise<WidgetRunPayload>>();

  constructor(options: WidgetDataServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.slowQueryMs = options.slowQueryMs ?? WIDGET_LIMITS.slowQueryMs;
    this.maxEntries = options.maxEntries ?? 200;
  }

  /**
   * Resolve, cache-check and (on a miss) execute one widget's sources.
   *
   * Throws `invalid_spec:<message>` when the settings cannot be resolved against
   * the spec — that is an authoring error the caller surfaces, not a data
   * failure to cache. Every other failure is per source and rides inside the
   * payload.
   */
  async run(input: WidgetRunInput): Promise<WidgetRunPayload> {
    const resolvedSpec = this.resolveSpec(input);
    const at = this.now();
    const todayIso = at.toISOString().slice(0, 10);
    const key = this.cacheKey(resolvedSpec, input.context.projectId, todayIso);

    const existing = this.cache.get(key);
    if (existing?.paused) {
      return {
        sources: {},
        warnings: [],
        computedAt: new Date(existing.computedAt).toISOString(),
        paused: existing.paused,
      };
    }

    const refreshMs = this.resolveRefreshSec(input.refreshSec, resolvedSpec) * 1000;
    if (existing && at.getTime() - existing.computedAt < refreshMs) {
      this.touch(key, existing);
      return existing.payload;
    }

    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    const promise = Promise.resolve().then(() =>
      this.execute(key, resolvedSpec, input.context.projectId, todayIso, existing),
    );
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Clear the paused mark AND the cached payload for one key, so the next `run`
   * executes for real. This is the Retry button's server half.
   */
  resetBreaker(input: WidgetKeyInput): void {
    const resolvedSpec = this.resolveSpec(input);
    const todayIso = this.now().toISOString().slice(0, 10);
    this.cache.delete(this.cacheKey(resolvedSpec, input.context.projectId, todayIso));
  }

  /** The stored `EXPLAIN QUERY PLAN` lines for one key's sql sources, if any. */
  queryPlan(input: WidgetKeyInput): Record<string, string[]> | undefined {
    const resolvedSpec = this.resolveSpec(input);
    const todayIso = this.now().toISOString().slice(0, 10);
    return this.cache.get(this.cacheKey(resolvedSpec, input.context.projectId, todayIso))?.plan;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveSpec(input: WidgetKeyInput): WidgetSpec {
    const resolved = resolveSpecSettings(input.spec, input.settings);
    if (!resolved.ok) throw new Error(`invalid_spec:${resolved.error}`);
    return resolved.spec;
  }

  private resolveRefreshSec(requested: number | undefined, spec: WidgetSpec): number {
    const raw = requested ?? spec.refreshSec ?? WIDGET_LIMITS.defaultRefreshSec;
    return Math.min(WIDGET_LIMITS.maxRefreshSec, Math.max(WIDGET_LIMITS.minRefreshSec, Math.trunc(raw)));
  }

  private cacheKey(resolvedSpec: WidgetSpec, projectId: number | null, todayIso: string): string {
    return createHash('sha256').update(canonicalJson({ resolvedSpec, projectId, todayIso })).digest('hex');
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /**
   * The readonly sibling handle, or null when this DatabaseLike has no on-disk
   * file (in-memory fixtures). Null makes only the `sql` sources fail, which is
   * strictly better than failing the whole widget.
   */
  private openHandle(): BetterSqlite3Database.Database | null {
    try {
      return openReadonlySibling(this.db);
    } catch {
      return null;
    }
  }

  private execute(
    key: string,
    resolvedSpec: WidgetSpec,
    projectId: number | null,
    todayIso: string,
    previous: CacheEntry | undefined,
  ): WidgetRunPayload {
    const startedAt = Date.now();
    const at = this.now();
    const handle = this.openHandle();
    const result = runWidgetSources({
      resolvedSpec,
      context: { projectId, nowIso: at.toISOString(), todayIso },
      db: this.db,
      handle,
    });

    // The plan is captured ONCE per key: it describes the statement, which by
    // construction cannot change without changing the key.
    let plan = previous?.plan;
    if (plan === undefined && handle) {
      const collected: Record<string, string[]> = {};
      const planContext = { projectId, nowIso: at.toISOString(), todayIso };
      for (const [name, source] of Object.entries(resolvedSpec.sources)) {
        if (source.type !== 'sql') continue;
        try {
          collected[name] = collectQueryPlan(
            handle,
            source.sql,
            coerceBindParams(resolveParamBag(source.params ?? {}, planContext)),
          );
        } catch {
          // Advisory only — a source whose params will not resolve fails on its
          // own in the run above; the plan simply has nothing to say about it.
          collected[name] = [];
        }
      }
      plan = collected;
    }

    const warnings = [...result.warnings];
    const planLines = Object.values(plan ?? {}).flat();
    // No table attribution is claimed — aliases make `SCAN s` common, so the
    // inspector shows the plan lines themselves and this stays generic.
    if (planLines.some((line) => line.includes('SCAN')) && !warnings.includes(FULL_SCAN_WARNING)) {
      warnings.push(FULL_SCAN_WARNING);
    }

    const tookMs = Date.now() - startedAt;
    const computedAt = at.getTime();
    const payload: WidgetRunPayload = {
      sources: result.sources,
      warnings,
      computedAt: new Date(computedAt).toISOString(),
      ...(plan && Object.keys(plan).length > 0 ? { plan } : {}),
    };

    const entry: CacheEntry = {
      payload,
      computedAt,
      ...(plan ? { plan } : {}),
      ...(tookMs > this.slowQueryMs ? { paused: { tookMs } } : {}),
    };
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.evict();

    return entry.paused ? { sources: {}, warnings: [], computedAt: payload.computedAt, paused: entry.paused } : payload;
  }
}
