/**
 * usageFold — the ONE per-run usage fold behind every token/cost rollup
 * (docs/proposals/codex-workflow-efficiency.md §5.2, 1b/1c).
 *
 * `scanRawEventRollups`, the materialized tier's per-model read, and
 * `selectDailyModelUsage` all fold a run's ordered raw_events usage rows through
 * {@link foldRunUsage}, so the run totals, the per-model split and the daily
 * buckets cannot drift apart: every token the fold counts is recorded as a
 * (day, model) contribution, and the totals are the sum of those contributions.
 *
 * Token sources under the current version ({@link ACCOUNTING_VERSION}) — each
 * token comes from exactly one:
 *   - Claude outer agent: `result.usage`, per query.
 *   - Claude Task children: per SDK process segment, Δ(Σ `modelUsage`) −
 *     `result.usage`, per token type (see {@link ClaudeChildSegment}).
 *   - provider `agent_result` (Codex root thread, OMP, pi): its `usage`.
 *   - Codex descendant / unattributed / top-up `subagent_usage` rows
 *     (`codex-` dedup keys).
 *   - any other `subagent_usage` producer except Claude dynamic workflows:
 *     counted, as the legacy fold did.
 * `assistant` rows are never a token source for a CLOSED query: the SDK stores
 * one row per content block, each repeating the message's usage. Deduplicated by
 * (session_id, message.id), the parentless ones give the outer message count and
 * the outer's per-model split; parented ones (forwarded sub-agent messages) and
 * Claude dynamic-workflow `subagent:` rows are model attribution only —
 * `modelUsage` already contains that work. The one exception: parentless
 * messages after their session's last result (a query still open) count as
 * provisional outer tokens until that query's result supersedes them.
 *
 * Runs whose materialized `run_usage.accounting_version` predates the current one
 * keep the LEGACY fold (the pre-v1 rules, reproduced verbatim below), so an
 * un-backfilled run is never re-counted under the new rules.
 *
 * Standalone-typecheck invariant (mirrors insightsQueries.ts): no imports from
 * 'electron', 'better-sqlite3', 'fs', or any concrete service.
 */
import type { LoggerLike } from './types';
import type { UsageCoverage } from '../../../shared/types/insights';
import { USAGE_COVERAGE_LEVELS } from '../../../shared/types/insights';
import { PROCESS_INSTANCE_ID_FIELD } from '../../../shared/streamParser/rawEventsSink';

/** The current usage accounting version, stored in `run_usage.accounting_version`. */
export const ACCOUNTING_VERSION = 1;

/** Which rules fold a run: the current version's, or the pre-v1 legacy fold. */
export type UsageFoldMode = 'current' | 'legacy';

/**
 * The fold mode for a run given its materialized `accounting_version` (null =
 * no `run_usage` row yet). Only a row written by an older fold keeps the legacy
 * rules; a run with no row is always folded under the current version.
 */
export function usageFoldModeForVersion(version: number | null | undefined): UsageFoldMode {
  return typeof version === 'number' && version < ACCOUNTING_VERSION ? 'legacy' : 'current';
}

/** The most severe of two coverage levels (see USAGE_COVERAGE_LEVELS' order). */
export function mostSevereCoverage(a: UsageCoverage, b: UsageCoverage): UsageCoverage {
  return USAGE_COVERAGE_LEVELS.indexOf(a) >= USAGE_COVERAGE_LEVELS.indexOf(b) ? a : b;
}

/** raw_events event types the fold reads. */
export const USAGE_FOLD_EVENT_TYPES = [
  'assistant',
  'agent_assistant',
  'subagent_usage',
  'result',
  'agent_result',
] as const;

