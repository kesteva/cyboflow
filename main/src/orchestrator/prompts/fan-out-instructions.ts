/**
 * fan-out-instructions.ts
 *
 * Pure, side-effect-free generator for the per-run system-prompt APPEND that
 * tells the MAIN orchestrating session HOW to fan a step out over its runtime
 * item set — the per-item chain, the concurrency cap, and the dispatch / loopback
 * rules — derived entirely from the resolved `WorkflowDefinition`'s `fanOut`
 * specs.
 *
 * ── Why this is derived, not prose ───────────────────────────────────────────
 * Until now the sprint's / ship's parallelism (DAG waves, the 5-cap, the per-task
 * implement→…→visual-verify chain) lived HARDCODED in `sprint.md` / `ship.md`.
 * That meant the workflow editor's fan-out toggle / inner-chain / maxConcurrency
 * edits could not actually drive orchestrated runs. This generator moves that
 * instruction block to runtime, keyed off `step.fanOut`, so an edited chain
 * (steps removed / added / renamed, a different cap, serial vs parallel) renders
 * the matching instructions. It is the exact sibling of
 * `buildStepReportingAppend` (step-reporting-instructions.ts): a pure function of
 * the resolved definition, spliced onto `systemPromptAppend` right after the
 * step-reporting block (see `workflowPromptReaderAdapter.ts`).
 *
 * ── Loopback default ─────────────────────────────────────────────────────────
 * Each inner step's failure **loopback target** is `step.loopback` when set, else
 * THE FIRST inner step id (for the canonical sprint chain that is `implement`).
 * A step whose loopback target IS itself (the re-entry point — e.g. `implement`)
 * emits no "loop back" clause: it is the target, not a looper.
 *
 * Fail-soft: a `null` definition, or a definition with NO fanOut-bearing step,
 * yields the empty string — never a throw — so the wiring injects nothing rather
 * than garbage. Mirrors `buildStepReportingAppend`.
 *
 * No DB, IPC, or Electron imports — intentional; keep this module testable in
 * plain Node/vitest without bootstrapping the full app.
 */

