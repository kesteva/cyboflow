/**
 * One tool, declared once.
 *
 * Before this registry a `cyboflow_*` tool lived in three hand-maintained
 * places — a JSON Schema literal in the ListTools reply, a `case` arm that
 * re-typechecked the same fields by hand and built the socket envelope, and the
 * `McpQueryMessage` union member the main process reads — with nothing tying
 * them together. `defineTool` collapses the first two onto one zod schema and,
 * more importantly, TYPECHECKS the third: `toEnvelope` must return exactly
 * {@link EnvelopeParams} for the envelope the entry names.
 *
 * That last part closes a real hole. The envelope crosses the orch socket as
 * JSON and is re-typed by a blind `parsed as McpQueryMessage` cast
 * (orchSocketServer.ts), so before this a mis-renamed camelCase key — say
 * `taskId` written as `task_id` — compiled, shipped, and arrived at the handler
 * as `undefined`. Now it is a build error at the definition site.
 *
 * The import of `McpQueryMessage` is TYPE-ONLY on purpose: this module is
 * bundled into the standalone MCP subprocess by scripts/bundle-mcp-server.mjs,
 * and a value import of mcpQueryHandler would drag the entire main process
 * (electron, better-sqlite3, the services layer) in with it.
 */
import type { z } from 'zod';
import type { McpQueryMessage } from '../mcpQueryHandler';
import { toInputSchema, describeIssue, type JsonSchemaObject } from './toolSchema';

/** Every envelope `type` string the orch socket carries. */
export type McpEnvelopeType = McpQueryMessage['type'];

/**
 * The envelope fields a tool supplies: everything on the union member except
 * the three the transport stamps itself (`sendQuery` adds `requestId`, `runId`
 * and the bearer `token`).
 */
export type EnvelopeParams<T extends McpEnvelopeType> = Omit<
  Extract<McpQueryMessage, { type: T }>,
  'type' | 'requestId' | 'runId'
>;

/**
 * Per-field override for the `invalid_arguments` `expected` string, for the
 * few phrasings {@link describeIssue} cannot derive from the schema alone.
 * Keyed by the FIRST path segment of the failing issue; the function form sees
 * the whole issue so a nested failure can read differently from a top-level one
 * (cyboflow_request_user_input distinguishes them).
 */
export type ExpectedOverrides = Readonly<Record<string, string | ((issue: z.ZodIssue) => string)>>;

export type PrepareResult =
  | { readonly ok: true; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly expected: string };

/**
 * A tool after erasure — what the dispatcher and the ratchet see. The generic
 * relationship between schema and envelope is enforced at the definition site
 * by {@link defineTool}; keeping it out of this type is what lets the three
 * scope tables be plain arrays.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  /** Derived from `input` once, at module load. */
  readonly inputSchema: JsonSchemaObject;
  /**
   * The envelope forwarded over the orch socket, or null for a tool served
   * inside the subprocess (cyboflow_reference reads a compiled-in content
   * module — there is nothing to fetch). A null here requires a matching
   * entry in the server's local-tool table; the ratchet asserts the pairing.
   */
  readonly envelope: McpEnvelopeType | null;
  /**
   * Transport budget override. `null` means WAIT FOREVER, and it is not the
   * same as omitting the field: omitting it takes `sendQuery`'s 30-second
   * default, which would cap a human question gate that legitimately blocks for
   * days. Bounded instead by the process exiting when its spawner dies.
   */
  readonly timeoutMs?: number | null;
  /** Validate raw MCP arguments and map them to the envelope's params. */
  readonly prepare: (raw: unknown) => PrepareResult;
}

interface ToolDefinition<T extends McpEnvelopeType | null, S extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly envelope: T;
  readonly toEnvelope: (args: z.output<S>) => T extends McpEnvelopeType
    ? EnvelopeParams<T>
    : Record<string, unknown>;
  readonly expected?: ExpectedOverrides;
  readonly timeoutMs?: number | null;
}

/**
 * Drop keys whose value is `undefined` so the emitted envelope matches what the
 * hand-written arms built with their `if (x !== undefined)` guards. JSON
 * serialization would drop them anyway; doing it here keeps the intent legible
 * and keeps a `toEnvelope` free to spread optionals unconditionally.
 */
export function compact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function defineTool<T extends McpEnvelopeType | null, S extends z.ZodType>(
  definition: ToolDefinition<T, S>,
): RegisteredTool {
  const inputSchema = toInputSchema(definition.input);
  const { input, expected, toEnvelope } = definition;

  return {
    name: definition.name,
    description: definition.description,
    inputSchema,
    envelope: definition.envelope,
    ...(definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {}),
    prepare(raw: unknown): PrepareResult {
      const parsed = input.safeParse(raw ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue === undefined) return { ok: false, expected: 'valid arguments' };
        const override = expected?.[String(issue.path[0] ?? '')];
        if (typeof override === 'function') return { ok: false, expected: override(issue) };
        if (typeof override === 'string') return { ok: false, expected: override };
        return { ok: false, expected: describeIssue(input, issue) };
      }
      return { ok: true, params: compact(toEnvelope(parsed.data as z.output<S>)) };
    },
  };
}
