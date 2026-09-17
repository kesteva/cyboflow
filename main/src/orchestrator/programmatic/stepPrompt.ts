/**
 * composeStepPrompt — builds the scoped, single-step prompt that the programmatic
 * runner hands to one agent turn (Stage 2 of the execution-model seam).
 *
 * In the programmatic model the HOST sequences the DAG, so each agent turn is
 * deliberately narrowed to exactly ONE step: do this step's work (delegating to
 * its `cyboflow-<agent>` role), commit any file changes atomically, persist state via the
 * `cyboflow_*` MCP tools, and STOP — do not advance the workflow. The controller,
 * not the agent, decides what runs next. The voice/invariants mirror the
 * orchestrated harness (`customFlowPrompt.ts`) so the same subagent bundle +
 * single-writer contract apply unchanged; only the SCOPE differs (one step, not
 * the whole flow).
 *
 * GROUNDING (taskScope): each programmatic step runs in its OWN fresh SDK session
 * (no memory of prior steps), and — unlike the orchestrated `getPrompt` path — the
 * step prompt does NOT otherwise carry the sprint's task set. A step agent with no
 * task list cannot tell its subagent WHAT to analyze, so it falls back to probing
 * the worktree, finds no task files (cyboflow is DB-canonical — it keeps NO task
 * files on disk), and concludes "no tasks → No dependencies". That dropped the
 * blocking edges on a real sprint, so the dependents ran concurrently with their
 * prerequisite and failed (verified 2026-06-22). When `taskScope` is supplied the
 * host injects the SAME `# Sprint tasks` block the orchestrated path uses, so the
 * agent never has to discover scope on disk. The prose also pins the agent to the
 * installed `cyboflow-<agent>` role (with the runtime adapter selecting the
 * provider-native delegation type) and to
 * faithfully persisting EVERY item the subagent returns (a recurring failure mode:
 * collapsing real dependency edges to "none").
 *
 * ARTIFACT FOLLOW-UP: on the orchestrated plane, `workflows/planner.md` tells the
 * top-level agent what to do with a step's deliverable AFTER its subagent returns
 * (e.g. "read the prototype URL and call `cyboflow_report_artifact`") — but that
 * prose lives in the top-level flow file, which the programmatic plane never
 * loads (each step here is its own fresh, narrowly-scoped agent turn with no
 * access to the flow's full prose). Without an equivalent instruction inlined
 * into the step prompt itself, a step whose `outputArtifact` needs an explicit
 * follow-up (ui-prototype, arch-design) silently never produces one on
 * programmatic runs: the subagent returns its section faithfully, but nothing
 * ever reports it, so the artifact tab stays empty forever (2026-07-06,
 * empty-ui-prototype-tab incident). `composeStepPrompt` now owns mirroring that
 * per-step follow-up via `artifactFollowUp` below — see its doc comment for which
 * atypes need one and why most don't.
 *
 * Pure: no fs / DB / Date / randomness — output depends only on its args, so it
 * is trivially testable. Human-gate steps never reach here (the controller
 * resolves them via the host's human-gate path, not the runner).
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import { DESIGN_SPEC_SECTION_HEADING, PROTOTYPE_HTML_RELPATH } from '../../../../shared/types/artifacts';
import type { SolutionThoroughness } from '../../../../shared/types/thoroughness';
import { THOROUGHNESS_BUDGETS } from '../../../../shared/types/thoroughnessBudgets';
import type { ThoroughnessBudgetAgent } from '../../../../shared/types/thoroughnessBudgets';

export interface ComposeStepPromptArgs {
  step: WorkflowStep;
  /** The run's workflow name (e.g. 'planner') — orients the agent. */
  workflowName: string;
  /** 1-based attempt number; >1 means a prior attempt failed and is being retried. */
  attempt: number;
  /**
   * Fan-out item context — present ONLY when this step is one item's inner step
   * of a host-driven fan-out. Absent for every normal single-step invocation, so
   * the single-step prompt output stays byte-identical. When present the agent is
   * scoped to exactly this item (do not touch other items).
   */
  item?: { id: string; over: string };
  /**
   * The sprint's task scope — the pre-rendered `# Sprint tasks` block BODY (the
   * SAME text the orchestrated `getPrompt` path prepends), resolved by the host
   * from the DB. Present ONLY for a seeded sprint-style run; absent (or empty) for
   * planner / non-sprint steps, in which case no task block is added. Grounds the
   * step agent in the real task set so it never has to DISCOVER scope on disk.
   */
  taskScope?: string;
  /**
   * Idea ids this run owns: its launch seed plus ideas it created during
   * execution. Resolved live by the host for each fresh step turn, rather than
   * asking the agent to infer an "active" idea from every project idea.
   */
  runOwnedIdeaIds?: readonly string[];
  /**
   * The run's approved PROJECT BRIEF markdown (launch flow) — the payload of
   * the run's `project-brief` artifact, resolved live by the host for each
   * fresh step turn. Launch's post-brief steps (design, ideas, expand-spec,
   * epics, tasks) all ground in the brief, but a programmatic step agent has
   * no MCP surface to read artifacts — without this section it would probe
   * the (usually empty) worktree and improvise. Absent / empty ⇒ no section
   * (byte-identical prompts; also naturally absent on pre-brief steps and
   * every non-launch flow).
   */
  projectBrief?: string;
  /**
   * The verify-setup run's runbook PROPOSAL markdown — the payload of the run's
   * `verify-runbook` artifact (the doc the `derive` step published and the
   * `approve-runbook` gate approved), resolved live by the host for each fresh
   * step turn. `prove` must write the runbook, the machine-local bindings, and
   * the approved rung-1/rung-2 edits EXACTLY as proposed, but a programmatic
   * step turn has no MCP surface that READS an artifact — so without this
   * section it cannot recover what was approved and asks the human to paste it
   * back (observed live 2026-08-27: the prove agent filed three gate questions,
   * "the prior proposal/gate payload was not included in this step invocation").
   * Absent / empty ⇒ no section (byte-identical prompts; naturally absent on
   * `inspect`/`derive`, which run before the artifact exists, and on every
   * non-verify-setup flow).
   */
  runbookProposal?: string;
  /**
   * The APPROVED DESIGNS covering this sprint/ship run's batch — the pre-rendered
   * `# Design surfaces` block (composeDesignSurfaces), resolved live by the host
   * for each fresh step turn.
   *
   * A design is approved in one run and built in another. The prototype is a RUN
   * artifact — cascade-deleted with the run that drew it, and unreadable by any
   * MCP tool a sprint lane holds — so without this section the lane implementing
   * the screens has never seen the design it must match, and ships placeholders
   * where the approved mockup shows a finished flow. What survives is the
   * approved_designs snapshot path plus the idea body's `## Design spec`
   * section, and this block carries both.
   *
   * Rendered for EVERY step of the run, not just implement: task-verify judges
   * fidelity, sprint-review judges reachability, code-review and address-review
   * all benefit from knowing what was designed. Absent / empty ⇒ no section, so
   * a run with no approved design is byte-identical to before this existed.
   */
  designSurfaces?: string;
  /**
   * The project's declared SOLUTION THOROUGHNESS — the level Launch's interview
   * captured and the approve-brief gate stamped on the project.
   *
   * It exists because every agent in this repo carries a fixed default rigour,
   * and a fixed default is wrong at both ends: a throwaway prototype gets a
   * 120-line architecture document and tasks with rollback criteria, while a
   * production system gets the same review bar as a weekend experiment. The level
   * is the human's answer to "how finished does this have to be", and rendering
   * it as a per-agent BUDGET is what makes the answer bind.
   *
   * Absent ⇒ no section — every project that predates the stamp, and every flow
   * that never asked, keeps today's defaults byte-for-byte.
   */
  solutionThoroughness?: SolutionThoroughness;
  /**
   * The human's raw `approve-runbook` gate resolution string, when it carries
   * more than a bare verdict. The programmatic plane's gate is an all-or-nothing
   * blocking decision item whose resolution the host reduces to
   * approve/reject/revise (humanGate.parseGateVerdict), so there is NO structured
   * per-modality / per-rung subset here — the flow's "Pick subset" option exists
   * only on the orchestrated plane, where the answering agent keeps it in
   * context. What a human CAN do is type a qualification into the note
   * ("approve, but skip native-screen"), and that free text is the only trimming
   * signal that survives to `prove`. Absent / empty / a bare verdict word ⇒ no
   * section.
   */
  approveRunbookResolution?: string;
  /**
   * The human's per-idea approve-ideas gate decisions — the pre-rendered
   * `- IDEA-014: approve` verdict lines the host read off the run's RESOLVED
   * `gate:human-step:approve-ideas` item (readApproveIdeasDecisionLines).
   * Present only AFTER that batch gate resolved; absent / empty ⇒ no section
   * (output unchanged). The orchestrated plane DELIVERS these decisions into the
   * parked conversation's next turn, but each programmatic step is a fresh agent
   * turn no delivery can reach — so post-gate steps (expand-spec, epics, tasks)
   * learn which ideas were DENIED only through this section.
   */
  approveIdeasDecisions?: string;
  /**
   * Operator GUIDANCE for this step (RunDirectives live steering) — free-text the
   * operator added mid-run via the monitor to steer this step, appended as a tail
   * section when non-empty. Absent / empty ⇒ no guidance section (output
   * unchanged). Unlike `taskScope`/`item` this is per-STEP, not per-run.
   */
  userGuidance?: string;
  /**
   * The run supervisor's LANE-RESCUE guidance for this fan-out lane (monitor
   * lane triage). Rendered in the SAME `## Operator guidance` section as
   * `userGuidance` — an agent should not have to learn two section names for
   * "instructions someone added mid-run" — but LABELLED as the supervisor's,
   * since it exists because this lane already failed and the label is what tells
   * the agent this is a correction rather than a preference. Both may be present
   * at once (an operator steer AND a rescue); both render. Absent / empty ⇒ no
   * contribution (a prompt with only `userGuidance` is byte-identical to before
   * this field existed).
   */
  laneGuidance?: string;
  /**
   * The §5.1 visual-verification output-contract defect quoted back to a
   * RE-DELEGATED task-verify (verification-agent redesign §5.3). Set ONLY on the
   * single contract re-run: the previous attempt's PASS result carried neither the
   * `## Visual verification task` fence nor a NOT-APPLICABLE line (or an
   * unparseable/duplicate one). Rendered as a section instructing the agent to
   * re-emit its FULL result with exactly one of the two contract forms. Absent /
   * empty ⇒ no section (output unchanged).
   */
  contractError?: string;
  /**
   * The visual merge-gate's failure report quoted VERBATIM to a re-delegated
   * implement step (verification-agent redesign §5.3). Set ONLY on the step a
   * visual-verify FAIL loopback re-drives, so the re-implement agent sees the
   * failed behaviors + evidence rather than "a blocking finding exists". Absent /
   * empty ⇒ no section (output unchanged).
   */
  loopbackFeedback?: string;
  /**
   * A human gate's 'revise' decision, threaded into every step that gate's
   * loopback re-drives: the gate's id, the human's verbatim note, and the run's
   * current adversarial-review markdown.
   *
   * Deliberately NOT `loopbackFeedback`: that section's wording is hardcoded to
   * visual verification ("The visual verification of your previous attempt
   * FAILED"), which on a design revision would be a lie, and the two can in
   * principle both be live. A distinct heading also lets the re-run agent tell
   * "a machine check failed" from "a human sent this back".
   *
   * Absent on every normal turn ⇒ no section (output unchanged).
   */
  gateRevision?: { gateStepId: string; note?: string; reviewMarkdown?: string };
  /**
   * The most recent preceding AGENT step's final text, for a step whose
   * definition sets `consumesPriorStepOutput`. Rendered as a
   * `## Previous step output` section. Absent ⇒ no section.
   *
   * `text` absent (with the step still named) means the channel was unavailable
   * — the previous turn produced no capturable final text. That renders as an
   * explicit note, never as silence: a consuming agent told nothing at all would
   * reasonably conclude the previous step found nothing, which is a different
   * and wrong thing.
   */
  priorStepOutput?: { stepId: string; name: string; text?: string };
  /**
   * Repo paths this run's RUNBOOK BOOTSTRAP wrote
   * (docs/proposals/lane-runbook-bootstrap.md §11), rendered as a do-not-touch
   * list on the address-review step.
   *
   * This is not tidiness. The runbook's machine-local record is content-addressed
   * against the committed file, so ANY edit to it — including a well-meant
   * "fix" — demotes the proof by hash drift and the next verification skips.
   * And the rung-1 config edit is what makes the environment stand up at all, so
   * a reviewer reverting it silently un-proves the environment while leaving the
   * runbook claiming otherwise. address-review is the one step in the chain that
   * "fixes in place", which is why it is the one that has to be told.
   *
   * Absent / empty ⇒ no section (byte-identical prompts on every run that did not
   * bootstrap, which is nearly all of them).
   */
  bootstrapProtectedPaths?: readonly string[];
}

