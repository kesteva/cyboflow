/**
 * transcriptNormalizer — the MANDATORY transcript-shape -> stream-json-shape
 * normalizer + noise-filter. This is the SINGLE place IDEA-013 absorbs the
 * proven transcript-vs-wire schema divergence (Probe E: 78.4% of real
 * interactive-transcript lines drop to `{ kind: '__unknown__' }` against
 * `streamParser/schemas.ts`).
 *
 * The on-disk interactive transcript is a DISTINCT schema from the `stream-json`
 * WIRE format `schemas.ts` models. Rather than extend `schemas.ts` /
 * `typedEventNarrowing.ts` into a transcript-event union (explicitly out of scope
 * per the synthesis), this normalizer RESHAPES the panel-critical subset into the
 * wire shape and DROPS everything `narrow()` would otherwise log as unknown — so
 * `narrow()` and the structured Claude panel stay unchanged and `raw_events` is
 * not bloated with `__unknown__` rows.
 *
 * Fixture provenance: line shapes mirror the canonical Probe-E inventory recorded
 * in `docs/probes/IDEA-013-probe-findings.md` (bare-REPL session `efde13c6`,
 * captured 2026-06-01 under `~/.claude/projects/-private-tmp-idea013-probe/`).
 *
 * This module does NOT call `narrow()` — it only reshapes. Narrowing is the S3
 * manager's job (TASK-808). No `any`: parsing uses `unknown` + type guards.
 */

/**
 * Noise top-level `type`s that are unmodeled by `schemas.ts` and carry no panel
 * value (Probe E). Dropped so they never reach `narrow()`.
 */
const NOISE_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
  'last-prompt',
  'mode',
  'permission-mode',
  'bridge-session',
  'attachment',
  'ai-title',
  'file-history-snapshot',
  'queue-operation',
]);

/**
 * `system` subtypes that are unmodeled noise (Probe E). `systemUnionSchema`
 * (schemas.ts) covers only init/compact_boundary/hook_started/hook_response/status
 * — none of which appear interactively — so these are dropped, NOT forwarded.
 */
const NOISE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'local_command',
  'bridge_status',
]);

/**
 * Turn-boundary `system` subtypes (Probe E). Surfaced on a SIDE channel for S3
 * completion; NOT forwarded as panel envelopes (`schemas.ts` does not model them).
 */
const TURN_END_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'stop_hook_summary',
  'turn_duration',
]);

/** Turn-boundary marker forwarded via the turn-end side channel. */
export type TurnEndMarker = 'stop_hook_summary' | 'turn_duration';

/**
 * Result of normalizing one transcript line — a small discriminated union:
 *   - `panel`    : a stream-json-shaped object to forward to `onLine`.
 *   - `turn-end` : a turn-boundary marker for the side channel (NOT a panel event).
 *   - `drop`     : noise / unmappable line; skipped entirely.
 */
export type NormalizeResult =
  | { kind: 'panel'; event: unknown }
  | { kind: 'turn-end'; marker: TurnEndMarker }
  | { kind: 'drop' };

