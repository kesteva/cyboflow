/**
 * Human-gate resolution for the programmatic model (Stage 2). In the orchestrated
 * model an agent calls AskUserQuestion at a human gate; in the programmatic model
 * the HOST must pause and await a human decision. This module provides:
 *
 *   - `HumanGateResolver` — the narrow interface the ControllerHost depends on
 *     (so the host is testable with a fake), returning the three-way verdict.
 *   - `parseGateVerdict` — pure mapping of a free-text review-item `resolution`
 *     string to 'approve' | 'reject' | 'revise'.
 *   - `ReviewQueueHumanGate` — the production resolver: it opens a BLOCKING
 *     decision review item via the injected gate opener (in production
 *     `HumanStepManager.openHumanGate`, which also parks the run in
 *     awaiting_review), then awaits that item's resolution on the injected review
 *     emitter (`reviewItemChangeEvents`) and maps the resolution to a verdict.
 *
 * The opener + emitter are injected (not imported concretely) so the resolver is
 * unit-testable end-to-end; only the composition-root wiring of the real
 * HumanStepManager + reviewItemChangeEvents is left un-fakeable.
 */
import type { EventEmitter } from 'events';
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';
import type { HumanGateDecision } from './types';

export interface HumanGateRequest {
  runId: string;
  projectId: number;
  step: WorkflowStep;
}

/** What the ControllerHost depends on to resolve a human gate. */
export interface HumanGateResolver {
  resolve(req: HumanGateRequest): Promise<HumanGateDecision>;
}

/**
 * Opens a blocking human-decision gate for a run+step and returns the minted
 * review-item id (or null when the gate could not be opened — e.g. the run was
 * not 'running'). Satisfied in production by HumanStepManager.openHumanGate.
 */
export interface HumanGateOpener {
  openHumanGate(runId: string, stepId: string, stepName: string): Promise<string | null>;
}

/**
 * Map a free-text review-item `resolution` to the three-way gate verdict.
 *
 * Convention (mirrors questionRouter's isApproveAnswer string-sniffing): an
 * explicit 'reject' or 'revise' anywhere in the resolution selects that verdict;
 * anything else — including an empty note — is an APPROVE, because resolving the
 * blocking gate item IS the human's act of approval unless they said otherwise.
 */
export function parseGateVerdict(resolution: string | null | undefined): HumanGateDecision {
  const r = (resolution ?? '').trim().toLowerCase();
  if (r.includes('reject')) return 'reject';
  if (r.includes('revise')) return 'revise';
  return 'approve';
}

/** Minimal shape of a review-item change event consumed here (no `any`). */
interface ReviewItemChangeLike {
  reviewItemId: string;
  action: 'created' | 'resolved' | 'dismissed';
  item?: { resolution?: string | null };
}

function isReviewItemChangeLike(v: unknown): v is ReviewItemChangeLike {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.reviewItemId === 'string' && typeof e.action === 'string';
}

export class ReviewQueueHumanGate implements HumanGateResolver {
  constructor(
    private readonly opener: HumanGateOpener,
    private readonly events: EventEmitter,
    private readonly channelFor: (projectId: number) => string,
    private readonly logger?: LoggerLike,
  ) {}

  resolve(req: HumanGateRequest): Promise<HumanGateDecision> {
    const { runId, projectId, step } = req;
    const channel = this.channelFor(projectId);

    return new Promise<HumanGateDecision>((resolve, reject) => {
      // Subscribe BEFORE opening the gate so a fast resolution cannot slip
      // through the gap. The target id is set synchronously once openHumanGate
      // resolves; events for other items (or before the id is known) are ignored.
      let targetId: string | null = null;
      const onChange = (payload: unknown): void => {
        if (targetId === null || !isReviewItemChangeLike(payload)) return;
        if (payload.reviewItemId !== targetId) return;
        if (payload.action === 'resolved') {
          this.events.off(channel, onChange);
          resolve(parseGateVerdict(payload.item?.resolution));
        } else if (payload.action === 'dismissed') {
          // A dismissed gate is treated as a rejection (the human declined it).
          this.events.off(channel, onChange);
          resolve('reject');
        }
      };
      this.events.on(channel, onChange);

      this.opener
        .openHumanGate(runId, step.id, step.name)
        .then((id) => {
          if (!id) {
            this.events.off(channel, onChange);
            reject(new Error(`ReviewQueueHumanGate: could not open human gate for run ${runId} step '${step.id}'`));
            return;
          }
          targetId = id;
          this.logger?.info('[ReviewQueueHumanGate] human gate opened; awaiting resolution', {
            runId,
            stepId: step.id,
            reviewItemId: id,
          });
        })
        .catch((err) => {
          this.events.off(channel, onChange);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
