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
 * harness-mediated), the `outputFormat: json_schema` for VerificationReportV1, the
 * packaged-build `pathToClaudeCodeExecutable`, and the §7.2 dependency-mutation
 * Bash guard (`canUseTool` — see makeDependencyCommandCanUseTool). The runner
 * passes only what it controls (prompt/systemPrompt/cwd/model/allowedTools/env);
 * this file bakes the rest so an edited agent prompt can never widen the sandbox.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 */
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { loadSdkQuery } from '../../utils/lazyAgentSdk';
import type { LoggerLike } from '../types';
import { VerificationAgentQueryError, type VerificationAgentQueryFn } from './verificationAgentRunner';
import { FORBIDDEN_DEP_COMMAND_PATTERN } from './dependencyCommandGuard';

/**
 * Default per-deployment deadline (10 min, §5.4 step 6), used only when the request
 * carries no `timeoutMs`. The scheduler threads its effective per-request deadline
 * (task.timeoutMs capped by its ceiling) through `VerificationAgentQueryArgs.timeoutMs`,
 * so an extended task deadline is honored here instead of being cut to this default.
 */
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
    // OPTIONAL (absent from `required`): the agent's human-facing ECHO of the
    // attestation it ran (§7.1). Shaped strictly — `kind` is the closed
    // AttestationSpec union, so a malformed echo is caught at the SDK boundary
    // rather than in normalization — but never load-bearing: the runner's
    // attestation verdict comes from the DRIVER-written state file, and this
    // field only ever reaches a human reading the verdict.
    attestation: {
      type: 'object',
      required: ['verified', 'kind', 'detail'],
      properties: {
        verified: { type: 'boolean' },
        kind: {
          type: 'string',
          enum: [
            'http-endpoint',
            'dom-marker',
            'cdp-token',
            'window-identity',
            'file-identity',
            'bundle-identity',
          ],
        },
        detail: { type: 'string' },
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

// ---------------------------------------------------------------------------
// Dependency-mutation Bash guard (verification-setup-flow §7.2, "runner guard")
// ---------------------------------------------------------------------------

/**
 * The deny message for a blocked dependency-mutating Bash command.
 *
 * It is written FOR THE AGENT, and every clause is load-bearing. It names the
 * exact command back (the agent composed it, possibly several turns ago, and
 * "denied" without a subject invites a shotgun retry). It states the rule and
 * WHY the rule exists — a snapshot's `node_modules` is a SYMLINK into a shared
 * dependency tree (the live sprint worktree, or the §7.2 prepared-set mirror),
 * so the write is never local to this verification. It closes off the
 * workarounds an agent reliably reaches for next (a different package manager,
 * a `cd` elsewhere, writing into `node_modules` by hand). And it names
 * the sanctioned exit: report `build_failed` carrying this message, which is a
 * DELIVERABLE-honest outcome a human can act on, rather than a green verdict
 * obtained by corrupting three sibling lanes.
 */
export function forbiddenDepCommandDenyMessage(command: string): string {
  return [
    `Blocked: \`${command}\` mutates dependencies.`,
    'Dependency install/rebuild is forbidden inside verification snapshots — deps are prepared and',
    'ABI-rebuilt OUTSIDE the snapshot, so an install here would silently redo that work against the wrong ABI and burn your deadline.',
    'Do not work around it (no alternate package manager, no cd elsewhere, no hand-editing node_modules):',
    'if the deliverable cannot be built without it, report outcome "build_failed" with this message instead.',
  ].join(' ');
}

/**
 * The EXECUTION-TIME half of the §7.2 dependency guard: a `canUseTool` callback
 * that refuses a `Bash` command matching {@link FORBIDDEN_DEP_COMMAND_PATTERN}.
 *
 * WHY IT EXISTS ALONGSIDE THE ENQUEUE CHECK. `enqueueFromTask` already rejects a
 * composed task whose `build`/`serve` carry an install — but that only covers
 * the commands the task DECLARES. The verification agent has an unconstrained
 * Bash tool and, faced with a missing module, will reach for `pnpm install` on
 * its own initiative; no lint or enqueue-time validator can see a command that
 * does not exist until the agent types it. This callback sits where both meet:
 * the shell itself.
 *
 * BOTH LAYERS SHARE ONE PATTERN, deliberately (see dependencyCommandGuard's
 * module doc). A widened pattern must widen both seams at once, or the guard
 * silently stops covering the case someone just discovered.
 *
 * SCOPE, PRECISELY: `Bash` gets the content check on its string `command`; the
 * other members of the verify tool set (Read/Grep/Glob) are allowed untouched;
 * ANY tool outside `allowed` is DENIED. The default-deny matters because a
 * `canUseTool` handler becomes the decision-maker for every non-auto-approved
 * tool: before this handler existed, a Write/Edit attempt died on an
 * unanswerable permission prompt, and a handler that blanket-allowed non-Bash
 * tools would have silently REVOKED that guarantee. (`Options.tools` already
 * hard-restricts availability to the same set — this is the belt to that
 * suspender, so a future mis-wiring of one layer does not widen the sandbox.)
 *
 * INTERACTION WITH `allowedTools`: an allowedTools entry is auto-approved
 * WITHOUT consulting this handler (SDK contract). The query builder therefore
 * passes `allowedTools` MINUS `'Bash'` — read-only tools stay auto-approved,
 * and every shell call routes through here. The runner's
 * `VERIFY_AGENT_ALLOWED_TOOLS` remains the single tool-ceiling source; this
 * seam only splits it into availability (`tools`) vs auto-approval.
 *
 * `updatedInput` is MANDATORY on the allow branch — the CLI Zod-validates the
 * can_use_tool control-response and a bare `{ behavior: 'allow' }` fails as
 * `invalid_union`, reaching the model as an is_error tool_result rather than an
 * approval (see ClaudeCodeManager.makeCanUseTool for the same footgun). Echo the
 * input unchanged. `interrupt` is deliberately NOT set on deny: the agent should
 * keep going and either build without the install or report `build_failed`.
 */
export function makeDependencyCommandCanUseTool(
  allowed: readonly string[],
  logger?: LoggerLike,
): CanUseTool {
  return async (toolName, input) => {
    if (!allowed.includes(toolName)) {
      logger?.warn('[verificationAgentQuery] denied a tool outside the verify set', { toolName });
      return {
        behavior: 'deny',
        message: `The '${toolName}' tool is not part of the verification harness. Use only: ${allowed.join(', ')}. You are JUDGING code, not changing it.`,
      };
    }
    if (toolName.startsWith('mcp__')) {
      // No MCP server is composed into this query today (`mcpServers: {}`), so
      // this arm is inert — it exists so a future grant (the Stage-3 Xcode MCP,
      // docs/proposals/mobile-verification-tier.md §11) lands on an explicit
      // per-call deny-by-default instead of the bare allow below.
      logger?.warn('[verificationAgentQuery] denied an MCP tool — no grant composes one', { toolName });
      return { behavior: 'deny', message: `The '${toolName}' MCP tool is not granted to the verification harness.` };
    }
    if (toolName !== 'Bash') return { behavior: 'allow', updatedInput: input };

    const command = input.command;
    if (typeof command === 'string' && FORBIDDEN_DEP_COMMAND_PATTERN.test(command)) {
      logger?.warn('[verificationAgentQuery] denied a dependency-mutating Bash command', { command });
      return { behavior: 'deny', message: forbiddenDepCommandDenyMessage(command) };
    }
    return { behavior: 'allow', updatedInput: input };
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
 *
 * @param claudeExecutablePath The packaged-build native-binary path resolved once
 * at boot by `resolveClaudeExecutablePath()` (services layer) and threaded in by
 * the wiring site — `undefined` in dev, which lets the SDK resolve it itself.
 */
export function makeVerificationAgentQuery(
  claudeExecutablePath: string | undefined,
  logger?: LoggerLike,
  timeoutMs: number = VERIFICATION_AGENT_TIMEOUT_MS,
): VerificationAgentQueryFn {
  return async ({ prompt, systemPrompt, cwd, model, allowedTools, env, timeoutMs: requestTimeoutMs, signal }) => {
    // The scheduler's effective per-request deadline wins over the module default
    // (adversarial-review fix) — else a task deadline above 10 min is silently cut.
    const effectiveTimeoutMs = requestTimeoutMs ?? timeoutMs;
    const { controller, didTimeOut, cleanup } = makeDeadline(effectiveTimeoutMs, signal);
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
          // HARD availability whitelist (`Options.tools`): tools outside the verify
          // set (Write/Edit/…) do not EXIST for this session. Load-bearing now that
          // a `canUseTool` handler is present: `allowedTools` alone only governs
          // auto-approval, and a permissive handler would otherwise become the
          // decision-maker for tools that used to die on an unanswerable prompt.
          tools: [...allowedTools],
          // Auto-approve ONLY the read-only tools. 'Bash' is deliberately EXCLUDED:
          // an allowedTools entry is auto-approved WITHOUT consulting canUseTool
          // (SDK contract), which would silently bypass the §7.2 dependency guard —
          // every Bash call must route through the handler below instead. Any
          // `mcp__*` name is excluded for the same reason: auto-approving it
          // would bypass the handler's per-call MCP deny arm (inert today).
          allowedTools: allowedTools.filter((t) => t !== 'Bash' && !t.startsWith('mcp__')),
          // The agent's Bash inherits these so `$VERIFY_DRIVER` / VERIFY_PORT resolve.
          env: { ...process.env, ...env },
          // Hermetic sandbox — an edited agent prompt cannot widen it.
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          // §7.2 runner guard: refuse dependency-mutating Bash, default-deny any
          // tool outside the verify set. Composed WITH the hermetic options above
          // (it narrows what the agent may run; it never widens the sandbox), and
          // mutually exclusive with `permissionPromptToolName`, which this file
          // sets nowhere.
          canUseTool: makeDependencyCommandCanUseTool(allowedTools, logger),
          pathToClaudeCodeExecutable: claudeExecutablePath,
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
      if (didTimeOut()) throw new Error(`verification agent query timed out after ${effectiveTimeoutMs}ms`);
      return { structured, transcript: acc.text() };
    } catch (err) {
      const message = didTimeOut()
        ? `verification agent query timed out after ${effectiveTimeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[verificationAgentQuery] structured query failed', { error: message });
      throw new VerificationAgentQueryError(message, acc.text(), didTimeOut());
    } finally {
      cleanup();
    }
  };
}