const DROP: NormalizeResult = { kind: 'drop' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map an `assistant` transcript line into the `assistantEventSchema` shape
 * (schemas.ts:164-184). The real transcript line already carries
 * `type:'assistant'` + `message.{id,model,role,content[]}`, so the reshape is a
 * faithful projection of the wire-relevant fields (extra transcript-only keys are
 * dropped by the projection; Zod strips any remaining extras at narrow time).
 * Returns `undefined` if the line is not a well-formed assistant message.
 */
function mapAssistant(line: Record<string, unknown>): unknown | undefined {
  const message = line['message'];
  if (!isRecord(message)) return undefined;
  const id = asString(message['id']);
  const model = asString(message['model']);
  const content = message['content'];
  if (id === undefined || model === undefined || !Array.isArray(content)) {
    return undefined;
  }
  const event: Record<string, unknown> = {
    type: 'assistant',
    message: {
      id,
      model,
      role: 'assistant',
      content,
      ...(isRecord(message['usage']) ? { usage: message['usage'] } : {}),
      ...(message['stop_reason'] !== undefined ? { stop_reason: message['stop_reason'] } : {}),
      ...(message['stop_sequence'] !== undefined ? { stop_sequence: message['stop_sequence'] } : {}),
    },
  };
  // Preserve identifiers the S3 manager needs (camelCase transcript -> snake wire).
  const sessionId = asString(line['session_id']) ?? asString(line['sessionId']);
  if (sessionId !== undefined) event['session_id'] = sessionId;
  const uuid = asString(line['uuid']);
  if (uuid !== undefined) event['uuid'] = uuid;
  return event;
}

/**
 * Map a `user` transcript line into the `userEventSchema` shape
 * (schemas.ts:190-207).
 *
 * Two real forms (Probe E):
 *   - `message.content` is an ARRAY of tool_result blocks -> passes through.
 *   - `message.content` is a STRING (a typed user prompt) -> FAILS
 *     `userEventSchema`'s `z.array(toolResultBlockSchema)` requirement, so it is
 *     WRAPPED into a single synthetic tool_result block (NOT dropped, NOT lost).
 *     The original string is preserved verbatim as that block's `content`.
 * Returns `undefined` if the line is not a well-formed user message.
 */
function mapUser(line: Record<string, unknown>): unknown | undefined {
  const message = line['message'];
  if (!isRecord(message)) return undefined;
  const rawContent = message['content'];

  let content: unknown[];
  if (Array.isArray(rawContent)) {
    // Array tool_result form — already accepted by userEventSchema.
    content = rawContent;
  } else if (typeof rawContent === 'string') {
    // STRING-content user line (Probe E): wrap so it is preserved, not dropped.
    content = [
      {
        type: 'tool_result',
        tool_use_id: asString(line['uuid']) ?? 'transcript-user-text',
        content: rawContent,
      },
    ];
  } else {
    return undefined;
  }

  const event: Record<string, unknown> = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  };
  const sessionId = asString(line['session_id']) ?? asString(line['sessionId']);
  if (sessionId !== undefined) event['session_id'] = sessionId;
  const uuid = asString(line['uuid']);
  if (uuid !== undefined) event['uuid'] = uuid;
  return event;
}

/**
 * Normalize a single parsed transcript line. Pure; NEVER throws. Lines that are
 * neither panel-critical, turn-end, nor explicit noise fail soft to `drop` rather
 * than being forwarded as an `__unknown__` envelope.
 */
export function normalizeTranscriptLine(parsed: unknown): NormalizeResult {
  if (!isRecord(parsed)) return DROP;

  const type = asString(parsed['type']);

  // `attachment` lines carry `type:'attachment'` alongside other keys — covered
  // by the noise set below.
  if (type === undefined) return DROP;

  // ----- Noise top-level types -> drop -----
  if (NOISE_TOP_LEVEL_TYPES.has(type)) return DROP;

  // ----- system: turn-end side channel, noise drop, or (unmodeled) drop -----
  if (type === 'system') {
    const subtype = asString(parsed['subtype']);
    if (subtype !== undefined && TURN_END_SYSTEM_SUBTYPES.has(subtype)) {
      return { kind: 'turn-end', marker: subtype as TurnEndMarker };
    }
    if (subtype !== undefined && NOISE_SYSTEM_SUBTYPES.has(subtype)) return DROP;
    // Every interactive `system` subtype observed is unmodeled (Probe E:
    // init/compact_boundary/hook_started/hook_response/status never appear),
    // so any other system subtype is dropped rather than forwarded.
    return DROP;
  }

  // ----- Panel-critical mapping -----
  if (type === 'assistant') {
    const event = mapAssistant(parsed);
    return event === undefined ? DROP : { kind: 'panel', event };
  }
  if (type === 'user') {
    const event = mapUser(parsed);
    return event === undefined ? DROP : { kind: 'panel', event };
  }

  // ----- Fail-soft: unmodeled / unmappable -> drop (never throw, never unknown) -----
  return DROP;
}