/**
 * Per-atype "report the artifact yourself" addendum for steps whose
 * `outputArtifact` needs an explicit agent follow-up once its subagent returns.
 * Mirrors the equivalent prose in `workflows/planner.md` written for the
 * orchestrated top-level agent — there is no top-level agent on the
 * programmatic plane, so `composeStepPrompt` inlines the same instruction into
 * the scoped step prompt instead.
 *
 * NOT every `outputArtifact` atype needs one: 'idea-spec' and
 * 'decomposed-stories' mint automatically by re-deriving from the entity DB
 * once the step's own `cyboflow_*` writes land as part of "do the work" (step
 * 1 of the numbered list above) — no separate reporting action exists for
 * those, so adding an addendum would just be prompt noise. 'ui-prototype',
 * 'arch-design', 'project-brief', and 'compound-recommendations' have a
 * deliverable that lives OUTSIDE that entity write (a served localhost URL; a
 * subagent-returned section that must be folded into the idea body by hand; a
 * payload-backed markdown doc composed from a subagent's return) — those need
 * to be told explicitly. Any future atype defaults to no addendum (the `default` branch)
 * unless it is proven to need one and added here deliberately.
 */
function artifactFollowUp(
  outputArtifact: NonNullable<WorkflowStep['outputArtifact']>,
  workflowName: string,
): string {
  switch (outputArtifact.atype) {
    case 'ui-prototype': {
      // The subagent returns TWO sections and they have DIFFERENT destinations.
      // `## Prototype` confirms a file that becomes a RUN artifact — it dies with
      // the run's artifact cascade and no later flow can read it. `## Design spec`
      // is the design CONTRACT, and it only outlives the run if this step folds it
      // into a durable body (the idea, or — on launch, where no idea exists yet —
      // the brief). Reporting the artifact and dropping the spec is the whole
      // failure this addendum exists to prevent.
      const fold =
        workflowName === 'launch'
          ? `\n\nThe subagent ALSO returns a \`## ${DESIGN_SPEC_SECTION_HEADING}\` section, and reporting the prototype artifact does NOT persist it. No idea exists yet on this flow, so the brief carries it: take the \`# Project brief\` section above, append the returned \`## ${DESIGN_SPEC_SECTION_HEADING}\` section to it (REPLACE any existing \`## ${DESIGN_SPEC_SECTION_HEADING}\` section, never stack a second copy), and re-report the brief: \`cyboflow_report_artifact\` with \`atype: 'project-brief'\`, label \`"Project brief"\`, and \`payload_json\` \`{"markdown": "<the full updated brief>"}\`. The later ideas step splits that spec across the ideas it creates; without this re-report the prototype's design prose is lost the moment this run's artifacts are cleaned up.`
          : `\n\nThe subagent ALSO returns a \`## ${DESIGN_SPEC_SECTION_HEADING}\` section, and reporting the prototype artifact does NOT persist it. Fold it into EACH covered idea's body yourself via \`cyboflow_update_task\`: when the body already carries a \`## ${DESIGN_SPEC_SECTION_HEADING}\` section, REPLACE that section (never stack a second copy); otherwise append it. For a combined multi-idea mockup, give each idea the part of the spec describing ITS screens, not the whole document. This section is the design contract every later builder reads — the prototype file itself is a run artifact that no sprint lane can open, so an unfolded spec is a design nobody downstream will ever see.`;
      return `\n\n## Artifact to report\n\nYour \`cyboflow-ui-prototype\` subagent writes ONE self-contained static HTML+CSS document — no \`<script>\`, no JS, no dev server — to \`$CYBOFLOW_RUN_ARTIFACTS_DIR/${PROTOTYPE_HTML_RELPATH}\`. When it returns its \`## Prototype\` section confirming that file, call \`cyboflow_report_artifact\` yourself with \`atype: 'ui-prototype'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"fileName": "${PROTOTYPE_HTML_RELPATH}"}\` — that call is the ONLY thing that mints this run's UI-prototype tab. Skipping it leaves the tab permanently empty.${fold}`;
    }
    case 'arch-design':
      // Launch designs the whole concept BEFORE ideas exist, so the section
      // cannot fold into an idea yet — it lives in the project-brief artifact
      // until the ideas step folds it into the foundation idea.
      if (workflowName === 'launch') {
        return `\n\n## Artifact to report\n\nWhen your \`cyboflow-architecture\` subagent returns its \`## Architecture design\` section, no idea exists yet to fold it into — the brief carries it. Take the \`# Project brief\` section above, append the returned \`## Architecture design\` section to it (REPLACE any existing \`## Architecture design\` section, never stack a second copy), and re-report the brief artifact: \`cyboflow_report_artifact\` with \`atype: 'project-brief'\`, label \`"Project brief"\`, and \`payload_json\` \`{"markdown": "<the full updated brief>"}\`. The later ideas step folds this section into the foundation idea, which is what derives the arch-design tab.`;
      }
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-architecture\` subagent returns its \`## Architecture design\` section, fold it into the IDEA's body yourself via \`cyboflow_update_task\`: if the body already has an \`## Architecture design\` section, REPLACE that section (never stack a second copy); otherwise append it. The arch-design deliverable tab derives from the body automatically, so you do not report an artifact for this step.`;
    case 'project-brief':
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-interview\` subagent returns its \`## Project brief\`, call \`cyboflow_report_artifact\` yourself with \`atype: 'project-brief'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the full brief markdown>"}\` — that call is the ONLY thing that mints this run's Project brief tab, and the approve-brief gate has nothing to review without it. Re-report the same atype after any revision to enrich the same tab.`;
    case 'adversarial-review':
      // The review's entries are NOT findings at this step. The approve-design
      // gate is what decides which of them a human accepts as risk, and filing
      // them here would both pre-empt that decision and park the run behind a
      // queue of items the very next gate is about to triage. The artifact IS the
      // channel: it is what the gate body is composed from, and — being one per
      // atype per run — what a revision round enriches rather than duplicates.
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-adversarial-review\` subagent returns its \`## Result\`, compose ONE markdown doc from it and report it — that doc is the ONLY surface the \`approve-design\` gate reviews, and the gate has nothing to show without it.\n\nCompose it with exactly two top-level sections, in this order:\n\n- \`## Blocking\` — the subagent's \`### Blocking\` entries.\n- \`## Findings\` — its \`### Findings\` entries.\n\nCarry every entry across VERBATIM, keeping its \`#### AR-n — <title>\` heading and its \`**Severity:**\` / \`**Area:**\` / \`**What:**\` / \`**Why it matters:**\` / \`**Fix:**\` fields. Do not renumber, merge, summarize, or re-rank them: the \`AR-n\` ids are how the gate's revision round reports back what it resolved, and a re-numbered entry breaks that thread. Keep a section's heading with \`None.\` under it when it is empty.\n\nThen call \`cyboflow_report_artifact\` yourself with \`atype: 'adversarial-review'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the doc>"}\`. Re-reporting the same atype ENRICHES the same tab, so a re-review after a revision replaces the document rather than stacking a second one.\n\nDo NOT call \`cyboflow_report_finding\` at this step — not for a blocking entry, not for an advisory one, not as a \`decision\`. The approve-design gate decides what becomes a finding: on Approve every entry is logged as an accepted-risk finding, and on Revise the design steps re-run against them. Filing them here pre-empts that decision and buries the human under items the very next gate was about to triage. Likewise do not "auto-fix" a blocking entry yourself by editing a spec or re-running a design step — this step reviews and reports; the gate routes.`;
    case 'verify-runbook':
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-verify-setup\` subagent returns its \`## Runbook draft\`, \`## Rung ladder\`, and \`## Open risks\` sections, compose ONE proposal doc — the ONLY surface the \`approve-runbook\` gate reviews — with exactly these three top-level sections, in this order:\n\n- \`## Runbook\` — per declared modality: the \`build\` steps, the \`serve\` form, the REQUIRED \`attestation\` spec, and the behaviors that will serve as the proof. Show the PORTABLE half verbatim (it is what gets committed) and list the machine-local bindings separately, saying plainly that those stay on this machine. Levers stay as \${PORT}-style placeholders — never a resolved port, never a temp dir, never an install or native-rebuild command.\n- \`## Repo changes\` — grouped \`### Rung 0 (no change)\` / \`### Rung 1 (config only)\` / \`### Rung 2 (proposed diff)\`, in that order. Keep every heading even when a rung is empty and write \`None.\` — the human should SEE which rungs you cleared, not guess. Every rung-2 entry names the exact file, what it replaces, and the verbatim proposed change.\n- \`## Risks\` — what could still make the proof fail, and what the fallback is.\n\nThen call \`cyboflow_report_artifact\` yourself with \`atype: 'verify-runbook'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the doc>"}\`. That call is the ONLY thing that mints this run's proposal tab, and the approve-runbook gate has nothing to review without it. It is also the ONLY channel by which the later \`prove\` step can see what you drafted: every step is a fresh agent turn with no memory of this one and no tool that can read your prose, so anything you leave out of this doc is lost.\n\nThis is NOT a Compound run: do not compose \`## Act on\` / \`## Discarded\` sections, do not delegate to \`cyboflow-compounder\`, and do not propose CLAUDE.md or docs edits. Write NOTHING to the repo at this step — nothing is registered and nothing is committed until the human approves.`;
    case 'compound-recommendations':
      return `\n\n## Artifact to report\n\nAfter your \`cyboflow-compounder\` subagent returns its \`## Learnings\` and \`## Discarded\` lists, compose ONE summary-of-recommendations markdown doc — the single thing the human reads at the approve-learnings gate — with TWO top-level sections:\n\n- \`## Act on\` — the learnings that cleared the bar, grouped as \`### Quick fixes\` / \`### CLAUDE.md edits\` / \`### Doc edits\` / \`### Tasks\`, in that order, one entry per learning with its general rule, evidence (recurrence + run ids, files), computed impact, and the proposed change.\n- \`## Discarded\` — the candidates the compounder considered and set aside, one line each with its reason. This is the "here's what I discarded" half of the review. Omit the section only if the compounder returned no discarded list.\n\nCLAUDE.md edits get their OWN section and are never folded into \`### Doc edits\` — that section covers the always-loaded instruction layer (\`docs/AGENT-GUIDE.md\` plus the \`CLAUDE.md\` / \`AGENTS.md\` entry files), which is loaded into every session of every flow, so its edits carry the strictest bar in this flow (capped at ONE per run; zero is the expected outcome). List each with the exact file + section, the verbatim wording, the text it replaces, and its answers to the compounder's five admission questions. When there are none, keep the heading and write \`None.\` so the human sees the bar was applied. \`### Doc edits\` holds all other \`docs/*.md\` (incl. CODE-PATTERNS.md / ARCHITECTURE.md, but never AGENT-GUIDE.md) edits, and those clear their own lower-but-real bar. Drop any proposed instruction-file edit whose rule carries a migration number, run id, version stamp, date, commit SHA, or "we used to" history — that is the incident, not the rule.\n\nThen call \`cyboflow_report_artifact\` yourself with \`atype: 'compound-recommendations'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the doc>"}\`. That call is the ONLY thing that mints this run's recommendations tab; skipping it leaves the gate with nothing to review.\n\nHard limits on what becomes a review-queue item: do NOT emit \`cyboflow_report_finding\` with \`kind:'finding'\` (a finding is Compound's input, not its output), and do NOT emit a \`cyboflow_report_finding\` \`decision\` — or any review item — for a DISCARDED candidate. Discarded candidates live in the \`## Discarded\` section of THIS doc and nowhere else; filing one per drop is exactly the sequential-gate spam this flow must not produce. This flow emits NO \`decision\` review items at all — the final approval is the workflow's own \`human-review\` step (a "merge in changes" gate like Sprint/Ship), not a reported item. Never file a \`decision\` here, at write-back, per edit, or per drop.`;
    default:
      return '';
  }
}