/** One raw_events row, in (run_id, id) order. */
export interface UsageFoldRow {
  id: number;
  eventType: string;
  payloadJson: string;
  dedupKey: string | null;
  createdAt: string;
  /**
   * Optional caller tag carried onto every contribution this row produces (the
   * daily chart marks rows inside its window). Absent ⇒ true.
   */
  inWindow?: boolean;
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Tokens and outer messages attributed to one (day, model), from rows sharing one `inWindow` tag. */
export interface UsageContribution extends UsageTokens {
  /** UTC day, 'YYYY-MM-DD' — the first 10 chars of the source row's created_at. */
  day: string;
  model: string;
  assistantMessageCount: number;
  inWindow: boolean;
}

export interface RunUsageFold extends UsageTokens {
  totalTokens: number;
  costUsd: number | null;
  numTurns: number | null;
  assistantMessageCount: number;
  /** The run's sole reported model id; null when none or several (see multiModel). */
  model: string | null;
  multiModel: boolean;
  perModel: Map<string, UsageTokens>;
  contributions: UsageContribution[];
  accountingVersion: number;
  coverage: UsageCoverage;
}

export interface UsageFoldOptions {
  mode: UsageFoldMode;
  /**
   * Model label for provider-result tokens whose rows name no model (Codex/OMP
   * report turn usage on `agent_result`, which carries none). `provider` is the
   * row's own `provider` field, or null when it has none. Absent ⇒ 'unknown'.
   */
  fallbackModelLabel?: (provider: string | null) => string;
  /** Receives the fold's diagnostics (claude_child_delta_negative, …). */
  logger?: Pick<LoggerLike, 'warn'>;
  /** Diagnostics context only. */
  runId?: string;
}

/** Model id used when a usage source names none. */
export const UNKNOWN_MODEL = 'unknown';

/** Separator for composite map keys; never appears in a day slice or a session id prefix. */
const KEY_SEP = '\u0000';

/**
 * A large outer gap: Σ deduplicated parentless message usage differs from
 * Σ result.usage by more than this share of the latter (and by more than
 * OUTER_MISMATCH_MIN_TOKENS) — logged as `claude_outer_mismatch`.
 */
const OUTER_MISMATCH_RATIO = 0.2;
const OUTER_MISMATCH_MIN_TOKENS = 1000;

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function zeroTokens(): UsageTokens {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function tokenSum(t: UsageTokens): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
}

function addTokens(target: UsageTokens, add: UsageTokens): void {
  for (const f of TOKEN_FIELDS) target[f] += add[f];
}

/** A snake_case SDK `usage` object → UsageTokens (each field optional). */
function snakeUsageTokens(usage: Record<string, unknown>): UsageTokens {
  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
  };
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Read the model id from legacy SDK or provider-neutral assistant payloads. */
function assistantEventModel(eventType: string, payload: Record<string, unknown>): unknown {
  if (isRecord(payload.message)) return payload.message.model;
  return eventType === 'agent_assistant' ? payload.model : undefined;
}

/**
 * Per-model bucket key — 'unknown' when the event carried none. Unlike
 * {@link recordRunModel} this does NOT skip 'unknown'/blank: the per-model split
 * conserves the full token total across its buckets.
 */
function bucketModelId(eventType: string, payload: Record<string, unknown>): string {
  return nonBlankString(assistantEventModel(eventType, payload)) ?? UNKNOWN_MODEL;
}

/**
 * Fold one reported model id into an exact-one-vs-many run resolution. The
 * 'unknown' sentinel (dynamic subagent usage when model discovery fails) and
 * blank strings are not model identities and are skipped — folding them in would
 * flip a single-model run to multiModel and suppress the computed-cost path.
 */
function recordRunModel(target: { model: string | null; multiModel: boolean }, value: unknown): void {
  if (typeof value !== 'string' || target.multiModel) return;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === UNKNOWN_MODEL) return;
  if (target.model === null) {
    target.model = trimmed;
  } else if (target.model !== trimmed) {
    target.model = null;
    target.multiModel = true;
  }
}

/**
 * Split `total` across keys in proportion to `weights`, in whole tokens, so the
 * parts sum to exactly `total` (largest remainder). Every weight must be ≥ 0 and
 * at least one positive.
 */
function apportion(total: number, weights: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  let weightSum = 0;
  for (const w of weights.values()) weightSum += w;
  if (total === 0 || weightSum <= 0) {
    for (const key of weights.keys()) out.set(key, 0);
    return out;
  }
  const remainders: Array<{ key: string; frac: number }> = [];
  let assigned = 0;
  for (const [key, w] of weights) {
    const exact = (total * w) / weightSum;
    const whole = Math.floor(exact);
    out.set(key, whole);
    assigned += whole;
    remainders.push({ key, frac: exact - whole });
  }
  remainders.sort((a, b) => b.frac - a.frac);
  for (let i = 0; assigned < total && remainders.length > 0; i = (i + 1) % remainders.length) {
    const key = remainders[i].key;
    out.set(key, (out.get(key) ?? 0) + 1);
    assigned += 1;
  }
  return out;
}

