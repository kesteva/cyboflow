/**
 * The per-round prompt handed to the runbook-drafting agent
 * (docs/proposals/lane-runbook-bootstrap.md §8, §12 steps 4 and 7).
 *
 * Separate from the agent's own markdown (which is its persona and its rules,
 * shared by every deployment) because this is the part that CHANGES between
 * rounds: which modality, whether to adopt a committed runbook or author one,
 * and — the whole reason a second round exists — why the previous attempt's proof
 * failed. §12 step 7 allows exactly two rounds, and the second one is only worth
 * its cost if it is informed; a re-draft with no feedback is the same guess
 * again.
 *
 * PURE — a string function, so what the agent is actually told is assertable.
 */
import type { VerifyRunbookModality } from '../../../../shared/types/verifyRunbook';
import { RUNG1_OPERATION_KINDS } from './runbookDraft';

export interface RunbookDraftPromptArgs {
  modality: VerifyRunbookModality;
  round: number;
  maxRounds: number;
  /** §4's `'file-only'` case — a committed runbook nobody proved on this host. */
  adopt: boolean;
  existingRunbookRaw: string | null;
  /** The previous round's proof failure, verbatim. */
  feedback: string | null;
  /** The lane whose verification is waiting on this. */
  laneTaskRef: string;
  /**
   * The deployment's deadline, so the agent budgets its survey instead of
   * being killed mid-read. Three from-scratch drafts on 2026-09-17 spent their
   * whole budget surveying and never answered.
   */
  timeBudgetMs: number;
}

export function composeRunbookDraftPrompt(args: RunbookDraftPromptArgs): string {
  const sections: string[] = [];

  sections.push(
    `# Derive a \`${args.modality}\` verification runbook for this project\n\n` +
      `A sprint lane (\`${args.laneTaskRef}\`) has produced UI changes and is waiting to have them ` +
      'verified, but this project has no proven verification runbook — so the verification would be ' +
      'SKIPPED and nothing would be checked. Your job is to work out, from the project itself, how it ' +
      'is built and served, and return that as a runbook.\n\n' +
      'You write nothing. You have no Write, no Edit, and a read-only shell. Everything you return is ' +
      'validated and applied by the harness.\n\n' +
      `You have about ${Math.max(1, Math.round(args.timeBudgetMs / 60_000))} minutes. A deployment that ` +
      'hits that deadline returns NOTHING and the lane skips, so read what decides the answer ' +
      '(`package.json` scripts, the dev/serve entry, an existing `.cyboflow/verify-runbook.json`) and ' +
      'answer well before then — a good-enough runbook returned in time beats a perfect one that never ' +
      'arrives, and the harness will prove it for real and hand you the failure if it is wrong.',
  );

  if (args.adopt && args.existingRunbookRaw !== null) {
    sections.push(
      '## This tree already carries a runbook — ADOPT it\n\n' +
        'Someone committed `.cyboflow/verify-runbook.json` to this project; this machine has simply ' +
        'never proven it. Your default answer is to return it UNCHANGED. Correct it only where it is ' +
        'demonstrably wrong about this project (a script that no longer exists, a modality entry that ' +
        'contradicts the code) — a human wrote this, and replacing their intent with your own is not ' +
        'an improvement.\n\n' +
        '```json\n' +
        args.existingRunbookRaw.trim() +
        '\n```',
    );
  }

  if (args.feedback !== null && args.feedback.trim().length > 0) {
    sections.push(
      `## Attempt ${args.round - 1} was proven and FAILED — this is why\n\n` +
        'The harness ran your previous runbook for real: it built the project, started your serve ' +
        'command, and asked the running surface to identify itself. That did not work. Read the ' +
        'failure below and fix the specific thing it names — a different guess at the same shape will ' +
        'fail the same way.\n\n' +
        `> ${args.feedback.trim().split('\n').join('\n> ')}\n\n` +
        `This is attempt ${args.round} of ${args.maxRounds}. If the failure shows this project cannot ` +
        'be stood up by the harness at all, say so with `not-possible` rather than guessing again.',
    );
  }

  sections.push(
    '## What to return\n\n' +
      'Return ONE structured object.\n\n' +
      '**If this project can be stood up:**\n\n' +
      '```json\n' +
      '{\n' +
      '  "decision": "runbook",\n' +
      `  "modality": "${args.modality}",\n` +
      '  "runbook": { "version": 1, "modalities": { "…": { "build": [], "serve": {}, "attestation": {} } } },\n' +
      '  "notes": "why this shape — what you read, what you ruled out"\n' +
      '}\n' +
      '```\n\n' +
      '**If it cannot:**\n\n' +
      '```json\n' +
      '{ "decision": "not-possible", "reason": "<one specific sentence>" }\n' +
      '```\n\n' +
      '`not-possible` is a CORRECT answer, not a failure. It is the right answer whenever standing this ' +
      'project up would need something you are not allowed to invent: a command nobody wrote down, a ' +
      'service that must already be running, a build entry that would have to change. Saying so sends ' +
      'this project to the Verify Setup flow, where a human designs the change. Guessing instead ' +
      'produces a runbook that fails on every future verification.',
  );

  sections.push(
    '## The two rules that will reject your runbook\n\n' +
      '1. **Every `build` step and the `serve` command must invoke a script this project ALREADY ' +
      'declares in its root `package.json`** — `pnpm run <script>`, `npm run <script>`, `yarn <script>`, ' +
      '`bun run <script>`, optionally with extra arguments. Not a bare binary (`vite`, `next`), not ' +
      '`npx`, not a `&&` chain, not a command you believe *ought* to work. The harness refuses to run a ' +
      'command the project itself has not written down. Read `package.json` and use what is there.\n' +
      '2. **No dependency-mutating commands.** No install, no rebuild, no browser download. Dependencies ' +
      'are prepared for the verification before your commands run.\n\n' +
      'If neither an existing script nor the one config change below can satisfy rule 1, that is exactly ' +
      'what `not-possible` is for.',
  );

  sections.push(
    '## If ONE small config change would make it work\n\n' +
      'You may propose at most ONE change, to ONE file, and only in one of these three shapes. The ' +
      'harness applies it structurally — you do not write a diff, and a free-form edit is not accepted:\n\n' +
      `- \`{ "kind": "${RUNG1_OPERATION_KINDS[0]}", "scriptName": "…", "command": "…" }\` — add a NEW ` +
      'script to the root `package.json`. It will be refused if that script already exists; the harness ' +
      'never overwrites one.\n' +
      `- \`{ "kind": "${RUNG1_OPERATION_KINDS[1]}", "file": "…", "port": 5173, "envVar": "PORT" }\` — make ` +
      'a hardcoded port read an environment variable instead (keeping the number as the fallback). The ' +
      'literal must occur exactly ONCE in that file.\n' +
      `- \`{ "kind": "${RUNG1_OPERATION_KINDS[2]}", "file": "…", "setting": "strictPort" }\` — flip a ` +
      '`strictPort`-style `true` to `false` so a busy port does not fail the launch. It must occur ' +
      'exactly once.\n\n' +
      'Anything else — a plugin, an import, a changed build entry, a conditional, a second file — is ' +
      '`not-possible`. Lockfiles, CI configuration, `.github/`, `.claude/`, `.cyboflow/` and `scripts/` ' +
      'are refused outright whatever shape you propose.\n\n' +
      'Propose a change only if it is genuinely required. A human will review it as a separate commit, ' +
      'and a change that bought nothing is a change they have to reason about for no reason.',
  );

  return sections.join('\n\n---\n\n');
}
