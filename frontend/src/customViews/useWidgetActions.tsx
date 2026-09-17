/**
 * useWidgetActions — the consent-and-execute flow behind every widget CTA
 * (docs/proposals/CUSTOM-VIEWS.md §4.4, §5.3).
 *
 * ## The consent rule, restated because it is the point of this module
 *
 * A tier-1/2 button is rendered by React, so a click on it IS a user gesture,
 * and such an action may set `confirm: false` to skip the dialog. A tier-3
 * frame's `cyboflow.act()` is not a gesture at all — script can call it on load
 * — so a frame-originated request ALWAYS opens the dialog, whatever the spec
 * says. That is why `request()` takes `fromFrame` rather than trusting the
 * action's own flag, and why the dialog body is `previewAction`'s SERVER-
 * resolved params: the user confirms what the server will actually do, not what
 * the frame claimed it would.
 *
 * ## And the second rule: nothing fires from an unsaved view
 *
 * `executeAction` is keyed on `viewId` + `viewRevision`, which only a SAVED view
 * has. Customize mode, an inspector preview and the Default view have no such
 * identity, so `enabled` is false and every control renders disabled. The
 * identity comes from `ViewIdentityContext`, whose default is "no identity" —
 * a host mounted outside a provider is disabled rather than accidentally armed.
 *
 * ## Idempotency
 *
 * One `operationId` per CLICK, minted here and sent once. The server logs it
 * UNIQUE-keyed, so a transport retry of the same click replays the first
 * proposal instead of creating a second one; a retry the USER initiates is a
 * new click and therefore correctly a new operation.
 */
import { useCallback, useMemo, useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { trpc } from '../trpc/client';
import { navigateFromWidget } from './widgetNavigation';
import { actionsEnabled, useViewIdentity } from './viewContext';
import { rowActionKey } from './shape/shapeTypes';
import type { Scalar, WidgetAction, WidgetSpec } from '../../../shared/types/customViews';

export interface UseWidgetActionsInput {
  /** The layout item this widget is — the server's key into the stored view. */
  instanceId: string;
  spec: WidgetSpec | null;
  context: { projectId: number | null };
}

export interface UseWidgetActionsResult {
  /** Actions with `placement: 'header'` (the default when unset). */
  headerActions: WidgetAction[];
  /** Actions with `placement: 'row'`, handed to the shape components. */
  rowActions: WidgetAction[];
  /** False in customize mode or on an unsaved view — every control disables. */
  enabled: boolean;
  /** `<actionId>:<rowKeyValue>` currently in flight, or `null`. */
  busyActionKey: string | null;
  /** The last outcome, rendered as the widget frame's status line. */
  status: string | null;
  /** Ask to run an action. `fromFrame` forces the dialog (§4.4). */
  request: (actionId: string, rowKeyValue?: Scalar, opts?: { fromFrame?: boolean }) => void;
  /** The confirm dialog element; render it inside the widget frame. */
  dialog: React.JSX.Element | null;
}

interface PendingConfirm {
  actionId: string;
  rowKeyValue: Scalar;
  label: string;
  message: string;
}

/** useWidgetActions — see {@link UseWidgetActionsResult}. */
export function useWidgetActions({
  instanceId,
  spec,
  context,
}: UseWidgetActionsInput): UseWidgetActionsResult {
  const identity = useViewIdentity();
  const enabled = actionsEnabled(identity);

  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const actions = useMemo(() => spec?.actions ?? [], [spec]);
  const headerActions = useMemo(
    () => actions.filter((a) => (a.placement ?? 'header') === 'header'),
    [actions],
  );
  const rowActions = useMemo(() => actions.filter((a) => a.placement === 'row'), [actions]);

  const execute = useCallback(
    async (actionId: string, rowKeyValue: Scalar): Promise<void> => {
      if (identity.viewId === null || identity.viewRevision === null) return;
      const key = rowActionKey(actionId, rowKeyValue);
      setBusyActionKey(key);
      setStatus(null);
      try {
        const result = await trpc.cyboflow.customViews.executeAction.mutate({
          operationId: crypto.randomUUID(),
          viewId: identity.viewId,
          viewRevision: identity.viewRevision,
          instanceId,
          actionId,
          ...(rowKeyValue !== null ? { rowKeyValue } : {}),
          context,
        });
        setStatus(describeResult(result));
      } catch (err: unknown) {
        setStatus(`Failed: ${errorText(err)}`);
      } finally {
        setBusyActionKey(null);
      }
    },
    [context, identity.viewId, identity.viewRevision, instanceId],
  );

  const request = useCallback(
    (actionId: string, rowKeyValue: Scalar = null, opts?: { fromFrame?: boolean }): void => {
      if (!enabled || identity.viewId === null || identity.viewRevision === null) {
        setStatus('Actions are disabled until this view is saved.');
        return;
      }
      const action = actions.find((a) => a.id === actionId);
      if (action === undefined) {
        setStatus(`Failed: invalid_action`);
        return;
      }
      // A frame request is never a gesture — it always confirms, whatever the
      // spec's own `confirm` flag says.
      const mustConfirm = opts?.fromFrame === true || action.confirm !== false;
      if (!mustConfirm) {
        void execute(actionId, rowKeyValue);
        return;
      }
      void (async (): Promise<void> => {
        try {
          const preview = await trpc.cyboflow.customViews.previewAction.query({
            viewId: identity.viewId as string,
            viewRevision: identity.viewRevision as number,
            instanceId,
            actionId,
            ...(rowKeyValue !== null ? { rowKeyValue } : {}),
            context,
          });
          setPending({
            actionId,
            rowKeyValue,
            label: preview.label,
            message: `${preview.kind}\n\n${JSON.stringify(preview.resolvedParams, null, 2)}`,
          });
        } catch (err: unknown) {
          setStatus(`Failed: ${errorText(err)}`);
        }
      })();
    },
    [actions, context, enabled, execute, identity.viewId, identity.viewRevision, instanceId],
  );

  const dialog =
    pending === null ? null : (
      <ConfirmDialog
        isOpen
        title={pending.label}
        message={pending.message}
        confirmText="Run"
        onClose={() => setPending(null)}
        onConfirm={() => {
          void execute(pending.actionId, pending.rowKeyValue);
        }}
      />
    );

  return { headerActions, rowActions, enabled, busyActionKey, status, request, dialog };
}

// ---------------------------------------------------------------------------
// Result → one status line
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `ExecuteWidgetActionResult` as one line (§4.4 step 6). The shape is narrowed
 * structurally rather than by importing the main-process union: the renderer
 * gets it through tRPC inference and must not reach into `main/` for a type.
 */
export function describeResult(result: unknown): string {
  if (!isRecord(result)) return 'Done.';
  if (result.ok === false) {
    return `Failed: ${String(result.error ?? 'unknown')}`;
  }
  if ('navigation' in result) {
    return navigateFromWidget(result.navigation) ? 'Opened.' : 'Failed: unroutable navigation target';
  }
  if (result.replay === true) {
    return 'Already applied — showing the first result.';
  }
  const inner = result.result;
  if (!isRecord(inner)) return 'Done.';
  if (inner.ok === false) {
    return `Failed: ${String(inner.reason ?? 'refused')}`;
  }
  if (inner.status === 'failed') return 'Failed — see the proposal for details.';
  return 'Executed.';
}

/** A tRPC/thrown error as its message — the router puts the code there verbatim. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
