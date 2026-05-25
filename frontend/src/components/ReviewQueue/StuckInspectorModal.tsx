/**
 * StuckInspectorModal — read-only diagnostic surface for stuck runs.
 *
 * Renders three sections:
 *   1. Detected reason — human-readable mapping of the stuck_reason tag.
 *   2. Pending approval — tool name in monospace, input payload as collapsed JSON.
 *   3. Recent events — latest 10 raw_events rows with event_type, timestamp,
 *      and a one-line payload preview (first 80 chars of JSON.stringify(payload)).
 *
 * Read-only invariant: no Approve, Reject, or Cancel and restart buttons.
 * Recovery actions live on the queue card (TASK-502).
 *
 * Uses the <Modal /> primitive from frontend/src/components/ui/Modal.tsx.
 */
import React, { useState } from 'react';
import { Modal, ModalHeader, ModalBody } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import type { StuckInspectionResult } from '../../../../shared/types/stuckInspection';

// ---------------------------------------------------------------------------
// Stuck-reason human-readable mapping
//
// Mirrors the StuckReason discriminated union from shared/types/stuckDetection.ts
// (owned by TASK-501). If that file introduces a new variant, add it here too.
// ---------------------------------------------------------------------------

const STUCK_REASON_LABELS: Record<string, string> = {
  self_deadlock: 'Self-deadlock — this run has multiple pending approvals stacked up',
  cross_run_deadlock: 'Cross-run deadlock — another run is also awaiting review',
  orphan_pty: 'Orphan PTY — the Claude process for this run is no longer running',
  stale_socket: 'Stale socket — the permission socket client has disconnected',
};

function stuckReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Unknown';
  return STUCK_REASON_LABELS[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// Payload preview helper — first 80 chars of JSON
// ---------------------------------------------------------------------------

function payloadPreview(payload: unknown): string {
  try {
    const json = JSON.stringify(payload);
    return json.length > 80 ? json.slice(0, 80) + '…' : json;
  } catch {
    return String(payload);
  }
}

// ---------------------------------------------------------------------------
// Timestamp helper — relative or absolute
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

// StuckInspectionResult is used as StuckInspectionData — alias for local clarity.
type StuckInspectionData = StuckInspectionResult;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StuckInspectorModalProps {
  runId: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * StuckInspectorModal — diagnostic modal for a single stuck run.
 *
 * Fetches inspection data via `cyboflow.runs.getStuckInspection({ runId })`
 * on mount and renders it in three read-only sections.
 */
export const StuckInspectorModal: React.FC<StuckInspectorModalProps> = ({
  runId,
  onClose,
}) => {
  const [data, setData] = React.useState<StuckInspectionData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());

  React.useEffect(() => {
    setLoading(true);
    setError(null);

    void trpc.cyboflow.runs.getStuckInspection
      .query({ runId })
      .then((result) => {
        setData(result as StuckInspectionData);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load inspection data';
        setError(message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [runId]);

  function toggleEventExpand(id: number): void {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <ModalHeader title="Why is this run stuck?" onClose={onClose} />
      <ModalBody>
        {loading && (
          <div
            role="status"
            aria-label="Loading inspection data"
            className="flex items-center justify-center py-8 text-text-muted text-sm"
          >
            <span className="animate-pulse">Loading inspection data…</span>
          </div>
        )}

        {!loading && error !== null && (
          <div className="text-status-error text-sm py-4">
            {error}
          </div>
        )}

        {!loading && error === null && data !== null && (
          <div className="space-y-6">
            {/* Section 1: Detected reason */}
            <section>
              <h3 className="text-sm font-semibold text-text-primary mb-2">
                Detected reason
              </h3>
              <p className="text-sm text-text-secondary">
                {stuckReasonLabel(data.stuckReason)}
              </p>
              {data.stuckDetectedAt !== null && (
                <p className="text-xs text-text-muted mt-1">
                  Detected at {formatTimestamp(data.stuckDetectedAt)}
                </p>
              )}
            </section>

            {/* Section 2: Pending approval */}
            <section>
              <h3 className="text-sm font-semibold text-text-primary mb-2">
                Pending approval
              </h3>
              {data.pendingApproval === null ? (
                <p className="text-sm text-text-muted">No pending approval found.</p>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-text-muted">Tool</span>
                    <code className="text-sm font-mono text-text-primary bg-bg-tertiary px-1 rounded">
                      {data.pendingApproval.toolName}
                    </code>
                  </div>
                  <div>
                    <span className="text-xs text-text-muted block mb-1">Input</span>
                    <pre className="text-xs font-mono bg-bg-tertiary px-3 py-2 rounded overflow-auto max-h-40 text-text-secondary">
                      {JSON.stringify(data.pendingApproval.input, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </section>

            {/* Section 3: Recent events */}
            <section>
              <h3 className="text-sm font-semibold text-text-primary mb-2">
                Recent events
              </h3>
              {data.recentEvents.length === 0 ? (
                <p className="text-sm text-text-muted">No events recorded.</p>
              ) : (
                <div className="space-y-1">
                  {data.recentEvents.map((event) => (
                    <div key={event.id} className="text-xs">
                      <button
                        type="button"
                        className="w-full text-left flex items-baseline gap-2 hover:bg-bg-tertiary px-2 py-1 rounded"
                        onClick={() => toggleEventExpand(event.id)}
                        aria-expanded={expandedEvents.has(event.id)}
                      >
                        <code className="font-mono text-text-primary">
                          {event.eventType}
                        </code>
                        <span className="text-text-muted">
                          {formatTimestamp(event.createdAt)}
                        </span>
                        <span className="text-text-muted truncate flex-1">
                          {payloadPreview(event.payload)}
                        </span>
                      </button>
                      {expandedEvents.has(event.id) && (
                        <pre className="text-xs font-mono bg-bg-tertiary px-3 py-2 rounded mt-1 ml-2 overflow-auto max-h-32 text-text-secondary">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
};

StuckInspectorModal.displayName = 'StuckInspectorModal';