/**
 * Idea-flag persistence contract for the steps that CREATE or REWRITE idea
 * bodies. The conditional design steps below (ui-prototype / architecture) and
 * the flow's build ordering key on flag lines (`SCOPE:` / `UI_PROTOTYPE:` /
 * `ARCH_DESIGN:` / `BUILD_ORDER:`) PERSISTED in each idea's
 * body — the long-form flow prose spells this out for the orchestrated plane,
 * but a scoped step turn never sees that prose. Without the contract inlined
 * here, the launch `ideas` step persisted stubs WITHOUT the subagent's flag
 * lines, so ui-prototype and architecture silently self-skipped on every
 * programmatic launch run (2026-08-04, first launch smoke). `expand-spec`
 * (planner / ship / launch) is the rewrite half: it replaces the body and must
 * carry the flag lines through.
 */
function ideaFlagContract(step: WorkflowStep): string {
  switch (step.id) {
    case 'ideas':
      return `\n\n## Idea persistence contract\n\nYour subagent returns each idea with flag lines — \`SCOPE:\`, \`BUILD_ORDER:\`. When you persist an idea via \`cyboflow_create_task\`, its \`body\` MUST include those flag lines VERBATIM (keep them at the end of the stub), and pass \`scope\` as the entity field too. Later steps read the flags off the persisted body — an idea saved without them loses its build ordering. Additionally: when the \`# Project brief\` section above carries an \`## Architecture design\` section, fold that section into the LOWEST \`BUILD_ORDER\` idea's body via \`cyboflow_update_task\` after creating it (replace any existing section, never stack a second copy) — the foundation idea carries the project's architecture from here on, and its arch-design tab derives from it automatically.\n\nWhen the brief carries a \`## ${DESIGN_SPEC_SECTION_HEADING}\` section (the design phase's prototype pass wrote it there), EVERY idea you create whose scope includes one of its screens MUST carry its OWN \`## ${DESIGN_SPEC_SECTION_HEADING}\` section listing just that idea's screens, copied from the brief's spec — the same screen name, navigation path, states, and verbatim copy strings. Split the brief's spec across the ideas; do not paste the whole document into each one, and do not leave it only in the brief (a sprint lane reads the IDEA, never the brief). Every screen the brief's design spec names must end up owned by exactly one idea, and an idea that owns a screen must say in its body that the screen is reachable from the app's entry point — never write that a control is a placeholder, does nothing, or performs no navigation.`;
    case 'expand-spec':
      // The preserve-list is a CLOSED enumeration, so anything absent from it is
      // clobbered by the rewrite. `## Design spec` is named here because on launch
      // the design phase runs BEFORE this step: the ideas step writes each idea's
      // design prose and expand-spec rewrites that same body afterwards, so an
      // unnamed section is written and then destroyed on exactly the flow it was
      // built for. Worse than the text loss, the rewrite MATERIALIZES stale ledger
      // rows for the whole downstream set (see the component-ledger contract), and
      // a materialized row beats derivation permanently.
      return `\n\n## Idea persistence contract\n\nIf an idea's current body carries flag lines (e.g. \`SCOPE:\` / \`BUILD_ORDER:\` / \`UI_PROTOTYPE:\` / \`ARCH_DESIGN:\`), an \`## Architecture design\` section, or a \`## ${DESIGN_SPEC_SECTION_HEADING}\` section, the expanded body you write back via \`cyboflow_update_task\` MUST preserve those VERBATIM. Downstream steps read them off the persisted body — dropping them during expansion silently breaks design conditioning and build ordering, and discards the design contract the builders match their screens against.`;
    default:
      return '';
  }
}

