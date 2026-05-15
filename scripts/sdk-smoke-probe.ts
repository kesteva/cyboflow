#!/usr/bin/env tsx
/**
 * SDK smoke probe — TASK-587 (claude-agent-sdk-migration epic).
 *
 * Standalone integration check that proves @anthropic-ai/claude-agent-sdk works
 * against the user's logged-in Claude subscription on this machine, before any
 * cyboflow service code commits to the SDK. Exits 0 on result.subtype === 'success';
 * exits non-zero on any other terminal state (different subtype, no result event,
 * or thrown exception).
 *
 * Usage: pnpm smoke:sdk
 *
 * Intentionally NOT importing from main/src — this probe must stay decoupled
 * from cyboflow internals so future SDK upgrades can be validated against the
 * raw library surface without churn from cyboflow refactors.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROMPT = "Reply with exactly one word: 'pong'.";
const SYSTEM_PROMPT_APPEND =
  'You are running in cyboflow SDK smoke-probe mode. Respond concisely.';

async function main(): Promise<number> {
  let sawStreamEvent = false;
  let sawResultSuccess = false;

  try {
    const stream = query({
      prompt: PROMPT,
      options: {
        cwd: process.cwd(),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: SYSTEM_PROMPT_APPEND,
        },
        includePartialMessages: true,
      },
    });

    for await (const event of stream) {
      // Print every event as a JSON line for observability.
      console.log(JSON.stringify(event));

      if ((event as { type?: string }).type === 'stream_event') {
        sawStreamEvent = true;
      }
      if ((event as { type?: string }).type === 'result') {
        const subtype = (event as { subtype?: string }).subtype;
        if (subtype === 'success') {
          sawResultSuccess = true;
        } else {
          console.error(
            `[sdk-smoke-probe] result event had non-success subtype: ${String(subtype)}`,
          );
        }
      }
    }
  } catch (err) {
    console.error('[sdk-smoke-probe] query() threw:', err);
    return 2;
  }

  if (!sawStreamEvent) {
    console.error(
      '[sdk-smoke-probe] FAIL: no stream_event events observed (includePartialMessages may not be honored).',
    );
    return 3;
  }
  if (!sawResultSuccess) {
    console.error(
      '[sdk-smoke-probe] FAIL: stream ended without a result event of subtype "success".',
    );
    return 4;
  }

  console.error('[sdk-smoke-probe] OK: result.subtype === "success".');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[sdk-smoke-probe] unhandled rejection:', err);
    process.exit(5);
  },
);
