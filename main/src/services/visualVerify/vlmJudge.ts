/**
 * VlmJudge — the orthogonal "Rung 4" of layered visual verification
 * (docs/visual-verification-design.md §6). A STATELESS Claude vision call applied
 * after whichever capture rung produced PNGs: it is shown the screenshots + the
 * acceptance `intent` and returns a structured VerdictV1
 * (pass | fail | low_confidence). Below the configured confidence threshold the
 * verdict is forced to 'low_confidence' (a human review_item), and on ANY error
 * it fails SOFT to 'low_confidence' with the error in `feedback` — it NEVER
 * fabricates a pass/fail.
 *
 * SDK boundary, mirroring main/src/orchestrator/programmatic/monitorQuery.ts: the
 * only `@anthropic-ai/claude-agent-sdk` importer here. The model + executable path
 * are injected so the call is isolated and fully fakeable (tests pass a mocked
 * `runQuery` and never touch the network). Images are read from artifactsDir and
 * sent inline as base64 image blocks via the async-iterable prompt, so judging
 * does not depend on the model deciding to call Read.
 *
 * Lives under main/src/services/* — MAY import electron/SDK code; the scheduler
 * injects it as a VlmJudge and never imports it (standalone-typecheck invariant).
 */
import { readFile } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../../orchestrator/types';
import type {
  VerdictV1,
  VerificationType,
  VlmJudge as VlmJudgeInterface,
} from '../../../../shared/types/visualVerification';
import { resolveClaudeExecutablePath } from '../panels/claude/claudeExecutablePath';

/** Default vision-capable model for the judge (current Opus). */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-4-8';

/** Default confidence floor: below this, pass/fail is demoted to low_confidence. */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** Hard deadline for one judge call. A hung binary must not wedge a request. */
export const JUDGE_QUERY_TIMEOUT_MS = 120_000;

/** Max PNGs shown to the model in one call (cap input tokens / cost). */
const MAX_IMAGES = 6;

/** The base64 image media types the Anthropic message content accepts. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Media types capturePage/playwright/peekaboo can emit, keyed by extension. */
const MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * The JSON schema the judge's structured output must satisfy. Mirrors VerdictV1
 * minus the fields this module fills in itself (judgedFileNames, baselineUsed,
 * model) — those are deterministic, not model-decided.
 */
const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'low_confidence'] },
    confidence: { type: 'number' },
    feedback: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          description: { type: 'string' },
          fileName: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
  },
  required: ['status', 'confidence', 'feedback', 'issues'],
};

/**
 * The injected one-shot query function — the SDK seam. Returns the structured
 * output object the model produced (or null if it drained without one). Tests
 * pass a fake; production passes `makeSdkVisionQuery`.
 */
export interface VisionQueryFn {
  (args: {
    prompt: AsyncIterable<SDKUserMessage>;
    schema: Record<string, unknown>;
    model: string;
    signal: AbortSignal;
  }): Promise<unknown>;
}

/** Options for constructing a VlmJudgeImpl. */
export interface VlmJudgeOptions {
  /** Vision model id. Default DEFAULT_JUDGE_MODEL. */
  model?: string;
  /** Confidence floor. Default DEFAULT_CONFIDENCE_THRESHOLD. */
  confidenceThreshold?: number;
  /** Injected query seam. Default makeSdkVisionQuery(). */
  runQuery?: VisionQueryFn;
  logger?: LoggerLike;
}

/** Build a fail-soft low_confidence verdict (never fabricates pass/fail). */
function lowConfidence(
  feedback: string,
  judgedFileNames: string[],
  model: string,
  baselineUsed: boolean,
): VerdictV1 {
  return {
    status: 'low_confidence',
    confidence: 0,
    issues: [],
    feedback,
    judgedFileNames,
    baselineUsed,
    model,
  };
}

/** Narrow an unknown structured-output value into the model-decided verdict fields. */
function parseModelVerdict(
  raw: unknown,
): {
  status: 'pass' | 'fail' | 'low_confidence';
  confidence: number;
  feedback: string;
  issues: VerdictV1['issues'];
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const status = obj.status;
  if (status !== 'pass' && status !== 'fail' && status !== 'low_confidence') return null;

  const confidenceRaw = obj.confidence;
  if (typeof confidenceRaw !== 'number' || Number.isNaN(confidenceRaw)) return null;
  // Clamp to [0,1] — the model occasionally reports 0–100 or slightly out of range.
  const confidence = confidenceRaw > 1 ? Math.min(confidenceRaw / 100, 1) : Math.max(confidenceRaw, 0);

  const feedback = typeof obj.feedback === 'string' ? obj.feedback : '';

  const issues: VerdictV1['issues'] = [];
  if (Array.isArray(obj.issues)) {
    for (const it of obj.issues) {
      if (typeof it !== 'object' || it === null) continue;
      const i = it as Record<string, unknown>;
      const severity = i.severity;
      if (severity !== 'low' && severity !== 'medium' && severity !== 'high') continue;
      const description = typeof i.description === 'string' ? i.description : '';
      const fileName = typeof i.fileName === 'string' ? i.fileName : undefined;
      issues.push(fileName ? { severity, description, fileName } : { severity, description });
    }
  }

  return { status, confidence, feedback, issues };
}

