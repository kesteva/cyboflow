/**
 * PlaceholderSlot — the dashed well an authoring session's item renders in
 * before any draft has landed (docs/proposals/CUSTOM-VIEWS.md §7.1/§7.3, the
 * "Waiting for the assistant" state). Replaces `ViewSurface`'s ordinary
 * "not available" chip for exactly the ONE item that owns the open
 * `customViewsStore.authoring` slot while it is still `{ type:'custom',
 * widgetId: '' }` — every other placeholder-shaped ref (there shouldn't be
 * any, but see `WidgetHost`'s `spec === null` state) keeps the generic
 * "unavailable" wording, which is not what a mid-authoring placeholder means.
 */
import { WidgetFrame } from '../WidgetFrame';

export interface PlaceholderSlotProps {
  testId?: string;
}

/** PlaceholderSlot — see {@link PlaceholderSlotProps}. */
export function PlaceholderSlot({ testId = 'widget-placeholder-slot' }: PlaceholderSlotProps): React.JSX.Element {
  return (
    <WidgetFrame title="Custom widget" testId={testId}>
      <div
        data-testid="widget-placeholder-body"
        className="border border-dashed border-border-primary bg-surface-raised px-[18px] py-5 text-center text-[11px] text-text-tertiary"
      >
        Waiting for the assistant… Describe the widget in the chat on the right.
      </div>
    </WidgetFrame>
  );
}
