/**
 * verificationAgentQuery — the SDK boundary for the VerificationAgentRunner
 * (docs/proposals/verification-agent-redesign.md §5.4 step 3). This is the ONLY
 * `@anthropic-ai/claude-agent-sdk` caller in the verify/ agent-runner tree (value-
 * loaded lazily via utils/lazyAgentSdk so app boot never parses the SDK), exactly
 * mirroring evalJudgeQuery.ts: keeping the runner itself SDK-free means it stays
 * standalone-typecheckable and fully fakeable in tests (inject a
 * VerificationAgentQueryFn that returns a canned object — no claude subprocess).
 *
 * This is where the IMMUTABLE SANDBOX lives (config shapes persona/judgment, never
 * the sandbox): hermetic settings (`settingSources: []`, `strictMcpConfig: true`,
 * `mcpServers: {}` — an EMPTY MCP scope so every cyboflow-state write stays
 * harness-mediated), the `outputFormat: json_schema` for VerificationReportV1, and
 * the packaged-build `pathToClaudeCodeExecutable`. The runner passes only what it
 * controls (prompt/systemPrompt/cwd/model/allowedTools/env); this file bakes the
 * rest so an edited agent prompt can never widen the sandbox.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 */
import { loadSdkQuery } from '../../utils/lazyAgentSdk';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';
import type { LoggerLike } from '../types';
import type { VerificationAgentQueryFn } from './verificationAgentRunner';

/** Default per-deployment deadline (10 min, §5.4 step 6). The scheduler's per-request deadline is the outer bound. */
export const VERIFICATION_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Turn budget: generous enough to build, serve, drive several UI states, and emit
 * the final structured report. The hard deadline is the real bound.
 */
const VERIFICATION_AGENT_MAX_TURNS = 80;

/**
 * The JSON schema the SDK enforces on the agent's structured output. It nudges the
 * model toward VerificationReportV1; the runner re-validates strictly via
 * `normalizeVerificationReportV1` (never trusting this schema alone).
 */
export const VERIFICATION_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['version', 'behaviors', 'screenshots', 'outcome', 'confidence', 'feedback', 'issues'],
  properties: {
    version: { type: 'integer', enum: [1] },
    behaviors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'result', 'evidence'],
        properties: {
          id: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'not_testable'] },
          evidence: {
            type: 'object',
            required: ['screenshots', 'notes'],
            properties: {
              screenshots: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
            },
          },
        },
      },
    },
    screenshots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fileName', 'caption'],
        properties: { fileName: { type: 'string' }, caption: { type: 'string' } },
      },
    },
    outcome: { type: 'string', enum: ['pass', 'fail', 'build_failed', 'launch_failed'] },
    buildLogExcerpt: { type: 'string' },
    confidence: { type: 'number' },
    feedback: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          description: { type: 'string' },
          fileName: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Bridge a caller's optional AbortSignal onto a fresh AbortController + a deadline
 * timer (mirrors evalJudgeQuery.makeDeadline). Aborting on the caller's signal or
 * the deadline ends the SDK `for await` loop.
 */
function makeDeadline(
  timeoutMs: number,
  signal?: AbortSignal,
): { controller: AbortController; didTimeOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }

  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    controller,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Build the production `VerificationAgentQueryFn`. Deploys ONE structured session
 * with the hermetic sandbox baked in, drains the stream, and returns the last
 * `structured_output` (or null on drain-without-result). On timeout/error it aborts
 * and THROWS — the runner's catch maps a throw to the fail-open `skipped` bucket.
 */
export function makeVerificationAgentQuery(
  logger?: LoggerLike,
  timeoutMs: number = VERIFICATION_AGENT_TIMEOUT_MS,
): VerificationAgentQueryFn {
  return async ({ prompt, systemPrompt, cwd, model, allowedTools, env, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    try {
      const query = await loadSdkQuery();
      const q = query({
        prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          // A STRING systemPrompt is the custom, full-replacement prompt (workflow
          // instructions + the immutable harness contract).
          systemPrompt,
          maxTurns: VERIFICATION_AGENT_MAX_TURNS,
          allowedTools,
          // The agent's Bash inherits these so `$VERIFY_DRIVER` / VERIFY_PORT resolve.
          env: { ...process.env, ...env },
          // Hermetic sandbox — an edited agent prompt cannot widen it.
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          outputFormat: { type: 'json_schema', schema: VERIFICATION_REPORT_JSON_SCHEMA },
          abortController: controller,
        },
      });

      let structured: unknown = null;
      for await (const msg of q) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          structured = msg.structured_output ?? null;
        }
      }
      if (didTimeOut()) throw new Error(`verification agent query timed out after ${timeoutMs}ms`);
      return structured;
    } catch (err) {
      const message = didTimeOut()
        ? `verification agent query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[verificationAgentQuery] structured query failed', { error: message });
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}