/**
 * Idea component-ledger contract for the LAUNCH steps that complete a ledger
 * component. `launch.md` carries these obligations for the orchestrated plane,
 * but a programmatic step turn never sees the flow markdown — it gets its
 * `desc` plus the contracts composed here and nothing else — so on a
 * programmatic run the ledger went entirely unwritten. Observed on the first
 * multi-idea launch run (2026-09-04): the run specced an idea, built it 3
 * epics and 8 tasks, and left `epics`/`stories` reading `incomplete`, so the
 * idea presented to the next Planner run as four-fifths unplanned.
 *
 * The stamp must land AFTER the write it records: TaskChangeRouter's
 * post-commit hook marks downstream components stale on a body change, and
 * setComponentState clearing that flag is the whole point of the ordering.
 *
 * `prototype` is deliberately absent, and `epics` is deliberately deferred off
 * the `epics` step — see the per-step strings for why.
 *
 * Launch-only by design: planner/ship carry the same obligations in their own
 * prose and have the same programmatic blind spot, but their resume-gate
 * semantics differ enough that copying these strings across would be wrong.
 */
function ideaLedgerContract(step: WorkflowStep, workflowName: string): string {
  if (workflowName !== 'launch') return '';
  const H = '\n\n## Component ledger (launch)\n\n';
  switch (step.id) {
    case 'ideas':
      // `prototype` stays narrowed even though the approve-ideas gate now binds an
      // approved_designs row to EVERY approved idea (gateSideEffects). The bind's
      // durable value is the SNAPSHOT PATH — it survives the run's artifact cascade
      // delete, which is what a later builder actually needs. The ledger is a
      // different claim: a ledger ROW is authoritative over derivation (migration
      // 101), so stamping every approved idea `complete` off ONE whole-concept
      // mockup permanently tells every later Planner run that idea #7's screens are
      // designed when the concept mockup may not show them at all. The stamp is
      // therefore gated on the idea carrying its OWN design-spec section, which is
      // the only evidence that THIS idea's screens were designed.
      return `${H}After you fold the brief's \`## Architecture design\` section into the LOWEST \`BUILD_ORDER\` idea, stamp that idea: \`cyboflow_set_idea_component(idea_id: <that idea>, component: 'architecture', state: 'complete')\` — AFTER the \`cyboflow_update_task\` body write, never before (the body write is what marks downstream components stale, and the stamp is what clears the flag). Stamp \`architecture\` on that ONE idea only: the others carry no architecture section of their own, and a ledger reading \`complete\` over a body without the section sends the next run hunting for work that does not exist.\n\nFor \`prototype\`: stamp \`complete\` ONLY on an idea whose body you gave its own \`## ${DESIGN_SPEC_SECTION_HEADING}\` section above — for that idea the claim "this idea's screens are designed" is true and evidenced by the section. Leave every OTHER idea unstamped: launch's prototype pass ran once over the whole concept, and \`incomplete\` is the truthful state for an idea it never drew, while \`skipped\` would read as "declared not applicable" and tell every later run never to prototype it. Never stamp \`prototype\` on an idea with no design-spec section of its own, however the gate resolved.`;
    case 'expand-spec':
      return `${H}For EACH idea you expand, immediately AFTER that idea's \`cyboflow_update_task\` body write lands — per idea as you finish it, never once at the end for the batch, and never before the write:\n\n- \`cyboflow_set_idea_component(idea_id: <the idea>, component: 'idea-spec', state: 'complete')\`.\n- On the ONE idea carrying the folded \`## Architecture design\` section, ALSO re-stamp \`component: 'architecture', state: 'complete'\`. This is not redundant with the \`ideas\` step's stamp: replacing the stub with \`## Idea spec\` registers as a spec change, which marks the whole downstream set (architecture, prototype, epics, stories) stale by MATERIALIZING a ledger row for each — and a materialized row wins over derivation permanently. The architecture section itself was preserved verbatim, so it is still valid; without the re-stamp the idea ends the run reading "architecture needs review" over a body that carries a perfectly good architecture section.\n- On EACH idea that both carries a \`## ${DESIGN_SPEC_SECTION_HEADING}\` section (you preserved it verbatim per the persistence contract) and already has an approved design bound to it — \`cyboflow_get_task\` reports one under \`approved_design\` — ALSO re-stamp \`component: 'prototype', state: 'complete'\`, for exactly the reason above: your rewrite marked it stale, the design it refers to did not change, and leaving it stale sends the next run to re-prototype a screen that is already designed and approved. Do NOT stamp \`prototype\` on an idea missing either half.\n\nAn unstamped component is indistinguishable from work never done, so the next Planner run on this idea rewrites the spec you just wrote.`;
    case 'epics':
      return `${H}Do NOT stamp the \`epics\` component here. An idea's epic situation is not settled until the \`tasks\` step, which mints a fallback epic for any idea that turns out to have more than one task — a \`skipped\` stamped now would be wrong for every idea that is about to get one. The \`tasks\` step stamps both \`epics\` and \`stories\`.`;
    case 'tasks':
      return `${H}Once an idea's tasks exist, stamp its ledger — AFTER the creates, per idea, never once for the batch:\n\n- \`cyboflow_set_idea_component(idea_id: <the idea>, component: 'stories', state: 'complete')\`.\n- \`cyboflow_set_idea_component(idea_id: <the idea>, component: 'epics', state: …)\` — \`'complete'\` when the idea ended up with an epic (delegated at the \`epics\` step or minted as the fallback here), \`'skipped'\` for a single-task idea that correctly got none.\n\nAn idea left reading \`incomplete\` for \`epics\` and \`stories\` sends the next Planner run to re-decompose tasks that already exist.`;
    default:
      return '';
  }
}

