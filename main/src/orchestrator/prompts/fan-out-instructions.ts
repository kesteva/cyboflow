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
import { AWAITING_VERIFY_STEP, SPRINT_VISUAL_VERIFY_STEP } from '../../../../shared/types/sprintBatch';
import {
  DEFAULT_FAN_OUT_DISPATCH,
  type FanOutDispatch,
} from '../../../../shared/types/fanOutDispatch';
import type { TuningLevel } from '../../../../shared/tuning/workflowTuning';
import { fanOutBatchWorkflowName, segmentFanOutInner } from './fanOutStageScript';

/** Options for {@link buildFanOutAppend}. All default to today's prose behavior. */
export interface FanOutAppendOptions {
  /** How the inner chain is executed. Defaults to `prose`. */
  dispatch?: FanOutDispatch;
  /**
   * The workflow NAME used to derive stage-script names — must be the same value
   * the install seam rendered with (`workflows.name`), or the prompt will name
   * scripts that are not on disk. Defaults to the definition's `id`.
   */
  workflowName?: string;
  /**
   * The run's stamped tuning level (plan D7). Only `'thorough'` changes the
   * output, adding one viewport-depth line to the visual-verification task
   * composition; `'standard'` / `'custom'` / `'efficient'` / `null` / omitted all
   * render TODAY'S TEXT byte for byte. Depth is prompt-level guidance in v1 —
   * there is no mechanical viewport clamp.
   */
  tuningLevel?: TuningLevel | null;
}

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
  /**
   * The extra viewport-depth sentence appended to the visual-verification task
   * composition, or `''` at every level that keeps today's text (plan D7).
   */
  viewportDepthClause: string;
}

/**
 * The level-conditioned viewport-depth guidance for the composed verification
 * task (plan D7). Emitted ONLY at `thorough`, and only when the chain actually
 * carries a visual merge-gate — asking for three viewports on a chain with no
 * gate to consume them would be instruction with no addressee.
 *
 * Every other level (including `null`, i.e. an unattributed / pre-feature /
 * variant run) returns `''`, so the rendered block stays byte-identical to what
 * it emitted before levels existed.
 */
