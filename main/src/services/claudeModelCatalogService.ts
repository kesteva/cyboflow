import * as os from 'os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeModelCatalog, ClaudeModelOption } from '../../../shared/types/agentModels';
import { AGENT_MODEL_ALIASES } from '../../../shared/types/agents';
import { loadSdkQuery } from '../utils/lazyAgentSdk';
import { resolveClaudeExecutablePath } from './panels/claude/claudeExecutablePath';
import { bareModelId, resolveModelAlias } from '../../../shared/agents/modelContext';

/**
 * ClaudeModelCatalogService — the DYNAMIC half of the Claude model picker.
 *
 * The picker leads with four curated, editorially-pinned families (Fable, Opus,
 * Sonnet, Haiku + Auto) whose alias→snapshot mapping is owned deliberately in
 * `modelContext.ts` (so a model bump is a reviewed change, never a silent switch).
 * BELOW those, this service surfaces whatever ELSE the user's login can select,
 * fetched from the bundled Agent SDK's `supportedModels()` control request.
 *
 * Why the SDK control request and not the Models API: `GET /v1/models` needs an
 * Anthropic API credential, which most cyboflow users don't have in-env (the
 * bundled CLI holds its own Claude Code login). `supportedModels()` runs over that
 * SAME login — no key, no keychain extraction — the exact analog of how
 * CodexSdkManager fetches its catalog. The catalog is fetched once per app session
 * and cached; any failure degrades to an empty list (the picker still shows the
 * pinned four).
 *
 * ⚠️ The probe spawns a real (short-lived) SDK session, so — like the other
 * standalone SDK callers (verificationAgentQuery, evalJudgeQuery) — it is NOT
 * live-verifiable headlessly. The pure {@link projectClaudeModelRows} projection
 * (dedupe/exclude/truncate) is unit-tested; the live fetch needs a `pnpm dev` smoke.
 */

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
  debug?(message: string): void;
}

/** The minimal `ModelInfo` shape the projection consumes (structural, SDK-free). */
export interface RawClaudeModelRow {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
}

/** Max dynamic rows kept after excluding the pinned families — keeps the menu short. */
export const CLAUDE_CATALOG_LIMIT = 10;

/** How long the `supportedModels()` probe may run before it is abandoned. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The concrete ids + aliases already covered by the four pinned picker rows, plus
 * the runtime-default sentinels — a dynamic row matching any of these is dropped so
 * the "Other models" section never duplicates a curated one. Derived from the pinned
 * aliases resolved through {@link resolveModelAlias}, so it stays correct across a
 * model bump automatically.
 *
 * BOTH window forms of each pinned id are excluded — the `[1m]`-suffixed spawn id
 * AND its bare snapshot ({@link bareModelId}). A pinned alias that carries a window
 * marker (e.g. `opus` → `claude-opus-5-5[1m]`) would otherwise fail to match the SDK's
 * dynamic row for the same family, which reports the BARE id, and the pinned family
 * would appear a second time under "Other models".
 */
function pinnedExclusionSet(): Set<string> {
  const excluded = new Set<string>(['auto', 'default']);
  for (const alias of AGENT_MODEL_ALIASES) {
    excluded.add(alias.toLowerCase());
    for (const id of [resolveModelAlias(alias), bareModelId(alias)]) {
      if (id) excluded.add(id.toLowerCase());
    }
  }
  return excluded;
}

/**
 * Project raw `ModelInfo` rows into the renderer catalog: drop the pinned families
 * and the auto/default sentinels, de-dupe by canonical wire id (an alias row and its
 * concrete row collapse to one), and truncate to {@link CLAUDE_CATALOG_LIMIT}. Pure
 * and SDK-free so it is unit-testable without a claude subprocess. Input order is
 * preserved (the SDK returns its own most-relevant-first menu order).
 */
export function projectClaudeModelRows(
  rows: readonly RawClaudeModelRow[],
  limit: number = CLAUDE_CATALOG_LIMIT,
): ClaudeModelOption[] {
  const excluded = pinnedExclusionSet();
  const seen = new Set<string>();
  const out: ClaudeModelOption[] = [];
  for (const row of rows) {
    if (!row || typeof row.value !== 'string') continue;
    const value = row.value.trim();
    if (!value) continue;
    const resolved = row.resolvedModel?.trim() || undefined;
    const key = (resolved ?? value).toLowerCase();
    if (excluded.has(value.toLowerCase()) || excluded.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: value,
      ...(resolved ? { resolvedModel: resolved } : {}),
      label: row.displayName?.trim() || value,
      description: row.description?.trim() || '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** A never-yielding, abort-terminated prompt stream: keeps the CLI's stdin open so a
 * control request (supportedModels) can round-trip, WITHOUT sending a user turn. The
 * `await` holds the async iterator suspended (stdin open) until abort, at which point
 * the generator returns (stdin closes). It intentionally never `yield`s — emitting a
 * message would start a turn, which is exactly what a pure catalog read must avoid. */
// eslint-disable-next-line require-yield -- by design: a held-open prompt that emits no user turn
async function* heldOpenPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage, void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export class ClaudeModelCatalogService {
  private cached: ClaudeModelCatalog | null = null;
  private inflight: Promise<ClaudeModelCatalog> | null = null;

  constructor(private readonly logger?: LoggerLike) {}

  /**
   * The dynamic catalog, fetched once and cached for the app session. Concurrent
   * callers (multiple picker mounts / a renderer reload) share one in-flight probe.
   * Never throws — a failed probe resolves to an empty catalog.
   */
  async getCatalog(): Promise<ClaudeModelCatalog> {
    if (this.cached) return this.cached;
    if (!this.inflight) {
      this.inflight = this.fetch()
        .then((catalog) => {
          this.cached = catalog;
          return catalog;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Test-only / recovery: drop the cache so the next getCatalog re-probes. */
  reset(): void {
    this.cached = null;
  }

  private async fetch(): Promise<ClaudeModelCatalog> {
    const rows = await this.probeSupportedModels();
    return { models: projectClaudeModelRows(rows), defaultModel: null };
  }

  private async probeSupportedModels(): Promise<RawClaudeModelRow[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    try {
      const query = await loadSdkQuery();
      const q = query({
        prompt: heldOpenPrompt(controller.signal),
        options: {
          cwd: os.tmpdir(),
          // Hermetic: no project settings, no MCP — this is a pure catalog read.
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          abortController: controller,
        },
      });
      // `supportedModels()` is a control request answered after CLI init, without a
      // turn. Guard: an older SDK / test double may not expose it — fall back to the
      // init result's `models`, else an empty list.
      let rows: unknown = null;
      if (typeof q.supportedModels === 'function') {
        rows = await q.supportedModels();
      } else if (typeof q.initializationResult === 'function') {
        rows = (await q.initializationResult())?.models ?? null;
      }
      return Array.isArray(rows) ? (rows as RawClaudeModelRow[]) : [];
    } catch (err) {
      this.logger?.warn?.(
        `[ClaudeModelCatalog] supportedModels probe failed (${err instanceof Error ? err.message : String(err)}); dynamic list stays empty.`,
      );
      return [];
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