/**
 * The long-form planner/ship prompts condition these design steps on flags that
 * context persisted into the idea body. Each programmatic step gets a fresh
 * turn, so mirror that decision here before it can delegate or create an
 * artifact. Other optional steps have no equivalent persisted prerequisite.
 *
 * LAUNCH is the exception: its design phase runs on the WHOLE CONCEPT before
 * any idea exists, so the flags live at the end of the approved project brief
 * (threaded into the prompt as the `# Project brief` section), never on ideas.
 */
function conditionalExecution(step: WorkflowStep, workflowName: string, hasRunOwnedIdeas: boolean): string {
  if (workflowName === 'launch') {
    switch (step.id) {
      case 'ui-prototype':
        return `\n\n## Conditional execution\n\nThis flow designs the WHOLE concept before decomposition — condition on the \`# Project brief\` section above, never on ideas. Run this step ONLY when the brief carries \`UI_PROTOTYPE: yes\` (when the brief has no such flag line, judge from the brief itself whether the product has user-facing UI — a CLI/API/library does not). On yes: build ONE whole-product concept mockup from the full brief, showing the core loop end to end. Otherwise skip cleanly: do not delegate, do not write prototype files, do not report an artifact, and end with a one-line skip summary.`;
      case 'architecture':
        return `\n\n## Conditional execution\n\nThis flow designs the WHOLE concept before decomposition — condition on the \`# Project brief\` section above, never on ideas. Run this step ONLY when the brief carries \`ARCH_DESIGN: yes\` (when the brief has no such flag line, run it unless the project is a trivially small single-file tool — most new projects warrant it). On yes: design the PROJECT-LEVEL architecture (stack, repo layout, data model, service seams) from the full brief. Otherwise skip cleanly: do not delegate, do not report anything, and end with a one-line skip summary.`;
      default:
        return '';
    }
  }
  const scope = hasRunOwnedIdeas
    ? 'Read each id in the `## Run-owned idea scope` section directly with `cyboflow_get_task`. Do NOT enumerate project ideas or infer an active idea from other project ideas. Evaluate flags only on these run-owned ideas; when more than one is eligible, handle each eligible idea rather than choosing one.'
    : 'This run has no owned idea yet. Skip this step cleanly: do not list project ideas, infer an active idea, delegate, or create an artifact.';
  switch (step.id) {
    case 'ui-prototype':
      return `\n\n## Conditional execution\n\n${scope} Run this step ONLY for scoped ideas whose persisted spec contains \`UI_PROTOTYPE: yes\`. When no scoped idea has that flag, skip this step cleanly: do not delegate, do not write prototype files, do not report an artifact, and end with a one-line skip summary.`;
    case 'architecture':
      return `\n\n## Conditional execution\n\n${scope} Run this step ONLY for scoped ideas whose persisted spec contains \`ARCH_DESIGN: yes\`. When no scoped idea has that flag, skip this step cleanly: do not delegate, do not change an idea body, and end with a one-line skip summary.`;
    default:
      return '';
  }
}

