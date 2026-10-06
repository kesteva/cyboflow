/**
 * Lazy loader for `@anthropic-ai/claude-agent-sdk`'s `query`.
 *
 * The SDK entry is a single pre-bundled ~1 MB CJS file costing ~50 ms to parse
 * warm (worse on a cold filesystem cache). The modules that call `query()` all
 * sit on the app-boot import graph (claudeCodeManager via services wiring;
 * monitorQuery, evalJudgeQuery, pairwiseJudgeQuery via index.ts), so a top-level import anywhere makes every app boot pay that parse
 * before the window shows. Routing every call site through this helper defers
 * the parse to the first real SDK query, where it is imperceptible next to the
 * subprocess spawn.
 *
 * Type-only imports of the SDK remain fine anywhere — they are erased at
 * compile time. Only VALUE imports (`import { query } …`) belong here.
 *
 * Under vitest, `vi.mock('@anthropic-ai/claude-agent-sdk')` intercepts the
 * dynamic import exactly like a static one, so the fakeSdk harness and the
 * per-file mocks keep working unchanged.
 */
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { assertAgentProviderAllowed } from '../../../shared/agents/agentProviderGuard';
import { tryGetProviderUsageStore } from '../services/providerUsage/providerUsageStore';
import type { RateLimitEvent } from '../../../shared/types/claudeStream';

type SdkQuery = typeof query;

let cachedQuery: Promise<SdkQuery> | undefined;

/**
 * Tee every SDK message stream so `rate_limit_event` readings reach the
 * ProviderUsageStore, which feeds the subscription-usage meters in the Human
 * review queue.
 *
 * WHY HERE and not at the managers' EventRouters: this function is the app's
 * single Claude SDK seam (see the guard rationale below), so one tap covers chat
 * turns, both eval judges, the programmatic monitor, verification agents, the
 * runbook drafter, the VLM judge, the session summariser, and the model
 * catalogue. Attaching per-manager would have missed every one of the
 * non-chat callers, and the interactive substrate cannot help either — its
 * transcript normalizer drops every top-level type except assistant/user.
 *
 * WHY A PROXY and not a wrapping generator: `Query` is an AsyncGenerator that
 * ALSO carries control methods, and `claudeModelCatalogService` feature-detects
 * `supportedModels` / `initializationResult` — replacing the object with a plain
 * generator would silently empty the model catalogue forever, with no error and
 * no failing test. The proxy forwards every property, binding methods to the
 * real target so private-field access resolves.
 *
 * Finalization: the tee is `for await`-based, so `return()`/`throw()` propagate
 * to the underlying generator by construction. That matters — `claudeCodeManager`
 * breaks out of the loop on abort and every judge ends on a deadline, and a
 * swallowed finalization would regress subprocess teardown.
 */
function isRateLimitMessage(
  message: unknown,
): message is RateLimitEvent {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return record.type === 'rate_limit_event'
    && typeof record.rate_limit_info === 'object'
    && record.rate_limit_info !== null;
}

function observeMessage(message: unknown): void {
  // Telemetry must never break a turn: a throw here would propagate out of the
  // caller's `for await`.
  try {
    if (!isRateLimitMessage(message)) return;
    tryGetProviderUsageStore()?.recordClaudeRateLimit(message.rate_limit_info);
  } catch {
    // Ignored by design — see above.
  }
}

function withUsageTee(realQuery: SdkQuery): SdkQuery {
  const wrapped = (...args: Parameters<SdkQuery>): ReturnType<SdkQuery> => {
    const q = realQuery(...args);
    return new Proxy(q, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) {
          return function tee(): AsyncGenerator<unknown> {
            return (async function* () {
              for await (const message of target) {
                observeMessage(message);
                yield message;
              }
            })();
          };
        }
        // `target` as the receiver, not the proxy: an unbound method invoked
        // with `this === proxy` throws on private-field access.
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return wrapped as SdkQuery;
}

/**
 * Resolve the SDK's `query`, refusing when the Claude provider is switched off
 * in Settings → Integrations.
 *
 * This is the app's CALL-LEVEL Claude guard: every `query()` caller resolves the
 * function through here on EVERY call (the cached module promise is reused, the
 * assert is not), so the check covers a follow-up turn in an already-open chat —
 * which never re-enters a launch seam — as well as the judges, the programmatic
 * monitor, verification agents, the VLM judge, and the model catalogue.
 *
 * Throwing (rather than returning a no-op query) is deliberate: callers already
 * handle a rejected SDK load, and a silent no-op would look like a hung turn.
 */
export function loadSdkQuery(): Promise<SdkQuery> {
  assertAgentProviderAllowed('claude', 'Claude agent calls');
  if (!cachedQuery) {
    // The wrap lives INSIDE the cached `.then()` deliberately: `loadSdkQuery`
    // itself must stay a plain function whose guard throws SYNCHRONOUSLY (see
    // agentProviderGuard.test.ts), so it cannot become `async`.
    cachedQuery = import('@anthropic-ai/claude-agent-sdk').then((sdk) => withUsageTee(sdk.query));
  }
  return cachedQuery;
}