/** Build the natural-language instruction shown alongside the screenshots. */
function buildInstruction(intent: string, type: VerificationType, baselineUsed: boolean): string {
  return [
    'You are a meticulous visual-QA judge. You are shown one or more screenshots of a',
    `rendered deliverable (verification type: ${type}).`,
    '',
    'ACCEPTANCE INTENT (what the deliverable must satisfy):',
    intent,
    '',
    baselineUsed
      ? 'A golden baseline image is also provided; compare the deliverable against it AND the intent.'
      : 'No baseline is provided; judge purely against the intent.',
    '',
    'Return a JSON verdict with:',
    '- status: "pass" if the screenshots clearly satisfy the intent, "fail" if they clearly do not,',
    '  "low_confidence" if you genuinely cannot tell.',
    '- confidence: your certainty 0..1.',
    '- feedback: a concise explanation a developer can act on.',
    '- issues: an array of {severity (low|medium|high), description, fileName?} for each problem you see.',
    'Do not invent problems; if it looks correct, return pass with an empty issues array.',
  ].join('\n');
}

/**
 * Production query seam: a one-shot SDK vision query enforcing VERDICT_SCHEMA via
 * the SDK's native outputFormat. Mirrors monitorQuery.makeSdkStructuredQuery: a
 * fresh AbortController bridges the caller's signal + a hard deadline; on
 * timeout/error it throws (the judge then fails soft to low_confidence).
 */
export function makeSdkVisionQuery(
  logger?: LoggerLike,
  timeoutMs: number = JUDGE_QUERY_TIMEOUT_MS,
): VisionQueryFn {
  return async ({ prompt, schema, model, signal }) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });

    try {
      const q = query({
        prompt,
        options: {
          model,
          maxTurns: 1,
          // The images are inline in the prompt; the judge needs no tools.
          allowedTools: [],
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          outputFormat: { type: 'json_schema', schema },
          abortController: controller,
        },
      });

      let structured: unknown = null;
      for await (const msg of q) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          structured = msg.structured_output ?? null;
        }
      }
      if (timedOut) throw new Error(`judge query timed out after ${timeoutMs}ms`);
      return structured;
    } catch (err) {
      const message = timedOut
        ? `judge query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[vlmJudge] vision query failed', { error: message });
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Build the single-message async-iterable prompt: the instruction text followed by
 * each PNG as an inline base64 image block. Throws if no readable images remain
 * (the caller turns that into a low_confidence verdict).
 */
async function buildPrompt(
  instruction: string,
  artifactsDir: string,
  fileNames: string[],
  baselinePath: string | undefined,
): Promise<{ prompt: AsyncIterable<SDKUserMessage>; judged: string[] }> {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  > = [{ type: 'text', text: instruction }];

  const judged: string[] = [];
  const targets: Array<{ label: string; path: string }> = [];
  if (baselinePath) targets.push({ label: 'baseline', path: baselinePath });
  for (const name of fileNames.slice(0, MAX_IMAGES)) {
    targets.push({ label: name, path: join(artifactsDir, basename(name)) });
  }

  for (const t of targets) {
    const mediaType = MEDIA_TYPES[extname(t.path).toLowerCase()];
    if (!mediaType) continue;
    const data = await readFile(t.path);
    content.push({ type: 'text', text: `Image: ${t.label}` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
    });
    if (t.label !== 'baseline') judged.push(basename(t.label));
  }

  if (judged.length === 0) {
    throw new Error('no readable images to judge');
  }

  const msg: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield msg;
  }
  return { prompt: gen(), judged };
}

export class VlmJudgeImpl implements VlmJudgeInterface {
  private readonly model: string;
  private readonly confidenceThreshold: number;
  private readonly runQuery: VisionQueryFn;
  private readonly logger?: LoggerLike;

  constructor(opts: VlmJudgeOptions = {}) {
    this.model = opts.model ?? DEFAULT_JUDGE_MODEL;
    this.confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.runQuery = opts.runQuery ?? makeSdkVisionQuery(opts.logger);
    this.logger = opts.logger;
  }

  async judge(
    args: {
      intent: string;
      artifactsDir: string;
      fileNames: string[];
      type: VerificationType;
      baselinePath?: string;
    },
    signal: AbortSignal,
  ): Promise<VerdictV1> {
    const baselineUsed = !!args.baselinePath;

    if (signal.aborted) {
      return lowConfidence('judge aborted before start', [], this.model, baselineUsed);
    }

    let prompt: AsyncIterable<SDKUserMessage>;
    let judged: string[];
    try {
      const built = await buildPrompt(
        buildInstruction(args.intent, args.type, baselineUsed),
        args.artifactsDir,
        args.fileNames,
        args.baselinePath,
      );
      prompt = built.prompt;
      judged = built.judged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn('[vlmJudge] could not assemble images', { error: message });
      return lowConfidence(`could not read screenshots to judge: ${message}`, [], this.model, baselineUsed);
    }

    let raw: unknown;
    try {
      raw = await this.runQuery({ prompt, schema: VERDICT_SCHEMA, model: this.model, signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fail SOFT — never fabricate a verdict on a judge error.
      return lowConfidence(`visual judge call failed: ${message}`, judged, this.model, baselineUsed);
    }

    const parsed = parseModelVerdict(raw);
    if (!parsed) {
      return lowConfidence(
        'visual judge returned no parseable verdict',
        judged,
        this.model,
        baselineUsed,
      );
    }

    // Confidence floor: a pass/fail below the threshold is demoted to
    // low_confidence (a human review_item), never an auto-loop / fabrication.
    const status =
      parsed.status !== 'low_confidence' && parsed.confidence < this.confidenceThreshold
        ? 'low_confidence'
        : parsed.status;

    return {
      status,
      confidence: parsed.confidence,
      issues: parsed.issues,
      feedback: parsed.feedback,
      judgedFileNames: judged,
      baselineUsed,
      model: this.model,
    };
  }
}
