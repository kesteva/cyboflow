/**
 * sdkContract — the anti-drift KEYSTONE for the shared fakeSdk fixture.
 *
 * fakeSdk's builders stand in for real `@anthropic-ai/claude-agent-sdk` `query()`
 * output across the whole main-process test suite. If they drift from the real SDK
 * (a message shape changes) or from the production narrowing layer (a builder starts
 * producing `{kind:'__unknown__'}`), every SDK-touching integration test silently
 * loses fidelity. This test converts that silent drift into a loud, readable failure:
 *
 *   1. ASSIGNABILITY (compile-time) — every builder output is assignable to the real
 *      `SDKMessage` union. This is already enforced by the `satisfies` clauses inside
 *      fakeSdk, but the typed const below makes a regression a NAMED test whose file
 *      also fails `tsc` (the CI gate), not just an anonymous type error.
 *   2. NARROW-ACCEPTANCE (runtime) — each representative builder event, run through a
 *      fresh real `TypedEventNarrowing`, narrows to its EXPECTED wire kind and never to
 *      the `{kind:'__unknown__'}` fallback. (The narrowing fail-softs to `__unknown__`;
 *      a builder landing there means the fake no longer matches what production parses.)
 *   3. VERSION + DISCRIMINANT PIN — the INSTALLED SDK version is compared to a committed
 *      pin; a bump fails loudly telling a human to re-verify the builders + narrowing
 *      against the new SDK. The set of `type`/`subtype` discriminants the builders cover
 *      is snapshotted too, so a new event kind (or a dropped builder) is at least visible
 *      when someone regenerates the fixture.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  sdkSystemInit,
  sdkAssistantText,
  sdkAssistantToolUse,
  sdkUserToolResult,
  sdkPermissionDenied,
  sdkResultSuccess,
  sdkResultError,
} from '../fakeSdk';
import { TypedEventNarrowing } from '../../../../../shared/streamParser/typedEventNarrowing';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Committed pins — UPDATE these deliberately when regenerating the fixture.
// ---------------------------------------------------------------------------

/**
 * The `@anthropic-ai/claude-agent-sdk` version the fakeSdk builders were verified against.
 *
 * 0.3.201 → 0.3.224 re-verification: the `SDKMessage` union gained exactly one variant,
 * `SDKBackgroundTasksChangedMessage` (`system/background_tasks_changed`), and dropped none.
 * cyboflow does not model that kind, so it fail-softs to `{kind:'__unknown__'}` like
 * `system/permission_denied` already does — no new builder, so `EXPECTED_DISCRIMINANTS`
 * is unchanged. (Production DOES consume the other background-task signals —
 * task_started / task_updated / task_notification, see claudeCodeManager — so add a
 * builder here only if it starts consuming `background_tasks_changed` specifically.)
 *
 * A TYPE-level pass is not a CONTRACT-level pass, and this pin only enforces the former.
 * The same 0.3.224 diff carried two semantic changes that compiled clean and shipped
 * broken: `origin` inverted its default (absent stopped meaning "human"), and
 * `CanUseTool` gained an optional `matchedAskRule` a host-side auto-approver is
 * obliged to honor. When this tripwire fires, read the changed d.ts CONTRACT TEXT for
 * the host callbacks too — do not stop at the `SDKMessage` union.
 *
 * 0.3.224 → 0.3.257 re-verification (bumped to reach a bundled CLI new enough for
 * `claude-fable-5-1`; 2.1.224 answered a Fable 5.1 turn with a hard 400 reading
 * "does not support this model; version 2.1.251 or newer is required"):
 *   - `SDKMessage` union: UNCHANGED — zero variants added, zero dropped, so
 *     `EXPECTED_DISCRIMINANTS` needs no edit.
 *   - Host callbacks `CanUseTool`, `PermissionResult`, `Options`, `SDKMessageOrigin`:
 *     byte-identical. The class of breakage this tripwire exists to catch is absent.
 *   - REMOVED: `ExitReason`/`EXIT_REASONS` dropped `'bypass_permissions_disabled'`.
 *     cyboflow never referenced it (grep-verified), so no arm went dead.
 *   - Additive only, none of it implemented here: `PreModelSwitch`/`PostModelSwitch`
 *     hook events, `SDKContextUsage`, `SDKMcpResourceLink`, `usage.thinkingTokens`,
 *     `costBasis`, a widened `ApiKeySource`, and `requestId` + a `| null` return on
 *     the elicitation / userDialog callbacks (cyboflow implements neither — its
 *     `elicitation` hits are the unrelated Codex app-server protocol).
 *
 * 0.3.257 → 0.3.280 re-verification (bumped to reach a bundled CLI, 2.1.280, new
 * enough for `claude-opus-5-5`):
 *   - `SDKMessage` union, `CanUseTool`, `PermissionResult`, `SDKMessageOrigin`
 *     declarations: UNCHANGED, so `EXPECTED_DISCRIMINANTS` needs no edit.
 *   - `CanUseTool`'s options object gained three optional, additive fields:
 *     `mcpServer` (provenance of an `mcp__*` tool), `defaultToNo` (open the prompt
 *     on decline, no one-key approve) and `suppressAlwaysAllowRule` (offer no
 *     persistent "don't ask again"). cyboflow never writes `updatedPermissions`,
 *     so the last is already honored; the other two are advisory for the
 *     approval UI and not consumed here.
 *   - `SDKAssistantMessageError` gained `'verification_required'` and
 *     `'cloud_credential_error'`; the error arm reads it as a bare string and only
 *     special-cases `'authentication_failed'`, so both render as generic errors.
 *   - Additive only, none of it used: `Options.permissionPrompts`,
 *     `Options.pluginDelivery`, `verbatimPrompts`, `omitClaudeMd` on agent defs,
 *     and new control requests (hooks listing, permission rules, MCP resource
 *     read, reload output styles).
 */
