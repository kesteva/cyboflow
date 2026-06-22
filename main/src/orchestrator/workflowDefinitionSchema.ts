/**
 * Strict zod write-path validation for user-edited / custom `WorkflowDefinition`s.
 *
 * Type contract: `shared/types/workflows.ts` (`WorkflowDefinition` and friends).
 *
 * This module is the AUTHORITATIVE validator for any definition about to be
 * persisted (updateSpec / createCustom) or accepted as tRPC `.input()`. It is
 * intentionally stricter than the lenient READ-path helpers in
 * `shared/types/workflows.ts` (`parseWorkflowDefinition`): in addition to
 * structural shape it enforces kebab-case ids, hex phase colours, and the
 * uniqueness + intra-phase loopback invariants.
 *
 * Main-only on purpose: the frontend has no zod dependency. Client-side checks
 * stay plain TS; this schema is the single source of validation truth and its
 * `ZodError` is surfaced to the user via TRPCError.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import type {
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../shared/types/workflows';

/** Kebab-case identifier, e.g. `'task-verify'` — used for step and phase ids. */
const kebabCaseId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case (lowercase letters, digits, single hyphens)');

/** 7-character hex colour, e.g. `'#3b6dd6'`. */
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour, e.g. #3b6dd6');

/**
 * One inner step of a fan-out chain. Mirrors `FanOutInnerStep`. Inner-id
 * uniqueness and inner-loopback targeting are enforced at the definition level
 * (they need sibling context — see `superRefine`).
 */
const fanOutInnerStepSchema = z.object({
  id: kebabCaseId,
  agent: z.string().min(1, 'fan-out inner step agent is required'),
  optional: z.boolean().optional(),
  loopback: z.string().optional(),
  name: z.string().optional(),
});

/**
 * A fan-out spec: an item-source key (`over`) plus a non-empty ordered inner
 * chain. Mirrors `FanOutSpec`.
 */
const fanOutSchema = z.object({
  over: z.string().min(1, 'fanOut.over is required'),
  inner: z.array(fanOutInnerStepSchema).min(1, 'fanOut.inner needs at least one step'),
});

/**
 * A single step. Required: id (kebab), name, agent. Optional fields mirror
 * `WorkflowStep`. No invariants are enforced here — uniqueness and loopback
 * targeting are validated at the definition level (they need sibling context).
 */
export const workflowStepSchema = z.object({
  id: kebabCaseId,
  name: z.string().min(1, 'step name is required'),
  agent: z.string().min(1, 'step agent is required'),
  mcps: z.array(z.string()),
  retries: z.number().int().min(0, 'retries must be a non-negative integer'),
  optional: z.boolean().optional(),
  human: z.boolean().optional(),
  loopback: z.string().optional(),
  desc: z.string().optional(),
  fanOut: fanOutSchema.optional(),
}) satisfies z.ZodType<WorkflowStep>;

/**
 * A phase: kebab id, non-empty label, hex colour, and at least one step.
 * Per-phase step-id uniqueness and intra-phase loopback targeting are enforced
 * by the definition-level `superRefine` (which has access to all phases).
 */
export const workflowPhaseSchema = z.object({
  id: kebabCaseId,
  label: z.string().min(1, 'phase label is required'),
  color: hexColor,
  steps: z.array(workflowStepSchema).min(1, 'a phase must have at least one step'),
}) satisfies z.ZodType<WorkflowPhase>;

/**
 * Full definition: non-empty id and at least one phase, plus cross-cutting
 * invariants enforced in `superRefine`:
 *   - phase ids unique across the definition
 *   - step ids unique within each phase
 *   - every `loopback` references a step id in the SAME phase (intra-phase only)
 */
export const workflowDefinitionSchema = z
  .object({
    id: z.string().min(1, 'definition id is required'),
    phases: z.array(workflowPhaseSchema).min(1, 'a workflow must have at least one phase'),
  })
  .superRefine((definition, ctx) => {
    const seenPhaseIds = new Set<string>();

    definition.phases.forEach((phase, phaseIndex) => {
      // Phase ids unique across the definition.
      if (seenPhaseIds.has(phase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate phase id '${phase.id}'`,
          path: ['phases', phaseIndex, 'id'],
        });
      }
      seenPhaseIds.add(phase.id);

      // Step ids unique within this phase.
      const seenStepIds = new Set<string>();
      phase.steps.forEach((step, stepIndex) => {
        if (seenStepIds.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate step id '${step.id}' in phase '${phase.id}'`,
            path: ['phases', phaseIndex, 'steps', stepIndex, 'id'],
          });
        }
        seenStepIds.add(step.id);

        // Per-step fan-out invariants: inner ids unique, inner loopbacks
        // reference an inner id within the SAME chain.
        if (step.fanOut !== undefined) {
          const seenInnerIds = new Set<string>();
          step.fanOut.inner.forEach((inner, innerIndex) => {
            if (seenInnerIds.has(inner.id)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `duplicate fan-out inner step id '${inner.id}' in step '${step.id}'`,
                path: ['phases', phaseIndex, 'steps', stepIndex, 'fanOut', 'inner', innerIndex, 'id'],
              });
            }
            seenInnerIds.add(inner.id);
          });
          step.fanOut.inner.forEach((inner, innerIndex) => {
            if (inner.loopback !== undefined && !seenInnerIds.has(inner.loopback)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `fan-out loopback '${inner.loopback}' must reference an inner step id within step '${step.id}'`,
                path: ['phases', phaseIndex, 'steps', stepIndex, 'fanOut', 'inner', innerIndex, 'loopback'],
              });
            }
          });
        }
      });

      // Loopback targets must be intra-phase (reference a step in this phase).
      phase.steps.forEach((step, stepIndex) => {
        if (step.loopback !== undefined && !seenStepIds.has(step.loopback)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `loopback '${step.loopback}' must reference a step id within phase '${phase.id}'`,
            path: ['phases', phaseIndex, 'steps', stepIndex, 'loopback'],
          });
        }
      });
    });
  }) satisfies z.ZodType<WorkflowDefinition>;

// ---------------------------------------------------------------------------
// Compile-time drift bridge
// ---------------------------------------------------------------------------

// Ensures the schema output stays assignable to the shared WorkflowDefinition
// type. `tsc --noEmit` errors here if the schema drifts from the type contract.
const _typeCheck: WorkflowDefinition = {} as z.infer<typeof workflowDefinitionSchema>;
void _typeCheck;

/**
 * Parse and validate an unknown value as a `WorkflowDefinition`.
 * Throws `ZodError` on failure (caller maps to a TRPCError / BAD_REQUEST).
 */
export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(input);
}