/** Split per-type tokens across models by one weight map (see apportion). */
function apportionTokens(tokens: UsageTokens, weights: ReadonlyMap<string, number>): Map<string, UsageTokens> {
  const out = new Map<string, UsageTokens>();
  for (const key of weights.keys()) out.set(key, zeroTokens());
  for (const f of TOKEN_FIELDS) {
    for (const [key, part] of apportion(tokens[f], weights)) {
      const t = out.get(key);
      if (t !== undefined) t[f] = part;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contribution ledger — totals, per-model and daily views of the same tokens
// ---------------------------------------------------------------------------

class ContributionLedger {
  readonly totals: UsageTokens = zeroTokens();
  assistantMessageCount = 0;
  readonly perModel = new Map<string, UsageTokens>();
  private readonly byKey = new Map<string, UsageContribution>();

  /**
   * Record tokens and/or outer messages for one (row, model). `inPerModel`
   * false keeps them out of the per-model split (the legacy fold never
   * attributed its result-usage fallback to a model).
   */
  add(row: UsageFoldRow, model: string, tokens: UsageTokens, messages: number, inPerModel = true): void {
    const hasTokens = tokenSum(tokens) > 0;
    if (!hasTokens && messages === 0) return;
    addTokens(this.totals, tokens);
    this.assistantMessageCount += messages;
    if (inPerModel && hasTokens) {
      const bucket = this.perModel.get(model) ?? zeroTokens();
      addTokens(bucket, tokens);
      this.perModel.set(model, bucket);
    }
    const day = row.createdAt.slice(0, 10);
    const inWindow = row.inWindow ?? true;
    const key = `${day}${KEY_SEP}${model}${KEY_SEP}${inWindow ? 1 : 0}`;
    const c = this.byKey.get(key) ?? { day, model, inWindow, assistantMessageCount: 0, ...zeroTokens() };
    addTokens(c, tokens);
    c.assistantMessageCount += messages;
    this.byKey.set(key, c);
  }

  contributions(): UsageContribution[] {
    return Array.from(this.byKey.values());
  }
}

// ---------------------------------------------------------------------------
// Cost ladder (moved verbatim from insightsQueries.scanRawEventRollups)
// ---------------------------------------------------------------------------

/** Per-segment cost-ladder state. */
interface CostLadderSegment {
  /** This segment's most recently observed `total_cost_usd`. */
  lastCost: number;
  /** This segment's running max `total_cost_usd` — flushed into costUsd when the segment ends. */
  segMaxCost: number;
  /**
   * This segment's most recently observed `Σ modelUsage[*].outputTokens` —
   * null until a result carries a COMPLETE counter set (see
   * resultModelUsageOutputTokens), so an unavailable total can never be
   * mistaken for a total of zero.
   */
  lastOutTotal: number | null;
  /** True when keyed by a recorded process id: the segment is exact, never split by the heuristics. */
  exact: boolean;
}

/**
 * Σ `modelUsage[*].outputTokens` for a `result` payload (camelCase SDK field,
 * cumulative per process), or null when the counters are NOT comparable:
 * `modelUsage` absent / not an object / empty, or any model entry without a
 * finite `outputTokens`. Null must stay distinct from 0 — an empty
 * `modelUsage` (the SDK fixtures emit one) folded to 0 would satisfy the
 * ladder's "total grew by less than this query's output" test on EVERY result
 * and restore the per-result overcount the ladder exists to remove.
 */
function resultModelUsageOutputTokens(payload: Record<string, unknown>): number | null {
  const modelUsage = payload.modelUsage;
  if (!isRecord(modelUsage)) return null;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return null;
  let total = 0;
  for (const modelData of entries) {
    if (!isRecord(modelData)) return null;
    const outputTokens = modelData.outputTokens;
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return null;
    total += outputTokens;
  }
  return total;
}

/**
 * `costUsd` folding. `result.total_cost_usd` is CUMULATIVE PER SDK PROCESS, so
 * for `result` payloads carrying a string `session_id` we LADDER instead of sum:
 * per segment track `lastCost`, `segMaxCost` (running max — a result can
 * occasionally under-report vs. the previous one without a real restart) and
 * `lastOutTotal` (the most recent comparable `Σ modelUsage[*].outputTokens`). A
 * segment is the (session_id, process id) pair when the result carries a
 * recorded `cyboflow_process_instance_id` — exact, a new id opens a new segment.
 * Without one it is the session_id, and a result starts a NEW segment when
 * EITHER `cost < lastCost` (equal costs stay — never double count) OR the
 * cumulative-output-token invariant breaks: `outTotal < lastOutTotal +
 * usage.output_tokens` (a continuing process's output total always grows by at
 * least this query's output; a restarted process fails that unless the old
 * segment was smaller than this query's tokens, the conservative direction). The
 * token test only runs when both `modelUsage` and `usage.output_tokens` are
 * finite on this row. On a new segment `segMaxCost` is flushed into costUsd and
 * the segment resets; otherwise `segMaxCost = max(segMaxCost, cost)`. Open
 * segments flush at the end. `agent_result` (OMP's per-turn cost) and any
 * `result` without a string `session_id` keep a plain SUM.
 */
class CostLadder {
  private costUsd: number | null = null;
  private readonly segments = new Map<string, CostLadderSegment>();

  add(eventType: string, payload: Record<string, unknown>, processId: string | null): void {
    const hasFiniteCost = typeof payload.total_cost_usd === 'number' && Number.isFinite(payload.total_cost_usd);
    if (!hasFiniteCost) return;
    const cost = payload.total_cost_usd as number;
    if (eventType !== 'result' || typeof payload.session_id !== 'string') {
      // agent_result (OMP's per-turn cost), or a `result` with no string
      // session_id: unchanged SUM behavior.
      this.costUsd = (this.costUsd ?? 0) + cost;
      return;
    }
    const segmentKey = processId === null ? `s${KEY_SEP}${payload.session_id}` : `p${KEY_SEP}${payload.session_id}${KEY_SEP}${processId}`;
    const resultUsage = payload.usage;
    const hasOutputTokensField =
      isRecord(resultUsage) && typeof resultUsage.output_tokens === 'number' && Number.isFinite(resultUsage.output_tokens);
    // null ⇒ this result's counters are not comparable; the token test is
    // skipped for it and the segment's last comparable total is kept (the
    // invariant still holds across a skipped result because the counter is
    // cumulative).
    const outTotal = resultModelUsageOutputTokens(payload);
    const outputTokensThisResult = hasOutputTokensField ? ((resultUsage as Record<string, unknown>).output_tokens as number) : 0;

    const segment = this.segments.get(segmentKey);
    if (segment === undefined) {
      // First result ever seen for this segment — open it; nothing to flush.
      this.segments.set(segmentKey, { lastCost: cost, segMaxCost: cost, lastOutTotal: outTotal, exact: processId !== null });
      return;
    }
    const isNewSegment =
      !segment.exact &&
      (cost < segment.lastCost ||
        (outTotal !== null &&
          segment.lastOutTotal !== null &&
          hasOutputTokensField &&
          outTotal < segment.lastOutTotal + outputTokensThisResult));
    if (isNewSegment) {
      this.costUsd = (this.costUsd ?? 0) + segment.segMaxCost;
      this.segments.set(segmentKey, { lastCost: cost, segMaxCost: cost, lastOutTotal: outTotal, exact: false });
    } else {
      segment.lastCost = cost;
      segment.segMaxCost = Math.max(segment.segMaxCost, cost);
      if (outTotal !== null) segment.lastOutTotal = outTotal;
    }
  }

  /** Flush every still-open segment (the last process never hits a boundary). */
  finish(): number | null {
    let total = this.costUsd;
    for (const segment of this.segments.values()) total = (total ?? 0) + segment.segMaxCost;
    return total;
  }
}

// ---------------------------------------------------------------------------
// Claude child tokens — per process segment
// ---------------------------------------------------------------------------

/** One SDK process's last comparable `modelUsage` reading. */
interface ClaudeChildSegment {
  /** The last reading, per model; empty at a segment's start (the first reading counts from zero). */
  prev: Map<string, UsageTokens>;
  /** Outer (result.usage) tokens of results since the last reading that carried no modelUsage, per model. */
  pendingOuter: Map<string, UsageTokens>;
  /** Last finite total_cost_usd — an inferred-segment boundary signal. */
  lastCost: number | null;
}

/** Parse `result.modelUsage` (camelCase, cumulative per process) → per-model tokens; null when absent/empty/malformed. */
function parseModelUsage(payload: Record<string, unknown>): Map<string, UsageTokens> | null {
  const modelUsage = payload.modelUsage;
  if (!isRecord(modelUsage)) return null;
  const out = new Map<string, UsageTokens>();
  for (const [model, data] of Object.entries(modelUsage)) {
    if (!isRecord(data)) return null;
    // Keys can carry a context suffix ('claude-opus-5-5[1m]'); `canonicalModel`
    // is the id assistant messages report, so the outer and child splits share a bucket.
    const key = nonBlankString(data.canonicalModel) ?? nonBlankString(model) ?? UNKNOWN_MODEL;
    const tokens = out.get(key) ?? zeroTokens();
    addTokens(tokens, {
      inputTokens: asNumber(data.inputTokens),
      outputTokens: asNumber(data.outputTokens),
      cacheReadTokens: asNumber(data.cacheReadInputTokens),
      cacheCreationTokens: asNumber(data.cacheCreationInputTokens),
    });
    out.set(key, tokens);
  }
  return out.size === 0 ? null : out;
}

/** The model with the largest token total in a reading; null for none. */
function dominantModel(reading: ReadonlyMap<string, UsageTokens> | null): string | null {
  let best: string | null = null;
  let bestSum = -1;
  for (const [model, tokens] of reading ?? []) {
    const sum = tokenSum(tokens);
    if (sum > bestSum) {
      best = model;
      bestSum = sum;
    }
  }
  return best;
}

function sumModelTokens(map: ReadonlyMap<string, UsageTokens>): UsageTokens {
  const total = zeroTokens();
  for (const t of map.values()) addTokens(total, t);
  return total;
}

/**
 * Whether a result WITHOUT a recorded process id starts a new inferred segment:
 * the cost went down, any per-model counter went down, or Σ modelUsage grew by
 * less than the outer usage consumed since the last reading (a continuing
 * process's cumulative counters include every outer query it ran).
 */
function isInferredSegmentBoundary(
  segment: ClaudeChildSegment,
  cost: number | null,
  cur: ReadonlyMap<string, UsageTokens> | null,
  outerSinceReading: UsageTokens,
): boolean {
  if (cost !== null && segment.lastCost !== null && cost < segment.lastCost) return true;
  if (cur === null || segment.prev.size === 0) return false;
  for (const [model, prev] of segment.prev) {
    const now = cur.get(model) ?? zeroTokens();
    if (TOKEN_FIELDS.some((f) => now[f] < prev[f])) return true;
  }
  return tokenSum(sumModelTokens(cur)) < tokenSum(sumModelTokens(segment.prev)) + tokenSum(outerSinceReading);
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Fold one run's usage rows (ordered by raw_events id) into its rollup. Rows of
 * other event types are ignored; malformed JSON is skipped silently.
 */
export function foldRunUsage(rows: readonly UsageFoldRow[], options: UsageFoldOptions): RunUsageFold {
  return options.mode === 'legacy' ? foldLegacy(rows, options) : foldCurrent(rows, options);
}

function parsePayload(row: UsageFoldRow): Record<string, unknown> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return null;
  }
  return isRecord(payload) ? payload : null;
}

function addNumTurns(current: number | null, payload: Record<string, unknown>): number | null {
  return typeof payload.num_turns === 'number' && Number.isFinite(payload.num_turns)
    ? (current ?? 0) + payload.num_turns
    : current;
}

function processIdOf(payload: Record<string, unknown>): string | null {
  return nonBlankString(payload[PROCESS_INSTANCE_ID_FIELD]);
}

function finishFold(
  ledger: ContributionLedger,
  resolution: { model: string | null; multiModel: boolean },
  costUsd: number | null,
  numTurns: number | null,
  accountingVersion: number,
  coverage: UsageCoverage,
): RunUsageFold {
  return {
    ...ledger.totals,
    totalTokens: ledger.totals.inputTokens + ledger.totals.outputTokens,
    costUsd,
    numTurns,
    assistantMessageCount: ledger.assistantMessageCount,
    model: resolution.model,
    multiModel: resolution.multiModel,
    perModel: ledger.perModel,
    contributions: ledger.contributions(),
    accountingVersion,
    coverage,
  };
}

/**
 * The pre-v1 fold, unchanged: assistant-side rows (`assistant`,
 * `agent_assistant`, `subagent_usage`) are the token source; `result` /
 * `agent_result` usage is a fallback used only when the run reported no
 * assistant message usage at all (and is then labelled by `fallbackModelLabel`
 * for the daily chart, but never enters the per-model split).
 */
function foldLegacy(rows: readonly UsageFoldRow[], options: UsageFoldOptions): RunUsageFold {
  const ledger = new ContributionLedger();
  const resolution = { model: null as string | null, multiModel: false };
  const ladder = new CostLadder();
  let numTurns: number | null = null;
  const fallback: Array<{ row: UsageFoldRow; tokens: UsageTokens }> = [];

  for (const row of rows) {
    const payload = parsePayload(row);
    if (payload === null) continue;
    if (row.eventType === 'assistant' || row.eventType === 'agent_assistant' || row.eventType === 'subagent_usage') {
      recordRunModel(resolution, assistantEventModel(row.eventType, payload));
      const message = payload.message;
      if (!isRecord(message) || !isRecord(message.usage)) continue;
      ledger.add(
        row,
        bucketModelId(row.eventType, payload),
        snakeUsageTokens(message.usage),
        row.eventType === 'subagent_usage' ? 0 : 1,
      );
    } else if (row.eventType === 'result' || row.eventType === 'agent_result') {
      numTurns = addNumTurns(numTurns, payload);
      ladder.add(row.eventType, payload, processIdOf(payload));
      if (isRecord(payload.usage)) fallback.push({ row, tokens: snakeUsageTokens(payload.usage) });
    }
  }

  if (ledger.assistantMessageCount === 0 && fallback.length > 0) {
    // Add instead of replace so a provider whose PRIMARY usage arrives only on
    // agent_result keeps any independently captured subagent snapshots.
    const label = options.fallbackModelLabel?.(null) ?? UNKNOWN_MODEL;
    for (const { row, tokens } of fallback) ledger.add(row, label, tokens, 1, false);
  }
  return finishFold(ledger, resolution, ladder.finish(), numTurns, 0, 'legacy');
}

/** A deduplicated parentless assistant message awaiting its query's result. */
interface OuterMessage {
  model: string;
  usage: UsageTokens;
  /** The message's first row — where provisional usage lands (see foldCurrent's end). */
  row: UsageFoldRow;
}

function foldCurrent(rows: readonly UsageFoldRow[], options: UsageFoldOptions): RunUsageFold {
  const ledger = new ContributionLedger();
  const resolution = { model: null as string | null, multiModel: false };
  const ladder = new CostLadder();
  const warn = (event: string, context: Record<string, unknown>): void => {
    options.logger?.warn(`[usageFold] ${event}`, { event, runId: options.runId, ...context });
  };
  let numTurns: number | null = null;
  let coverage: UsageCoverage = 'complete';

  // (session_id, message.id) keys already counted — each message once.
  const seenMessages = new Set<string>();
  // Parentless messages since the session's previous result, keyed by dedup key
  // so a later content-block row refreshes the message's (final) usage.
  const outerWindow = new Map<string, Map<string, OuterMessage>>();
  const lastOuterModel = new Map<string, string>();
  const lastAgentModel = new Map<string, string>();
  const childSegments = new Map<string, ClaudeChildSegment>();
  const outerMessageUsage = zeroTokens();
  const outerResultUsage = zeroTokens();
  let unkeyedMessages = 0;

  for (const row of rows) {
    const payload = parsePayload(row);
    if (payload === null) continue;
    const session = typeof payload.session_id === 'string' ? payload.session_id : '';

    if (row.eventType === 'assistant') {
      recordRunModel(resolution, assistantEventModel(row.eventType, payload));
      const message = payload.message;
      if (!isRecord(message)) continue;
      const parent = payload.parent_tool_use_id;
      if (typeof parent === 'string' && parent !== '') continue; // forwarded sub-agent message: attribution only
      const messageId = nonBlankString(message.id);
      const key = messageId === null ? `#${unkeyedMessages++}` : `${session}${KEY_SEP}${messageId}`;
      const usage = isRecord(message.usage) ? snakeUsageTokens(message.usage) : null;
      const model = bucketModelId(row.eventType, payload);
      // Counted once, on the first row that carries usage (a message without a
      // usage object is not counted, as in the legacy fold).
      if (usage !== null && !seenMessages.has(key)) {
        seenMessages.add(key);
        ledger.add(row, model, zeroTokens(), 1);
      }
      const window = outerWindow.get(session) ?? new Map<string, OuterMessage>();
      const existing = window.get(key);
      if (existing === undefined) {
        window.set(key, { model, usage: usage ?? zeroTokens(), row });
      } else if (usage !== null) {
        existing.usage = usage;
      }
      outerWindow.set(session, window);
      continue;
    }

    if (row.eventType === 'agent_assistant') {
      recordRunModel(resolution, assistantEventModel(row.eventType, payload));
      const model = nonBlankString(payload.model);
      if (model !== null) lastAgentModel.set(nonBlankString(payload.provider) ?? '', model);
      continue;
    }

    if (row.eventType === 'subagent_usage') {
      recordRunModel(resolution, assistantEventModel(row.eventType, payload));
      const key = row.dedupKey ?? '';
      // Claude dynamic-workflow snapshots ran inside the parent SDK process, so
      // its modelUsage already holds them: attribution only.
      if (key.startsWith('subagent:')) continue;
      const message = payload.message;
      if (!isRecord(message) || !isRecord(message.usage)) continue;
      if (key.startsWith('codex-subagent-run:')) coverage = mostSevereCoverage(coverage, 'codex-run-level');
      if (key.startsWith('codex-') && payload.model_inferred === true) {
        coverage = mostSevereCoverage(coverage, 'codex-model-inferred');
      }
      ledger.add(row, bucketModelId(row.eventType, payload), snakeUsageTokens(message.usage), 0);
      continue;
    }

    if (row.eventType === 'agent_result') {
      numTurns = addNumTurns(numTurns, payload);
      ladder.add(row.eventType, payload, null);
      if (!isRecord(payload.usage)) continue;
      const provider = nonBlankString(payload.provider);
      const model =
        lastAgentModel.get(provider ?? '') ??
        options.fallbackModelLabel?.(provider) ??
        UNKNOWN_MODEL;
      ledger.add(row, model, snakeUsageTokens(payload.usage), 1);
      continue;
    }

    if (row.eventType !== 'result') continue;

    // --- Claude result: outer tokens + the Task-child delta ---
    numTurns = addNumTurns(numTurns, payload);
    const processId = processIdOf(payload);
    ladder.add(row.eventType, payload, processId);
    const outer = isRecord(payload.usage) ? snakeUsageTokens(payload.usage) : zeroTokens();
    addTokens(outerResultUsage, outer);
    const cost =
      typeof payload.total_cost_usd === 'number' && Number.isFinite(payload.total_cost_usd)
        ? payload.total_cost_usd
        : null;
    const cur = parseModelUsage(payload);

    // Outer per-model split: the parentless messages of this query (rows that
    // carried no session_id wait under '').
    const windowKey = outerWindow.has(session) ? session : '';
    const window = outerWindow.get(windowKey);
    outerWindow.delete(windowKey);
    const weights = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const m of window?.values() ?? []) {
      addTokens(outerMessageUsage, m.usage);
      weights.set(m.model, (weights.get(m.model) ?? 0) + tokenSum(m.usage));
      counts.set(m.model, (counts.get(m.model) ?? 0) + 1);
    }
    let weightTotal = 0;
    for (const w of weights.values()) weightTotal += w;
    // Messages without usage still name the model; weigh by count then.
    let outerWeights: Map<string, number> = weightTotal > 0 ? weights : counts;
    if (outerWeights.size === 0) {
      const fallbackModel =
        lastOuterModel.get(session) ??
        dominantModel(cur) ??
        options.fallbackModelLabel?.(nonBlankString(payload.provider)) ??
        UNKNOWN_MODEL;
      outerWeights = new Map([[fallbackModel, 1]]);
    } else {
      let dominant: string | null = null;
      for (const [model, w] of outerWeights) {
        if (dominant === null || w > (outerWeights.get(dominant) ?? 0)) dominant = model;
      }
      if (dominant !== null) lastOuterModel.set(session, dominant);
    }
    const outerByModel = apportionTokens(outer, outerWeights);
    for (const [model, tokens] of outerByModel) ledger.add(row, model, tokens, 0);

    // Child tokens, per process segment.
    let segmentKey: string;
    let segment: ClaudeChildSegment | undefined;
    if (processId !== null) {
      segmentKey = `p${KEY_SEP}${session}${KEY_SEP}${processId}`;
      segment = childSegments.get(segmentKey);
    } else {
      coverage = mostSevereCoverage(coverage, 'claude-segments-inferred');
      segmentKey = `s${KEY_SEP}${session}`;
      segment = childSegments.get(segmentKey);
      const outerSinceReading = sumModelTokens(segment?.pendingOuter ?? new Map());
      addTokens(outerSinceReading, outer);
      if (segment !== undefined && isInferredSegmentBoundary(segment, cost, cur, outerSinceReading)) {
        segment = undefined;
      }
    }
    if (segment === undefined) {
      segment = { prev: new Map(), pendingOuter: new Map(), lastCost: null };
      childSegments.set(segmentKey, segment);
    }
    if (cost !== null) segment.lastCost = cost;

    for (const [model, tokens] of outerByModel) {
      const pending = segment.pendingOuter.get(model) ?? zeroTokens();
      addTokens(pending, tokens);
      segment.pendingOuter.set(model, pending);
    }
    if (cur === null) {
      warn('claude_model_usage_missing', { rowId: row.id, sessionId: session || null });
      continue;
    }

    // Δ per model since the segment's last reading (first reading counts from zero).
    const delta = new Map<string, UsageTokens>();
    for (const [model, now] of cur) {
      const prev = segment.prev.get(model) ?? zeroTokens();
      const d = zeroTokens();
      for (const f of TOKEN_FIELDS) d[f] = Math.max(0, now[f] - prev[f]);
      delta.set(model, d);
    }
    const deltaTotal = sumModelTokens(delta);
    const outerTotal = sumModelTokens(segment.pendingOuter);
    const child = zeroTokens();
    const negative: Partial<Record<(typeof TOKEN_FIELDS)[number], number>> = {};
    for (const f of TOKEN_FIELDS) {
      const value = deltaTotal[f] - outerTotal[f];
      if (value < 0) negative[f] = value;
      child[f] = Math.max(0, value);
    }
    if (Object.keys(negative).length > 0) {
      warn('claude_child_delta_negative', { rowId: row.id, sessionId: session || null, negative });
    }

    // Child per-model split: each model's Δ minus the outer tokens attributed to
    // it, normalized so the parts sum to the child total exactly.
    if (tokenSum(child) > 0) {
      for (const f of TOKEN_FIELDS) {
        if (child[f] === 0) continue;
        const raw = new Map<string, number>();
        let rawSum = 0;
        for (const [model, d] of delta) {
          const v = Math.max(0, d[f] - (segment.pendingOuter.get(model)?.[f] ?? 0));
          raw.set(model, v);
          rawSum += v;
        }
        const w = rawSum > 0 ? raw : new Map(Array.from(delta, ([model, d]) => [model, d[f]]));
        for (const [model, part] of apportion(child[f], w)) {
          if (part === 0) continue;
          // A child model appears in no parentless message: it is a model the
          // run used, so it counts toward model cardinality (the computed-cost path).
          recordRunModel(resolution, model);
          const tokens = zeroTokens();
          tokens[f] = part;
          ledger.add(row, model, tokens, 0);
        }
      }
    }
    segment.prev = cur;
    segment.pendingOuter = new Map();
  }

  // Provisional outer tokens: parentless messages after their session's last
  // result belong to a query still open (a programmatic step is one long query),
  // so without them an in-flight run reads 0 for minutes. The query's result
  // supersedes them when it lands (the window is consumed above), so no closed
  // query keeps any; a run that died mid-query keeps its open query's usage.
  for (const window of outerWindow.values()) {
    for (const m of window.values()) ledger.add(m.row, m.model, m.usage, 0);
  }

  const outerMessageTotal = tokenSum(outerMessageUsage);
  const outerResultTotal = tokenSum(outerResultUsage);
  if (outerMessageTotal > 0 && outerResultTotal > 0) {
    const gap = Math.abs(outerMessageTotal - outerResultTotal);
    if (gap > OUTER_MISMATCH_MIN_TOKENS && gap > outerResultTotal * OUTER_MISMATCH_RATIO) {
      warn('claude_outer_mismatch', { messageTokens: outerMessageTotal, resultTokens: outerResultTotal });
    }
  }

  return finishFold(ledger, resolution, ladder.finish(), numTurns, ACCOUNTING_VERSION, coverage);
}