export function composeStepPrompt(args: ComposeStepPromptArgs): string {
  const { step, workflowName, attempt } = args;
  const retryNote =
    attempt > 1
      ? `\n\nThis is **attempt ${attempt}** — a previous attempt at this step did not complete. Diagnose what went wrong and try again.`
      : '';
  const desc = step.desc !== undefined && step.desc.length > 0 ? `\n\n${step.desc}` : '';
  const itemNote = args.item
    ? `\n\nThis step is part of a PARALLEL fan-out over **${args.item.over}**. You are working on item **${args.item.id}** ONLY — do not touch other items.`
    : '';
  const taskScope =
    args.taskScope !== undefined && args.taskScope.trim().length > 0
      ? `\n\n# Sprint tasks\n\n${args.taskScope.trim()}\n\nThese are the EXACT tasks in scope for this sprint — the cyboflow database is their source of truth. When this step needs the task set (e.g. dependency analysis or per-task work), use THIS list and pass it to your subagent; do NOT hunt for task files in the worktree to discover scope (cyboflow keeps no task files on disk, so you will find none and wrongly conclude there is nothing to do).`
      : '';
  const runOwnedIdeaIds = [...new Set(args.runOwnedIdeaIds?.filter((id) => id.trim().length > 0) ?? [])];
  const runOwnedIdeaScope =
    runOwnedIdeaIds.length > 0
      ? `\n\n## Run-owned idea scope\n\nThis run owns only these idea ids: ${runOwnedIdeaIds.map((id) => `\`${id}\``).join(', ')}. This scope is authoritative for idea-specific work; do not inspect or select unrelated project ideas.`
      : '';
  // Heading kept byte-identical to APPROVE_IDEAS_DECISIONS_HEADING
  // (resolveReviewItemHandler) — the contract the flow prose keys the resumed
  // agent on. Not imported: stepPrompt stays free of orchestrator-module imports.
  const approveIdeasDecisions =
    args.approveIdeasDecisions !== undefined && args.approveIdeasDecisions.trim().length > 0
      ? `\n\n# Approve-ideas decisions\n\nThe human resolved this run's approve-ideas batch gate with these per-idea decisions:\n\n${args.approveIdeasDecisions.trim()}\n\nThis verdict list is authoritative for idea-specific work: act on the APPROVED refs only. DENIED ideas stay on the backlog untouched — never expand, design, decompose, or archive them.`
      : '';
  const projectBrief =
    args.projectBrief !== undefined && args.projectBrief.trim().length > 0
      ? `\n\n# Project brief\n\nThe run's APPROVED project brief — the constitution every post-brief step grounds in (a programmatic step turn cannot read artifacts, so it is threaded here):\n\n${args.projectBrief.trim()}`
      : '';
  // Rendered immediately AFTER `# Project brief`: both are run-level grounding a
  // fresh step turn cannot fetch for itself, and the brief (when present) is the
  // wider context the designs sit inside.
  const designSurfaces =
    args.designSurfaces !== undefined && args.designSurfaces.trim().length > 0
      ? `\n\n${args.designSurfaces.trim()}`
      : '';
  // Only the budget lines for THIS step's agent render: an implement turn has no
  // use for the architecture ceiling, and a prompt that lists every agent's budget
  // teaches the agent to skim the section it actually has to obey. An agent with
  // no entry at this level renders the level line alone — still useful context,
  // and honest about there being no extra constraint.
  const thoroughness = args.solutionThoroughness;
  const thoroughnessBudget =
    thoroughness !== undefined
      ? THOROUGHNESS_BUDGETS[thoroughness][step.agent as ThoroughnessBudgetAgent]
      : undefined;
  const solutionThoroughness =
    thoroughness === undefined
      ? ''
      : `\n\n# Solution thoroughness: ${thoroughness}\n\nThe human set this project's thoroughness to **${thoroughness}**. It is a deliberate choice about how finished this software has to be, not a hint${
          thoroughnessBudget !== undefined ? ', and the budget below OVERRIDES your role\'s defaults wherever the two disagree' : ''
        }.${thoroughnessBudget !== undefined ? `\n\n${thoroughnessBudget}` : ''}`;
  const runbookProposal =
    args.runbookProposal !== undefined && args.runbookProposal.trim().length > 0
      ? `\n\n# Approved runbook proposal\n\nThis run's \`derive\` step published this proposal and the human APPROVED it at the \`approve-runbook\` gate. It is authoritative — write the runbook, the machine-local bindings, and the rung-1/rung-2 edits exactly as they stand here. Do NOT re-derive, re-survey, or "improve" any command, attestation, or lever: a proposal the human approved and a runbook you re-invented are different documents, and only the first was reviewed. If something in it is genuinely wrong, say so in your summary and fire the proof against it anyway so the failure is diagnosed against what was approved.\n\n` + args.runbookProposal.trim()
      : '';
  // The programmatic gate reduces to approve/reject/revise, so a bare verdict
  // word carries nothing prove can act on — only a human's added qualification
  // does. Rendering the bare word would be prompt noise that reads like a
  // trimming instruction when there is none.
  const gateNote = (args.approveRunbookResolution ?? '').trim();
  const approveRunbookResolution =
    gateNote.length > 0 && !/^(approve|approved|reject|revise|retry)$/i.test(gateNote)
      ? `\n\n## Gate note from the human\n\nThe human resolved the \`approve-runbook\` gate with this note:\n\n` + `> ${gateNote}` + `\n\nRead it as a qualification of the approved proposal above (e.g. a modality or a rung change to leave out). If it says nothing beyond approving, the proposal stands whole.`
      : '';
  // verify-setup's `prove` is the one step in any flow whose work is WRITING,
  // committing, registering, and firing a verification — everything the generic
  // "delegate to the `cyboflow-<agent>` role" prose in step 1 sends to a role
  // that is contractually read-only. It is also safety-sensitive (it registers
  // revisions, spends real verification budget, and must never claim a runbook
  // proven itself), and the step's one-line `desc` cannot carry the procedure.
  // Keyed on the flow + step id rather than the agent key, which
  // `inspect`/`derive` share.
  //
  // F10 (docs/proposals/visual-verification-brittleness-fixes.md): the DB record
  // is the authoritative store — the runner fetches the registered
  // `portable_json` by content hash and never reads the snapshot's file — so
  // this prose no longer tells the agent that an uncommitted runbook makes every
  // proof judge an empty tree. Committing is what makes the runbook a
  // reviewable EXPORT, and `committed: false` is a warning, not a blocker.
  const proveContract =
    workflowName === 'verify-setup' && step.id === 'prove'
      ? `\n\n## Prove-step contract (verify-setup) — overrides step 1 above\n\nYou do this step YOURSELF. Do NOT delegate it: the \`cyboflow-verify-setup\` role is a read-only surveyor/drafter (\`tools: Read, Grep, Glob, Bash\`, and its own contract says it never writes repo files, never writes cyboflow state, and never commits), so handing it this step hands the work to a role that cannot perform it. Its drafting is already done — it lives in the approved proposal above.\n\nIn this order:\n\n1. **Write and commit the portable half.** Write \`.cyboflow/verify-runbook.json\` (the portable half ONLY — placeholders, never a resolved port or temp dir) plus the APPROVED rung-1/rung-2 changes, and commit atomically. **\`git add\` on this path silently does nothing in many projects**: \`.cyboflow/\` is where cyboflow keeps worktrees and local state, so it is very often in \`.gitignore\` or \`.git/info/exclude\`, and \`git add\` on an ignored path is a no-op that reports success. Stage it with \`git add -f .cyboflow/verify-runbook.json\` and CONFIRM the commit really contains it with \`git cat-file -e HEAD:.cyboflow/verify-runbook.json\` before going further. The proof itself does NOT read this file: the runner executes the REGISTERED record's \`portable_json\`, fetched by content hash from the machine-local store, so an uncommitted runbook still proves. Commit it because the committed file is the human-reviewable EXPORT of what you registered — what a reviewer diffs and what another machine re-registers from — and because a file that exists only in your working tree drifts out of the record with nothing to catch it.\n2. **Register each approved modality** with \`cyboflow_register_verify_runbook\`, passing the machine-local \`bindings_json\` from the proposal. Quote the returned \`hash\` and \`version\` in your summary. A \`committed: false\` in the reply is a WARNING, not a blocker: proving works either way, but the reviewable export is not in HEAD — the usual cause is an ignored \`.cyboflow/\`, so re-stage with \`git add -f\`, commit, and register again so the committed file matches the record you are proving.\n3. **Prove each modality by RUNNING it**, one at a time. Compose the \`VerificationTaskV1\` FROM the runbook you just committed — its build steps, its serve form, its attestation, verbatim — not from memory and not from what you would have preferred; a composed task that does not match the registered runbook is rejected as a \`runbook/sha mismatch\` and proves nothing. Fire \`cyboflow_request_verification\` with \`setup_proof: true\` and the \`runbook_hash\` + \`runbook_local_version\` you just got back, then BLOCK on \`cyboflow_await_verification\`. Do not poll, do not continue past the await, and do not fire the next modality until this one has returned.\n4. **Never mark a runbook proven.** Only a PASSING \`setup_proof\` request does, via the engine. Report what came back and claim nothing beyond it.\n5. **On FAIL, read \`failureClass\` first** — \`env\` means fix the ISOLATION lever, \`deliverable\` means fix the commands, \`ambiguous\` means narrow the proof — then re-write, re-commit, re-register (the hash changed), and re-prove. At most 3 rounds per modality. On exhaustion the unproven draft STAYS committed and registered: write the diagnosis into your summary and into the proposal artifact, and finish the step. That is a completed run, not a failure.\n\nRe-report the \`verify-runbook\` artifact at the end, enriching the approved proposal with the per-modality proof outcomes so the human's merge gate sees what actually happened.`
      : '';
  const artifactNote =
    step.outputArtifact !== undefined ? artifactFollowUp(step.outputArtifact, workflowName) : '';
  // Task-verify relay contract (verification-agent redesign §5.1; live-smoke fix
  // 2026-07-22): this step turn's FINAL MESSAGE is the typed step-output channel
  // the controller parses for the VERDICT line + the visual-verification
  // contract. The generic prose actively fights that — step 3 says "one-line
  // summary" (which summarized the fence away) and step 1 says "persist every
  // ACTION via cyboflow_* tools" (which turned the composed verification task
  // into a live cyboflow_request_verification call + a self-parked lane). Both
  // observed on the first live run. This note overrides them for task-verify.
  const taskVerifyRelayNote =
    step.agent === 'task-verify' || step.id === 'task-verify'
      ? `\n\n## Final message contract (task-verify) — overrides steps 1 and 3 above\n\nYour final message IS the machine-read verdict channel for this lane; the controller parses it directly. After your \`cyboflow-task-verify\` subagent returns:\n\n- RELAY, do not summarize: end your final message with the subagent's literal \`VERDICT: PASS\` / \`VERDICT: FAIL\` line, and on PASS with EXACTLY ONE of the subagent's \`## Visual verification task\` section (its \`\`\`json fence copied byte-for-byte) or its bare \`VISUAL-VERIFICATION: NOT-APPLICABLE — <reason>\` line. Dropping or paraphrasing these is an output-contract failure that fails this lane after one retry.\n- The composed verification task is TEXT for the controller, NEVER an action for you: do NOT call \`cyboflow_request_verification\`, do NOT set the lane to \`awaiting-verify\` via \`cyboflow_update_sprint_task\`, and do NOT delegate to any visual-verify subagent. The controller fires the request from the fence you print and parks the lane itself.`
      : '';
  // Address-review findings contract (sprint/ship): this step is the ONLY one
  // whose input is the run's own review queue, and the generic "record every item
  // the subagent returns" prose does not describe it — nothing is being recorded
  // here, findings are being READ BACK and closed out. Two things a step agent
  // cannot infer: the ids exist only via `cyboflow_list_run_findings` (report_
  // finding is fire-and-forget and never returned them), and the three verdicts
  // map to DIFFERENT dispositions — resolving a DEFERRED finding would silently
  // delete the exact backlog entry this stage exists to preserve.
  const addressReviewNote =
    step.agent === 'address-review' || step.id === 'address-review'
      ? `\n\n## Findings contract (address-review) — how this step gets its input and closes it out\n\nThis step acts on the findings THIS run already filed; it does not produce new ones.\n\n1. Call \`cyboflow_list_run_findings\` (read-only, no arguments) FIRST. It returns every still-open finding this run's session filed — each task lane's \`code-review\` \`## Findings\`, \`sprint-review\`'s, and the code-review eval jury's — with the \`id\` each one needs to be resolved. Do NOT reconstruct this list from your own context: \`cyboflow_report_finding\` never returns the minted id, and most of these were filed by lanes you never saw. An empty list means there is nothing to do — say so and stop.\n2. Delegate to \`cyboflow-address-review\`, passing the findings verbatim (id, title, body, category, severity, locations, suggested fix).\n3. **Settle the code BEFORE you resolve anything.** If the subagent changed any files, re-run the project's FULL test suite yourself. This step runs AFTER the sprint's full-suite verification, so that verification is now stale with respect to your edits — and the subagent only ran the targeted tests covering the files it touched, which cannot see a cross-module regression. If the full suite fails, re-delegate \`cyboflow-address-review\` ONCE to repair or revert its own fixes and re-run the suite. If it STILL fails, file a BLOCKING finding via \`cyboflow_report_finding\` (\`blocking: true\`, category \`address-review-regression\`) carrying the failing tests and what was changed, and say so in your summary. That finding is the durable signal — your summary prose is not machine-read, so a blocking review item is the only thing that actually parks the run before the human's merge gate instead of letting a red tree slide into it. This is the ONE exception to "do not file new findings from this step", and it qualifies precisely because no further retry or loopback in this chain will fix it. The next step is the human's merge gate, and it must not open over a tree whose suite has not passed since the last edit. Then commit per step 2 above with a message naming the findings addressed. If the subagent changed NO files, skip straight to step 4.\n4. **Only now** act on its \`## Disposition\`, one entry per finding id, using the disposition as it stands AFTER step 3 — the verdicts are NOT interchangeable:\n   - **FIXED, and the fix survived step 3** → \`cyboflow_resolve_finding\` with \`resolution_kind: 'fixed'\` and a \`note\` naming what changed.\n   - **FIXED, but the fix was reverted or dropped in step 3** → leave it OPEN, exactly like a DEFERRED one. The code no longer carries the fix, so the finding is not fixed.\n   - **INVALID** → \`cyboflow_resolve_finding\` with \`resolution_kind: 'triaged'\` and a \`note\` carrying the refutation.\n   - **DEFERRED** → do NOTHING. Leave it open. It is a real issue deliberately left for the human gate, and resolving it would erase the one record of it. The same applies to any id the subagent omitted or gave a verdict outside those three — never guess a disposition.\n\nNever resolve a finding before its fix is verified and committed: resolving is IRREVERSIBLE (there is no un-resolve tool), so a finding closed as \`fixed\` whose fix is then reverted — or lost to a crash before the commit — leaves a real defect in the branch with its only record already closed. Resolution is the cheapest, most repeatable action in this chain; it goes last precisely because everything before it can fail.\n\nDo NOT file new findings from this step, and do NOT widen the change beyond the filed findings.`
      : '';
  // The bootstrap's own files, appended to the address-review contract above.
  // Deliberately a SEPARATE const rather than interpolated into that one: the
  // address-review note is a fixed contract, and this is per-run data that is
  // absent on almost every run — keeping them apart is what makes the common
  // prompt byte-identical to what it was.
  const bootstrapDenylistNote =
    (step.agent === 'address-review' || step.id === 'address-review') &&
    args.bootstrapProtectedPaths !== undefined &&
    args.bootstrapProtectedPaths.length > 0
      ? `\n\n## Files this run's verification bootstrap wrote — do NOT touch them\n\nThis run derived and proved its own verification runbook, and committed these files:\n\n${args.bootstrapProtectedPaths
          .map((p) => `- \`${p}\``)
          .join(
            '\n',
          )}\n\nLeave them exactly as they are, even if a finding appears to be about one of them, and even if one looks wrong to you. The runbook's proof is content-addressed against the committed file, so ANY edit to it — including a correct one — invalidates the proof and the next verification silently skips. The configuration change is what makes this project stand up for verification at all; reverting it un-proves the environment while the runbook still claims otherwise. If you believe one of these files is genuinely wrong, file a finding saying so and leave the file alone.\n\nRelay this list to \`cyboflow-address-review\` verbatim when you delegate — it cannot see this prompt.`
      : '';
  const conditionalExecutionNote = conditionalExecution(step, workflowName, runOwnedIdeaIds.length > 0);
  const ideaFlagContractNote = ideaFlagContract(step);
  const ideaLedgerContractNote = ideaLedgerContract(step, workflowName);
  // Compound review-queue discipline — applies to EVERY compound step, not just
  // the one that reports the artifact. The compounder surfaces below-bar
  // candidates in a `## Discarded` list; a step agent that faithfully "records
  // every item the subagent returns" used to file one blocking `decision` per
  // drop, spamming the review queue with sequential approve/resume gates
  // (observed on load-sprint, which has no outputArtifact so the addendum above
  // never reaches it). This guard reaches all steps and pins the single-review
  // contract: drops go in the doc; Compound emits NO `decision` items at all — its
  // two human gates are both workflow STEPS (approve-learnings + the terminal
  // human-review "merge in changes" gate), never a reported decision, never per-drop.
  const compoundGuard =
    workflowName === 'compound'
      ? `\n\n## Compound review-queue discipline\n\nThe \`cyboflow-compounder\` subagent may return a \`## Discarded\` list of candidates it considered and set aside. These are CONTEXT, not actions: NEVER file a discarded candidate as a \`cyboflow_report_finding\` (\`decision\` or \`finding\`) or any other review-queue item. Discarded candidates belong ONLY in the \`## Discarded\` section of the \`compound-recommendations\` doc (composed at the \`extract\` step). Compound has exactly TWO human gates and BOTH are workflow STEPS: the \`approve-learnings\` question, and the terminal \`human-review\` step — a "merge in changes" gate over the applied diff (Approve / Reject), just like a Sprint/Ship human-review. Compound emits NO \`decision\` review items anywhere — not at \`write-back\`, not per doc edit, not per drop. write-back APPLIES every approved change in-place, commits, and reports no review item; per-item gates are the sequential-gate spam this flow must never produce.`
      : '';
  // ONE `## Operator guidance` section carries BOTH mid-run guidance channels:
  // the operator's own steer for this STEP, and the supervisor's rescue guidance
  // for this LANE. They are labelled separately (the agent needs to know a rescue
  // is a correction after a real failure, not a preference) but share the heading
  // so no agent has to learn two section names for the same kind of instruction.
  // With only `userGuidance` present the rendered text is byte-identical to the
  // single-channel version this replaces.
  const guidanceBlocks: string[] = [];
  if (args.userGuidance !== undefined && args.userGuidance.trim().length > 0) {
    guidanceBlocks.push(
      `The operator added mid-run guidance for this step — follow it:\n\n${args.userGuidance.trim()}`,
    );
  }
  if (args.laneGuidance !== undefined && args.laneGuidance.trim().length > 0) {
    guidanceBlocks.push(
      `The run's SUPERVISOR rescued this task's lane after it failed, and left guidance for the re-run. The previous attempt failed WITHOUT it — follow it:\n\n${args.laneGuidance.trim()}`,
    );
  }
  const userGuidance =
    guidanceBlocks.length > 0 ? `\n\n## Operator guidance\n\n${guidanceBlocks.join('\n\n')}` : '';
  // Visual-verification output-contract re-run (§5.1/§5.3): a task-verify PASS
  // result MUST contain EXACTLY ONE of a `## Visual verification task` fence or a
  // `VISUAL-VERIFICATION: NOT-APPLICABLE — <reason>` line. The previous attempt
  // violated that, so quote the exact defect and demand a compliant re-emit.
  const contractError =
    args.contractError !== undefined && args.contractError.trim().length > 0
      ? `\n\n## Visual-verification output contract (fix required)\n\nYour previous result violated the visual-verification output contract:\n\n> ${args.contractError.trim()}\n\nRe-emit your FULL result. On \`VERDICT: PASS\` it MUST contain EXACTLY ONE of:\n\n- a \`## Visual verification task\` section whose body is a single fenced \`\`\`json code block holding the \`VerificationTaskV1\` payload, or\n- a single line \`VISUAL-VERIFICATION: NOT-APPLICABLE — <one-line reason>\` when this task has no user-visible UI to verify.\n\nInclude exactly one of those forms (never both, never neither, never a duplicate). Print it as TEXT in your final message — do NOT call \`cyboflow_request_verification\` or park the lane yourself; the controller fires the request from what you print. If a previous attempt already fired a request, still print the contract — the controller reconciles.`
      : '';
  // Prior-step handoff: the previous AGENT step's final text, for a step that
  // declares `consumesPriorStepOutput`. A programmatic step is a fresh turn, so
  // this is the only way a chain like Compound's load → extract carries anything
  // forward. An unavailable channel says so rather than rendering nothing —
  // silence would read as "the previous step found nothing".
  const prior = args.priorStepOutput;
  const priorText = prior?.text?.trim() ?? '';
  const priorStepOutput =
    prior === undefined
      ? ''
      : priorText.length > 0
        ? `\n\n## Previous step output\n\nThe **${prior.name}** step ran before you and returned this. It is your INPUT: this step runs as a fresh turn with no memory of it, and it will not be repeated anywhere else.\n\n${priorText}`
        : `\n\n## Previous step output\n\nThe **${prior.name}** step ran before you, but its output could not be captured on this substrate — so the summary this step's instructions say you were handed is NOT below. Do not treat that as "the previous step found nothing": re-derive what you need from the repository and the cyboflow database, and say in your result that you did so.`;
  // Visual merge-gate FAIL loopback feedback (§5.3): the re-delegated implement
  // agent is handed WHAT was tested, what failed, and why — verbatim — not merely
  // "a blocking finding exists".
  const loopbackFeedback =
    args.loopbackFeedback !== undefined && args.loopbackFeedback.trim().length > 0
      ? `\n\n## Visual verification failed (previous attempt)\n\nThe visual verification of your previous attempt FAILED. Fix the issues it reports before re-running — here is its report verbatim:\n\n${args.loopbackFeedback.trim()}`
      : '';

  // Human gate 'revise' feedback. Distinct from loopbackFeedback (visual
  // verification) on purpose — see ComposeStepPromptArgs.gateRevision. Byte-gated:
  // absent on every turn no gate sent back.
  const revision = args.gateRevision;
  const revisionNote = (revision?.note ?? '').trim();
  const revisionReview = (revision?.reviewMarkdown ?? '').trim();
  const gateRevision =
    revision === undefined
      ? ''
      : `\n\n## Design gate: revision requested\n\nA human reviewed this run's design at the \`${revision.gateStepId}\` gate and sent it back. You are part of the RE-RUN: your previous output was not accepted, and repeating it unchanged wastes the revision. Produce a revised result that answers what is below, and say plainly in your summary what you changed.${
          revisionNote.length > 0
            ? `\n\nThe reviewer's own words, verbatim — this is the authoritative instruction and it outranks the review below where the two disagree:\n\n> ${revisionNote.replace(/\n/g, '\n> ')}`
            : revisionReview.length > 0
              ? `\n\nThe reviewer left no note beyond the decision, so the adversarial review below is your specification for what to fix.`
              : `\n\nThe reviewer left no note and this run has no adversarial review to work from, so you have the decision and nothing else. Re-examine your previous output against the spec and the brief, fix what you judge weakest, and state that judgement explicitly in your summary — do NOT re-emit the same result and do NOT ask a question; nothing in this step can answer one.`
        }${
          revisionReview.length > 0
            ? `\n\n### Adversarial review of the previous round\n\nAddress EVERY entry under \`## Blocking\`. State in your output which \`AR-n\` ids you resolved and how; an id you deliberately did not resolve must be named with your reason, never silently dropped. Entries under \`## Findings\` are advisory — fix them when cheap.\n\n${revisionReview}`
            : ''
        }`;

  return `You are executing **one step** of the "${workflowName}" workflow in this git worktree.

