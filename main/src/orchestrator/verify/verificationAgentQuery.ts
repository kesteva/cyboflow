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
import { VerificationAgentQueryError, type VerificationAgentQueryFn } from './verificationAgentRunner';

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

// ---------------------------------------------------------------------------
// Transcript accumulator (verifier-transcript capture) — builds a markdown
// transcript of the deployed session from the raw SDK message stream, so a
// wrong verdict is auditable. Structural (duck-typed) guards only: the SDK's
// message/content-block shapes are consulted for reference (assistant.message
// is a BetaMessage, user.message is a MessageParam — see
// @anthropic-ai/claude-agent-sdk / @anthropic-ai/sdk), but this accumulator
// takes `unknown` so it never depends on a specific SDK type-import shape.
// ---------------------------------------------------------------------------

/** Hard ceiling on the total accumulated transcript (chars). */
const TRANSCRIPT_TOTAL_CAP = 400_000;
/** Per-tool_use `input` JSON excerpt cap (chars). */
const TOOL_USE_INPUT_CAP = 600;
/** Per-tool_result text excerpt cap (chars). */
const TOOL_RESULT_CAP = 1_500;

interface TextBlockLike {
  type: 'text';
  text: string;
}

interface ToolUseBlockLike {
  type: 'tool_use';
  name: string;
  input: unknown;
}

interface ToolResultBlockLike {
  type: 'tool_result';
  content?: unknown;
  is_error?: boolean;
}

function isTextBlockLike(b: unknown): b is TextBlockLike {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return o.type === 'text' && typeof o.text === 'string';
}

function isToolUseBlockLike(b: unknown): b is ToolUseBlockLike {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return o.type === 'tool_use' && typeof o.name === 'string';
}

function isToolResultBlockLike(b: unknown): b is ToolResultBlockLike {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return o.type === 'tool_result';
}

/** Render a tool_result's `content` (string or an array of text-ish blocks) as plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isTextBlockLike(c) ? c.text : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

function truncateExcerpt(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The narrow shape `onMessage` inspects — an assistant or user SDK message. */
interface AssistantMessageLike {
  type: 'assistant';
  message: { content?: unknown };
}
interface UserMessageLike {
  type: 'user';
  message: { content?: unknown };
}

function isAssistantMessageLike(msg: unknown): msg is AssistantMessageLike {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'assistant' && !!m.message && typeof m.message === 'object';
}

function isUserMessageLike(msg: unknown): msg is UserMessageLike {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.type === 'user' && !!m.message && typeof m.message === 'object';
}

export interface TranscriptAccumulator {
  /** Feed one raw SDK message; a message type it doesn't recognize is a no-op. */
  onMessage(msg: unknown): void;
  /** The accumulated markdown transcript, or null when nothing was accumulated. */
  text(): string | null;
}

/**
 * Build a fresh markdown-transcript accumulator for one deployed session.
 * Assistant `text` blocks are appended verbatim; `tool_use` blocks render as a
 * fenced JSON excerpt of the tool name + input; a user message's `tool_result`
 * blocks render as a fenced text excerpt (labeled as an error when
 * `is_error`). Once the running total would exceed {@link TRANSCRIPT_TOTAL_CAP},
 * further content is dropped and a single truncation marker line is appended.
 */
export function createTranscriptAccumulator(): TranscriptAccumulator {
  const lines: string[] = [];
  let total = 0;
  let truncated = false;

  function push(line: string): void {
    if (truncated) return;
    if (total + line.length > TRANSCRIPT_TOTAL_CAP) {
      lines.push(`\n[transcript truncated at ${TRANSCRIPT_TOTAL_CAP} chars]\n`);
      truncated = true;
      return;
    }
    lines.push(line);
    total += line.length;
  }

  return {
    onMessage(msg: unknown): void {
      if (truncated) return;
      if (isAssistantMessageLike(msg)) {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (isTextBlockLike(block)) {
            push(block.text);
          } else if (isToolUseBlockLike(block)) {
            const inputJson = truncateExcerpt(JSON.stringify(block.input), TOOL_USE_INPUT_CAP);
            push(`\n**Tool: ${block.name}**\n\`\`\`json\n${inputJson}\n\`\`\`\n`);
          }
        }
      } else if (isUserMessageLike(msg)) {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!isToolResultBlockLike(block)) continue;
          const label = block.is_error ? 'Tool error result' : 'Tool result';
          const text = truncateExcerpt(toolResultText(block.content), TOOL_RESULT_CAP);
          push(`\n${label}:\n\`\`\`\n${text}\n\`\`\`\n`);
        }
      }
    },
    text(): string | null {
      return lines.length > 0 ? lines.join('') : null;
    },
  };
}

/**
 * Build the production `VerificationAgentQueryFn`. Deploys ONE structured session
 * with the hermetic sandbox baked in, drains the stream (feeding every message to
 * a fresh {@link createTranscriptAccumulator}), and returns the last
 * `structured_output` (or null on drain-without-result) PLUS the accumulated
 * transcript. On timeout/error it aborts and THROWS a {@link
 * VerificationAgentQueryError} carrying whatever transcript accumulated before
 * the failure — the runner's catch writes that partial transcript (fail-soft)
 * before mapping the throw to the fail-open `skipped` bucket.
 */
export function makeVerificationAgentQuery(
  logger?: LoggerLike,
  timeoutMs: number = VERIFICATION_AGENT_TIMEOUT_MS,
): VerificationAgentQueryFn {
  return async ({ prompt, systemPrompt, cwd, model, allowedTools, env, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    const acc = createTranscriptAccumulator();
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
        acc.onMessage(msg);
        if (msg.type === 'result' && msg.subtype === 'success') {
          structured = msg.structured_output ?? null;
        }
      }
      if (didTimeOut()) throw new Error(`verification agent query timed out after ${timeoutMs}ms`);
      return { structured, transcript: acc.text() };
    } catch (err) {
      const message = didTimeOut()
        ? `verification agent query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[verificationAgentQuery] structured query failed', { error: message });
      throw new VerificationAgentQueryError(message, acc.text());
    } finally {
      cleanup();
    }
  };
}