import {
  effectiveMaxConcurrency,
  type FanOutInnerStep,
  type FanOutSpec,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../../../../shared/types/workflows';
import { AWAITING_VERIFY_STEP } from '../../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Loopback resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an inner step's failure loopback target: its explicit `loopback` id
 * when set, else the FIRST inner step id (the chain's re-entry point).
 */
function loopbackTargetId(step: FanOutInnerStep, firstId: string): string {
  return step.loopback !== undefined && step.loopback.length > 0 ? step.loopback : firstId;
}

/** `cyboflow-<agent>` for the inner step whose id is `targetId` (falls back to the id). */
function loopbackAgent(targetId: string, innerById: Map<string, FanOutInnerStep>): string {
  const target = innerById.get(targetId);
  return `cyboflow-${target !== undefined ? target.agent : targetId}`;
}

// ---------------------------------------------------------------------------
// Per-inner-step renderers (the "snippet library")
// ---------------------------------------------------------------------------

interface ChainContext {
  firstId: string;
  innerById: Map<string, FanOutInnerStep>;
}

/**
 * Render ONE inner step as a numbered chain entry. Canonical ids
 * (`implement` / `write-tests` / `code-review` / `task-verify` / `visual-verify`)
 * get the faithful texture ported from today's `sprint.md` / `ship.md` prose;
 * any other id gets a generic fallback that still names its delegate, its
 * files-touched context, and its resolved loopback target.
 */
function renderChainEntry(step: FanOutInnerStep, n: number, ctx: ChainContext): string {
  const laneId = step.id;
  const agent = `cyboflow-${step.agent}`;
  const targetId = loopbackTargetId(step, ctx.firstId);
  const optionalNote =
    step.optional === true
      ? ' (optional — an unavailable / not-configured step is skipped and never fails the lane)'
      : '';
  const head = `${n}. **\`${laneId}\`**${optionalNote} → move the lane's \`current_step\` to \`${laneId}\` via \`cyboflow_update_sprint_task\`, then`;

  switch (laneId) {
    case 'implement':
      return (
        `${head} delegate to \`${agent}\` with the task body + acceptance criteria. It ` +
        `returns an \`## Implementation\` summary. **Retain its list of files touched** — the ` +
        `shared worktree holds several lanes' uncommitted changes at once, so every later step ` +
        `in this task's chain needs that list to scope to THIS task's diff.`
      );
    case 'write-tests':
      return (
        `${head} delegate to \`${agent}\` with the task + diff summary (including the files ` +
        `touched). If its \`## Tests\` outcome reports a failing test, loop back to ` +
        `\`${loopbackAgent(targetId, ctx.innerById)}\` (per the loopback + attempt protocol below) ` +
        `to fix the cause before continuing. Read its final \`TESTS:\` line — on ` +
        `\`TESTS: skipped(<reason>)\`, record a **non-blocking finding** via ` +
        `\`cyboflow_report_finding\` (category \`test-infra\` when the reason is missing ` +
        `infrastructure, else \`test-gap\`; name the task ref and the reason), then continue the ` +
        `chain. A skip never fails the lane.`
      );
    case 'code-review':
      return (
        `${head} delegate to \`${agent}\` with the task **and the files it touched** (implement's ` +
        `list, plus any test files write-tests added) so it reviews this task's diff and not other ` +
        `lanes' in-flight work. For each entry in its \`## Findings\`, record a **non-blocking ` +
        `finding** via \`cyboflow_report_finding\` — always passing \`category\` and code ` +
        `\`locations\` (each \`{ path, line }\`). If it returns a \`## Blocking\` defect, loop back ` +
        `to \`${loopbackAgent(targetId, ctx.innerById)}\` (per the loopback + attempt protocol ` +
        `below) to fix it before proceeding.`
      );
    case 'task-verify':
      return (
        `${head} delegate to \`${agent}\` with the task, its acceptance criteria, **and the files ` +
        `it touched** (same list, so it judges this task's changes only). Read its \`VERDICT\`. On ` +
        `\`FAIL\`, re-delegate \`${loopbackAgent(targetId, ctx.innerById)}\` with its ` +
        `\`## Fix guidance\` and re-verify — up to **3×** (see the attempt protocol below) before ` +
        `marking the lane \`failed\` and **continuing the other lanes**.`
      );
    case 'visual-verify':
      return (
        `${head} treat this as the **async visual merge-gate**: delegate to \`${agent}\`, which ` +
        `FIRES exactly one \`cyboflow_request_verification\` (passing this lane's \`task_ref\`) and ` +
        `returns immediately — it does NOT capture, judge, or wait. Then move the lane to ` +
        `\`${AWAITING_VERIFY_STEP}\` via \`cyboflow_update_sprint_task\` ` +
        `(\`current_step: '${AWAITING_VERIFY_STEP}'\`) and PARK it there. The main-process verifier ` +
        `captures + judges the deliverable asynchronously and drives the lane off the park step for ` +
        `you — **PASS** advances the lane toward \`integrated\`; **FAIL** loops the lane back to ` +
        `\`${loopbackAgent(targetId, ctx.innerById)}\` with a bumped \`attempt\` and a BLOCKING ` +
        `finding carrying the judge's feedback (up to **3×** before the lane is \`failed\`); **low ` +
        `confidence** raises a non-blocking "needs human visual review" finding and lets the lane ` +
        `proceed. When you observe a lane the gate looped back (its \`current_step\` returned to the ` +
        `loopback target with a higher \`attempt\` and a blocking visual finding), RE-DELEGATE that ` +
        `target with the finding's feedback, then re-fire the verification request. Do **NOT** ` +
        `advance a lane to \`integrated\` until its merge-gate has PASSED (or the run has visual ` +
        `verification disabled). A \`VERDICT: SKIPPED\` from the subagent is NOT a gate — proceed. ` +
        `When a regression traces to already-merged work, the verifier's finding carries ` +
        `\`category: 'post-merge-bug'\`. The verifier produces and surfaces the screenshots ` +
        `artifact itself — you do NOT capture screenshots or report a \`screenshots\` artifact ` +
        `for this step.`
      );
    default: {
      // Generic fallback for a custom / renamed inner id: delegate, carry the
      // running files-touched list, and loop back per the derived target.
      const loopbackClause =
        targetId === laneId
          ? `On a failed or blocking result, retry this step per the loopback + attempt protocol below.`
          : `On a failed or blocking result, loop back to ` +
            `\`${loopbackAgent(targetId, ctx.innerById)}\` (id \`${targetId}\`, per the loopback + ` +
            `attempt protocol below).`;
      return (
        `${head} delegate to \`${agent}\` with the task body, its acceptance criteria, and the ` +
        `running files-touched list (so it scopes to THIS task's diff in the shared worktree). ` +
        `${loopbackClause}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch-rules renderer (branches on the effective concurrency cap)
// ---------------------------------------------------------------------------

/** The dispatch-rules block: parallel DAG waves (cap > 1) or strict serial (cap == 1). */
function renderDispatch(cap: number): string {
  if (cap > 1) {
    return [
      `### Dispatch — parallel DAG waves (at most **${cap}** concurrently)`,
      '',
      'Run the fan-out as **DAG waves** over the recorded blocking dependency edges:',
      '',
      '- A task is **READY** when every blocking prerequisite it depends on is complete',
      '  (`integrated`).',
      `- Dispatch at most **${cap}** tasks concurrently.`,
      "- Independent tasks' subagent calls go out **in parallel** — issue multiple Agent tool",
      '  calls in ONE message; as each returns, continue that task’s chain.',
      '- **Before each wave**, compare the expected files of the wave’s members — two tasks',
      '  that would touch the **same file** must not run concurrently; serialize one of them',
      '  into a later wave instead.',
      '- All work happens in **this session’s shared worktree** — there are no per-task',
      '  branches or worktrees.',
      '',
      'For each dispatched task, set its lane to `running` via `cyboflow_update_sprint_task`,',
      "then drive its per-task chain below, moving the lane's `current_step` as each stage begins.",
    ].join('\n');
  }
  return [
    '### Dispatch — serial (one lane at a time)',
    '',
    'Run the tasks **one at a time**, in dependency order:',
    '',
    '- A task is **READY** when every blocking prerequisite it depends on is complete',
    '  (`integrated`).',
    '- Start the next task ONLY after the current task’s lane reaches a terminal state',
    '  (`integrated` or `failed`) — never run two lanes concurrently.',
    '- Each task still gets its own lane and the full per-task chain below.',
    '- All work happens in **this session’s shared worktree** — there are no per-task',
    '  branches or worktrees.',
    '',
    'For each task, set its lane to `running` via `cyboflow_update_sprint_task`, then drive its',
    "per-task chain below, moving the lane's `current_step` as each stage begins.",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-fanOut-step section renderer
// ---------------------------------------------------------------------------

/** Framing line describing the item source keyed by `fanOut.over`. */
function itemSource(fanOut: FanOutSpec): string {
  return fanOut.over === 'tasks'
    ? 'the materialized sprint batch — **one lane per task**'
    : `the resolved item set (\`${fanOut.over}\`) — **one lane per item**`;
}

/** Render the full instruction section for ONE fanOut-bearing outer step. */
function renderFanOutSection(step: WorkflowStep, fanOut: FanOutSpec): string {
  const cap = effectiveMaxConcurrency(fanOut);
  const firstId = fanOut.inner.length > 0 ? fanOut.inner[0].id : '';
  const innerById = new Map<string, FanOutInnerStep>(
    fanOut.inner.map((s): [string, FanOutInnerStep] => [s.id, s]),
  );
  const ctx: ChainContext = { firstId, innerById };
  const laneIds = fanOut.inner.map((s) => `\`${s.id}\``).join(', ');

  const chain = fanOut.inner.map((s, i) => renderChainEntry(s, i + 1, ctx)).join('\n');

  return [
    `## Fan-out execution — \`${step.id}\``,
    '',
    `The \`${step.id}\` step fans out over ${itemSource(fanOut)}. Report \`${step.id}\` via`,
    '`cyboflow_report_step` **once** as the phase begins — it covers the whole fan-out;',
    'per-task progress is tracked in the **lanes** (`cyboflow_update_sprint_task`), not in',
    'extra `cyboflow_report_step` calls.',
    '',
    renderDispatch(cap),
    '',
    '### Per-task chain',
    '',
    'Drive each task’s lane through this chain, in order. Move the lane’s `current_step`',
    'with `cyboflow_update_sprint_task` as each stage begins, using the EXACT lane step ids and',
    `\`cyboflow-<agent>\` subagent_type names below (${laneIds}) so the lane auto-advances:`,
    '',
    chain,
    '',
    '### Loopback + attempt protocol',
    '',
    "Each inner step's failure **loopback target** is its own `loopback` when set, else THE FIRST",
    `inner step (\`${firstId}\`). When a step fails and loops back, re-delegate the loopback target`,
    'and include `attempt: <n>` (2 on the first re-delegate, 3 on the second) in the SAME',
    '`cyboflow_update_sprint_task` call that moves `current_step` back to it. Up to **3** attempts,',
    'then mark the lane `failed` and continue the other lanes — a failed lane never stops the',
    'fan-out.',
    '',
    '### Stuck subagents',
    '',
    'If a subagent comes back with no usable result, re-delegate it **once** with a sharper,',
    'narrower scope. If it is still stuck, mark the lane `failed` and move on — the remaining lanes',
    'keep running.',
    '',
    '### On task success',
    '',
    "When a task's chain drains clean (all checks pass, and — when the visual merge-gate ran — it",
    'PASSED or visual verification is disabled), follow this flow’s on-task-success rules: make',
    'ONE git commit for that task and set its lane to `integrated` via `cyboflow_update_sprint_task`.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Append-text generator
// ---------------------------------------------------------------------------

/**
 * Build the system-prompt APPEND block that tells the MAIN session how to drive
 * every fan-out step in the given RESOLVED definition. Walks `phases[].steps[]`
 * in declaration order and emits one section per step carrying a `fanOut` spec.
 *
 * @param def The already-resolved `WorkflowDefinition` for this run, as returned
 *   by `resolveWorkflowDefinition(name, spec_json)`. Pass `null` when the run's
 *   workflow has no resolvable definition: the generator returns `''` (fail-soft).
 * @returns The append text, or `''` when `def` is null or has no fanOut steps.
 */
export function buildFanOutAppend(def: WorkflowDefinition | null): string {
  if (def === null) return '';

  const sections: string[] = [];
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      if (step.fanOut !== undefined) {
        sections.push(renderFanOutSection(step, step.fanOut));
      }
    }
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}