Step: **${step.name}** (id: \`${step.id}\`)${desc}${itemNote}${taskScope}${solutionThoroughness}${projectBrief}${designSurfaces}${runbookProposal}${approveRunbookResolution}${runOwnedIdeaScope}${approveIdeasDecisions}

Do ONLY this step:

1. **Do the work.** Delegate to the \`cyboflow-${step.agent}\` role. On the Claude runtime, use the Task tool with that EXACT \`subagent_type\` — it is installed in this worktree's \`.claude/agents/\`, so do NOT fall back to \`general-purpose\`. On another runtime, follow its provider adapter for the equivalent native delegation type. Pass the role the context it needs (including the task scope above when relevant) and read its result. Persist every cyboflow state change yourself via the \`cyboflow_*\` MCP tools, recording EVERY item the subagent returns that is an ACTION to persist — e.g. call \`cyboflow_add_task_dependency\` for each edge it reports; never collapse a non-empty result to "none". This does NOT mean filing context-only sections the subagent returns for the operator's or a doc's benefit (e.g. a Compound \`## Discarded\` list) as review items — follow any workflow-specific review-queue discipline below. You are the single writer; subagents are edit-only.
2. **Commit file changes atomically.** If this step changes repository files, make ONE git commit (\`<type>: <what changed>\`), staging only the files this step touched. For DB-only, analysis, review, or artifact-reporting work, do not make a git commit. Never create an empty commit.
3. **Stop.** Do NOT start any other step — the host orchestrator sequences the workflow and will invoke the next step itself. Report a one-line summary of what this step produced, then end your turn.

The cyboflow database is the single source of truth: never read on-disk or worktree state files (e.g. a plugin state directory) to decide the task set or a task's status — any such file is NOT cyboflow's source of truth and may be stale or absent.${conditionalExecutionNote}${ideaFlagContractNote}${ideaLedgerContractNote}${compoundGuard}${artifactNote}${proveContract}${taskVerifyRelayNote}${addressReviewNote}${bootstrapDenylistNote}${userGuidance}${gateRevision}${contractError}${priorStepOutput}${loopbackFeedback}${retryNote}`;
}