const PINNED_SDK_VERSION = '0.3.280';

/**
 * The `type` (or `type/subtype`) discriminants every fakeSdk builder emits, sorted.
 * A new builder, a dropped builder, or a builder whose discriminant shifts changes this
 * set — the snapshot assertion below turns that into a visible, reviewable diff.
 */
const EXPECTED_DISCRIMINANTS: readonly string[] = [
  'assistant',
  'result/error_during_execution',
  'result/success',
  'system/init',
  'system/permission_denied',
  'user',
];

const PIN_FILE = 'main/src/test/fakes/__tests__/sdkContract.test.ts';

// ---------------------------------------------------------------------------
// Fixtures — one representative event per builder.
//
// This array's `: readonly SDKMessage[]` annotation is the compile-time
// assignability assertion: if any builder output stops matching the real
// `SDKMessage` union, this file fails to compile (and thus fails `tsc` in CI).
// ---------------------------------------------------------------------------

const ALL_BUILDER_OUTPUTS: readonly SDKMessage[] = [
  sdkSystemInit(),
  sdkAssistantText('hello world'),
  sdkAssistantToolUse('cyboflow_create_task', { title: 'x' }),
  sdkUserToolResult('toolu_1', 'ok'),
  sdkPermissionDenied({ toolName: 'Bash' }),
  sdkResultSuccess(),
  sdkResultError(),
];

/**
 * The builders whose events the streamParser is responsible for narrowing, each with
 * the wire kind it MUST narrow to. `sdkPermissionDenied` is intentionally excluded —
 * `system/permission_denied` is NOT part of `ClaudeStreamEvent` (the manager folds it
 * into the review inbox directly, it is never rendered from a narrowed stream event) —
 * and is guarded by its own test below.
 */
const NARROWABLE: ReadonlyArray<{
  readonly name: string;
  readonly event: SDKMessage;
  readonly expected: string;
}> = [
  { name: 'sdkSystemInit', event: sdkSystemInit(), expected: 'system/init' },
  { name: 'sdkAssistantText', event: sdkAssistantText('hi'), expected: 'assistant' },
  {
    name: 'sdkAssistantToolUse',
    event: sdkAssistantToolUse('cyboflow_create_task', { title: 'x' }),
    expected: 'assistant',
  },
  { name: 'sdkUserToolResult', event: sdkUserToolResult('toolu_1', 'ok'), expected: 'user' },
  { name: 'sdkResultSuccess', event: sdkResultSuccess(), expected: 'result/success' },
  {
    name: 'sdkResultError',
    event: sdkResultError(),
    expected: 'result/error_during_execution',
  },
];

