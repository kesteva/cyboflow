import { type ZodType } from 'zod';

/**
 * Generic Zod-backed validator for IPC handler args.
 *
 * Wraps `schema.safeParse(args)` and returns a discriminated result:
 *   - { ok: true, value }                    — args satisfy the schema
 *   - { ok: false, error: '<channel>: <m>' } — args fail; `<m>` is a Zod-flattened
 *                                               summary that names the failing field
 *
 * The error format is intentionally aligned with the pre-existing hand-rolled
 * helpers (`<channel>: <field> must be a <type>`) so existing tests that match
 * `result.error` against `/projectId/` or `/workflowId/` continue to pass.
 *
 * Canonical use site: main/src/ipc/cyboflow.ts. Hand-rolled validators in
 * main/src/ipc/*.ts are forbidden — extend this helper instead.
 */
export function validateInput<T>(
  schema: ZodType<T>,
  args: unknown,
  channel: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(args);
  if (result.success) return { ok: true, value: result.data };

  // Format the first issue: include the path (field name) and the message.
  // Zod issues for missing/wrong-type fields carry `path: ['projectId']` and
  // a message like 'Expected number, received string'.
  //
  // Special case: when `args` is not an object at all (e.g. `undefined` / `null`),
  // Zod emits a root-level issue with `path: []`. Re-parse with `{}` to surface
  // the first missing field name so the error still names the expected field
  // (e.g. `projectId`) instead of `<root>`.
  let issue = result.error.issues[0];
  if (issue.path.length === 0) {
    const fallback = schema.safeParse({});
    if (!fallback.success && fallback.error.issues[0]?.path.length > 0) {
      issue = fallback.error.issues[0];
    }
  }
  const fieldPath = issue.path.join('.') || '<root>';
  const detail = `${fieldPath} ${issue.message.toLowerCase()}`;
  return { ok: false, error: `${channel}: ${detail}` };
}
