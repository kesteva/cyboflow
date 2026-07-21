/**
 * Lazy loader for `@anthropic-ai/claude-agent-sdk`'s `query`.
 *
 * The SDK entry is a single pre-bundled ~1 MB CJS file costing ~50 ms to parse
 * warm (worse on a cold filesystem cache). Five modules call `query()` and all
 * of them sit on the app-boot import graph (claudeCodeManager via services
 * wiring; vlmJudge, monitorQuery, evalJudgeQuery, pairwiseJudgeQuery via
 * index.ts), so a top-level import anywhere makes every app boot pay that parse
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

type SdkQuery = typeof query;

let cachedQuery: Promise<SdkQuery> | undefined;

export function loadSdkQuery(): Promise<SdkQuery> {
  if (!cachedQuery) {
    cachedQuery = import('@anthropic-ai/claude-agent-sdk').then((sdk) => sdk.query);
  }
  return cachedQuery;
}