// ---------------------------------------------------------------------------
// Discriminant helpers.
// ---------------------------------------------------------------------------

/** `type` or `type/subtype` for a raw SDK message (pre-narrow). */
function messageDiscriminant(message: SDKMessage): string {
  const record = message as { readonly type: string; readonly subtype?: unknown };
  return typeof record.subtype === 'string' ? `${record.type}/${record.subtype}` : record.type;
}

/** `type`/`type/subtype` for a narrowed event, or `'__unknown__'` for the fallback. */
function narrowedDiscriminant(event: ClaudeStreamEvent): string {
  if ('kind' in event) return event.kind; // UnknownStreamEvent — the fail-soft fallback.
  const subtype = (event as { readonly subtype?: unknown }).subtype;
  return typeof subtype === 'string' ? `${event.type}/${subtype}` : event.type;
}

// ---------------------------------------------------------------------------
// SDK version resolution.
//
// The SDK's `package.json` subpath is not exported, so we resolve the package
// ENTRY and walk up to the owning `package.json` (matching by `name`). Never
// hardcode the node_modules path — the parent repo's install may relocate it.
// ---------------------------------------------------------------------------

function resolveInstalledSdkVersion(): string {
  const require = createRequire(__filename);
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
  let dir = dirname(entry);
  for (let hops = 0; hops < 12; hops++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === '@anthropic-ai/claude-agent-sdk' && typeof parsed.version === 'string') {
        return parsed.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not resolve the installed @anthropic-ai/claude-agent-sdk version (entry: ${entry})`,
  );
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('sdkContract — fakeSdk builders vs the real SDK + narrowing', () => {
  it('every fakeSdk builder output is assignable to the real SDKMessage union', () => {
    // Compile-time: `ALL_BUILDER_OUTPUTS: readonly SDKMessage[]` above enforces
    // assignability. Runtime: sanity-check each carries a wire `type` discriminant.
    expect(ALL_BUILDER_OUTPUTS.length).toBeGreaterThan(0);
    for (const message of ALL_BUILDER_OUTPUTS) {
      expect(typeof (message as { type?: unknown }).type).toBe('string');
    }
  });

  it.each(NARROWABLE)(
    '$name narrows to $expected and never to __unknown__',
    ({ event, expected }) => {
      // Fresh instance per case; pass a logger so the fail-soft path is observable.
      const narrowing = new TypedEventNarrowing({ verbose: () => undefined });
      const narrowed = narrowing.narrow(event);
      const discriminant = narrowedDiscriminant(narrowed);
      expect(discriminant).not.toBe('__unknown__');
      expect(discriminant).toBe(expected);
    },
  );

  it('sdkPermissionDenied is intentionally NOT modeled by the streamParser (manager-handled)', () => {
    // system/permission_denied is not a ClaudeStreamEvent variant — the manager folds it
    // into the review inbox directly. If this ever starts narrowing, the schema gained a
    // permission_denied branch and this contract must be revisited (add it to NARROWABLE).
    const narrowing = new TypedEventNarrowing({ verbose: () => undefined });
    const narrowed = narrowing.narrow(sdkPermissionDenied({ toolName: 'Bash' }));
    expect(narrowedDiscriminant(narrowed)).toBe('__unknown__');
  });

  it('the builder discriminant snapshot matches the committed set', () => {
    const covered = [...new Set(ALL_BUILDER_OUTPUTS.map(messageDiscriminant))].sort();
    expect(covered).toEqual([...EXPECTED_DISCRIMINANTS]);
  });

  it('the installed SDK version matches the committed pin', () => {
    const installed = resolveInstalledSdkVersion();
    const coveredSnapshot = [...new Set(ALL_BUILDER_OUTPUTS.map(messageDiscriminant))]
      .sort()
      .join(', ');
    expect(
      installed,
      `SDK version changed (pinned ${PINNED_SDK_VERSION}, installed ${installed}) — ` +
        `re-verify fakeSdk builders + narrowing against the new SDK, then update the pin ` +
        `in ${PIN_FILE}. Discriminants the builders currently cover: [${coveredSnapshot}].`,
    ).toBe(PINNED_SDK_VERSION);
  });
});