function viewportDepthClause(level: TuningLevel | null | undefined, hasVisualVerify: boolean): string {
  if (level !== 'thorough' || !hasVisualVerify) return '';
  return (
    ' This run is tuned **thorough**: tell it the composed task must capture the ' +
    'deliverable at **desktop, tablet, and mobile** viewports, not a single desktop one.'
  );
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
  // Only relay write-tests' output when the chain actually runs write-tests — a
  // tuning level that drops the step must never have its name in the prompt.
  const hasWriteTests = ctx.innerById.has('write-tests');

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
        `to fix the cause before continuing — do NOT also record the failing test as a finding; ` +
        `the loopback IS the response. Read its final \`TESTS:\` line — on ` +
        `\`TESTS: skipped(<reason>)\`, record a **non-blocking finding** via ` +
        `\`cyboflow_report_finding\` (category \`test-infra\` when the reason is missing ` +
        `infrastructure, else \`test-gap\`; name the task ref and the reason), then continue the ` +
        `chain. A skip never fails the lane.`
      );
    case 'code-review':
      return (
        `${head} delegate to \`${agent}\` with the task **and the files it touched** (implement's ` +
        `list, plus any test files write-tests added) so it reviews this task's diff and not other ` +
        `lanes' in-flight work${
          hasWriteTests
            ? ` — and write-tests' \`## Tests\` section VERBATIM (its \`Proof of failure:\` / ` +
              `\`Supporting:\` lines are how it tells acceptance tests from supporting ones)`
            : ''
        }. For each entry in its \`## Findings\`, record a **non-blocking ` +
        `finding** via \`cyboflow_report_finding\` — always passing \`category\` and code ` +
        `\`locations\` (each \`{ path, line }\`). Before filing, call \`cyboflow_list_run_findings\` ` +
        `and skip any entry that restates a finding already open (same issue — line numbers drift ` +
        `between attempts), and skip any entry about this task's own change or about transient ` +
        `environment trouble: those belong to the loopback or the lane, not the review queue. ` +
        `If it returns a \`## Blocking\` defect (or a final ` +
        `\`REVIEW: BLOCKING\` line), loop back to \`${loopbackAgent(targetId, ctx.innerById)}\` ` +
        `(per the loopback + attempt protocol below) to fix it before proceeding. Do NOT record a ` +
        `\`## Blocking\` defect as a finding — blocking or otherwise: the loopback IS the response, ` +
        `and a finding here would park the run and hand a human a defect the chain is about to fix ` +
        `itself. (A defect the loopback will NOT fix — a hazard in shared state that must stop the ` +
        `run now, e.g. a deleted migration or a committed secret about to be swept into a sibling ` +
        `commit — is the rare exception that IS a blocking finding.)`
      );
    case 'task-verify':
      return (
        `${head} delegate to \`${agent}\` with the task, its acceptance criteria, **and the files ` +
        `it touched** (same list, so it judges this task's changes only)${
          hasWriteTests ? `, plus write-tests' \`## Tests\` section VERBATIM` : ''
        }. Read its \`VERDICT\`. On ` +
        `\`FAIL\`, re-delegate \`${loopbackAgent(targetId, ctx.innerById)}\` with its ` +
        `\`## Fix guidance\` and re-verify — up to **3×** (see the attempt protocol below) before ` +
        `marking the lane \`failed\` and **continuing the other lanes**. A \`FAIL\` is handled by ` +
        `this loopback — do NOT also record it as a finding; the loopback IS the response. On \`PASS\`, ALSO enforce ` +
        `its **visual-verification output contract**: the result must carry exactly ONE of a ` +
        `\`## Visual verification task\` section (a single json fence holding the composed ` +
        `verification task) or the bare line \`VISUAL-VERIFICATION: NOT-APPLICABLE — <reason>\`. ` +
        `A PASS with neither, both, a duplicate, or an unparseable fence is an ` +
        `**output-contract failure** — NEVER treat it as "nothing to verify": re-delegate ` +
        `\`${agent}\` ONCE with the contract error; a second contract failure marks the lane ` +
        `\`failed\`. Retain the fence's JSON object (or the not-applicable reason) — the next ` +
        `step consumes it.${ctx.viewportDepthClause}`
      );
    case 'visual-verify':
      return (
        `${head} treat this as the **async visual merge-gate** — there is NO subagent to delegate ` +
        `for this step; YOU fire the request. If task-verify returned ` +
        `\`VISUAL-VERIFICATION: NOT-APPLICABLE\`, skip this step entirely (no request, no park) ` +
        `and continue the chain. Otherwise call \`cyboflow_request_verification\` ONCE, passing ` +
        `\`task\` = the JSON object from task-verify's \`## Visual verification task\` fence ` +
        `(verbatim — do not rewrite it) and \`task_ref\` = this lane's ref. If it returns ` +
        `\`{ skipped: true }\`, visual verification is disabled for this run — continue without ` +
        `parking. Otherwise move the lane to \`${AWAITING_VERIFY_STEP}\` via ` +
        `\`cyboflow_update_sprint_task\` (\`current_step: '${AWAITING_VERIFY_STEP}'\`) and PARK it ` +
        `there. The central verification agent builds the deliverable in a clean snapshot of the ` +
        `branch, drives the composed behaviors, captures screenshots, and its verdict drives the ` +
        `lane off the park step for you — **PASS** advances the lane toward \`integrated\`; ` +
        `**FAIL** loops the lane back to \`${loopbackAgent(targetId, ctx.innerById)}\` with a ` +
        `bumped \`attempt\` and a BLOCKING finding carrying the verification report (behaviors ` +
        `failed + evidence; up to **3×** before the lane is \`failed\`); **low confidence** raises ` +
        `a non-blocking "needs human visual review" finding and lets the lane proceed. When you ` +
        `observe a lane the gate looped back (its \`current_step\` returned to the loopback target ` +
        `with a higher \`attempt\` and a blocking visual finding), RE-DELEGATE that target with ` +
        `the finding's report, then re-run \`task-verify\` — its fresh contract re-fires the ` +
        `request. Do **NOT** advance a lane to \`integrated\` until its merge-gate has PASSED (or ` +
        `verification is disabled / not applicable). When a regression traces to already-merged ` +
        `work, the verifier's finding carries \`category: 'post-merge-bug'\`. The verifier ` +
        `produces and surfaces the screenshots artifact itself — you do NOT capture screenshots ` +
        `or report a \`screenshots\` artifact for this step.`
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
        `${loopbackClause} A failing/blocking result is handled by that loopback — do NOT also ` +
        `record it as a finding; the loopback IS the response.`
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

/**
 * Render the STAGE-MAJOR per-task chain: the same lane protocol, except each
 * agent-backed inner step is executed by dispatching ONE dynamic-workflow script
 * across the whole wave instead of issuing per-task Agent-tool calls by hand.
 *
 * Only the DELEGATION changes. The orchestrator still owns wave selection, every
 * `cyboflow_*` write, the loopback/attempt protocol, the host-owned visual
 * merge-gate, and the per-task commit — workflow subagents carry no cyboflow
 * tools and must never be asked to write state.
 *
 * A host-owned inner step (the visual gate) keeps its ORIGINAL prose entry, and
 * so does any step whose script could not be named — both fall back to the
 * agent-driven path per step, so a partial render degrades gracefully.
 */
function renderStageMajorChain(
  workflowName: string,
  step: WorkflowStep,
  fanOut: FanOutSpec,
  ctx: ChainContext,
): string {
  // Prose entries are numbered against the ORIGINAL chain so a gate's entry
  // keeps its position in the sequence the reader sees.
  const positionOf = new Map(fanOut.inner.map((s, i) => [s.id, i + 1] as [string, number]));
  const entries: string[] = [];

  for (const segment of segmentFanOutInner(fanOut.inner)) {
    if (segment.kind === 'gate') {
      // Firm gate → the untouched prose entry. The visual gate's request/park
      // protocol has no delegable equivalent.
      entries.push(renderChainEntry(segment.step, positionOf.get(segment.step.id) ?? 0, ctx));
      continue;
    }

    const batch = segment.steps;
    const scriptName = fanOutBatchWorkflowName(workflowName, step.id, batch[0].id);
    if (scriptName === null) {
      // Unnameable → fall back to per-stage prose for this batch.
      for (const inner of batch) {
        entries.push(renderChainEntry(inner, positionOf.get(inner.id) ?? 0, ctx));
      }
      continue;
    }

    const first = positionOf.get(batch[0].id) ?? 0;
    const last = positionOf.get(batch[batch.length - 1].id) ?? 0;
    const span = batch.length === 1 ? `${first}` : `${first}–${last}`;
    const ids = batch.map((s) => `\`${s.id}\``).join(' → ');

    entries.push(
      [
        `${span}. ${ids} — dispatched as ONE batch, no orchestrator gate between them.`,
        `   Move every wave member's \`current_step\` to \`${batch[0].id}\` via`,
        '   `cyboflow_update_sprint_task`, then use the **Workflow tool** (not Skill, not Bash):',
        `   \`Workflow({ name: '${scriptName}', args: [...] })\`. Each \`args\` entry is one item:`,
        '   `{ id, ref, title, brief, expectedFiles }` — `brief` carries the task body +',
        '   acceptance criteria. Pass ONLY the members of the CURRENT wave.',
        '   Each item walks the whole sub-chain inside the workflow, concurrently with the other',
        '   items, retrying its own loopback up to 3 attempts. You are NOT consulted in between —',
        `   that is the point: the next gate is ${
          last === fanOut.inner.length ? 'the end of the chain' : `step ${last + 1}`
        }.`,
        '   When it returns, reconcile each entry of `results`:',
        '   - `outcome: "ok"` → the item cleared every stage in the batch; advance its lane to the',
        '     stage after this batch and backfill its `current_step` history from `trail`.',
        '   - `outcome: "failed"` → the item exhausted its attempts at `failedStage`. Record',
        '     `attempts`, mark the lane `failed` per the protocol below, and keep the other lanes',
        '     running.',
        '   - every `trail[].findings` entry → file it with `cyboflow_report_finding` (the',
        '     subagents cannot; they only report) — after checking `cyboflow_list_run_findings`',
        '     and skipping any entry that restates an open finding. A `trail[].visualTask` is the fence the visual',
        '     gate needs — carry it forward verbatim.',
        '   The script writes NO cyboflow state by design: every lane move, finding, and commit is',
        '   YOURS to make from this session.',
      ].join('\n'),
    );
  }

  return entries.join('\n');
}

/** Render the full instruction section for ONE fanOut-bearing outer step. */
function renderFanOutSection(
  step: WorkflowStep,
  fanOut: FanOutSpec,
  dispatch: FanOutDispatch,
  workflowName: string,
  tuningLevel: TuningLevel | null | undefined,
): string {
  const cap = effectiveMaxConcurrency(fanOut);
  const firstId = fanOut.inner.length > 0 ? fanOut.inner[0].id : '';
  const innerById = new Map<string, FanOutInnerStep>(
    fanOut.inner.map((s): [string, FanOutInnerStep] => [s.id, s]),
  );
  const ctx: ChainContext = {
    firstId,
    innerById,
    viewportDepthClause: viewportDepthClause(
      tuningLevel,
      innerById.has(SPRINT_VISUAL_VERIFY_STEP),
    ),
  };
  const laneIds = fanOut.inner.map((s) => `\`${s.id}\``).join(', ');

  const chain =
    dispatch === 'workflow'
      ? renderStageMajorChain(workflowName, step, fanOut, ctx)
      : fanOut.inner.map((s, i) => renderChainEntry(s, i + 1, ctx)).join('\n');

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
    ...(dispatch === 'workflow'
      ? [
          '### Per-stage chain (workflow dispatch)',
          '',
          'Consecutive stages with no firm gate between them are dispatched as ONE batch: each',
          'item walks that whole sub-chain inside the workflow, concurrently with the other items,',
          'without returning to you in between. A firm gate ends a batch and is yours to drive.',
          `The lane step ids are ${laneIds}. Inside a batch the lane's \`current_step\` does not`,
          'tick per stage — backfill it from each result’s `trail` when the batch returns. You',
          'remain the SOLE writer of cyboflow state; the dispatched workflows write nothing:',
        ]
      : [
          '### Per-task chain',
          '',
          'Drive each task’s lane through this chain, in order. Move the lane’s `current_step`',
          'with `cyboflow_update_sprint_task` as each stage begins, using the EXACT lane step ids and',
          `\`cyboflow-<agent>\` subagent_type names below (${laneIds}) so the lane auto-advances:`,
        ]),
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
export function buildFanOutAppend(
  def: WorkflowDefinition | null,
  opts?: FanOutAppendOptions,
): string {
  if (def === null) return '';

  // Defaulted so every existing caller — notably the SDK-only
  // workflowPromptReaderAdapter — keeps emitting byte-identical prose.
  const dispatch = opts?.dispatch ?? DEFAULT_FAN_OUT_DISPATCH;
  const workflowName = opts?.workflowName ?? def.id;

  const sections: string[] = [];
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      if (step.fanOut !== undefined) {
        sections.push(
          renderFanOutSection(step, step.fanOut, dispatch, workflowName, opts?.tuningLevel),
        );
      }
    }
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}
