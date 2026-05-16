import { useEffect } from 'react';
import { useReviewQueueStore, useReviewQueueView } from '../stores/reviewQueueStore';
import { PendingApprovalCard } from './PendingApprovalCard';
import { useReviewQueueKeyboard } from '../hooks/useReviewQueueKeyboard';
import type { QueueItem } from '../utils/reviewQueueSelectors';

function itemId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.id : item.items[0].id;
}

export default function ReviewQueueView() {
  const queue = useReviewQueueStore(s => s.queue);
  const { blocking, normal } = useReviewQueueView();
  const allItems = [...blocking, ...normal];
  const { focusedIndex } = useReviewQueueKeyboard(allItems);

  useEffect(() => {
    useReviewQueueStore.getState().init();
  }, []);

  // Scroll the focused card into view whenever focusedIndex changes.
  useEffect(() => {
    const focused = allItems[focusedIndex];
    if (focused !== undefined) {
      document
        .querySelector(`[data-approval-id="${itemId(focused)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalCount = queue.length;

  return (
    <div className="w-[360px] h-full flex flex-col border-r border-border-primary bg-bg-secondary overflow-y-auto">
      <div className="px-4 py-3 border-b border-border-primary">
        <h2 className="text-sm font-semibold text-text-primary">Review Queue</h2>
        <span className="text-xs text-text-muted">{totalCount} pending</span>
      </div>
      {totalCount === 0 ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          No pending approvals
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {blocking.length > 0 && (
            <section>
              <h3 className="px-4 py-1 text-xs font-semibold text-status-error bg-bg-tertiary">
                Blocking
              </h3>
              {blocking.map((item, i) => (
                <PendingApprovalCard
                  key={itemId(item)}
                  item={item}
                  isFocused={i === focusedIndex}
                />
              ))}
            </section>
          )}
          <section>
            <h3 className="px-4 py-1 text-xs font-semibold text-text-muted bg-bg-tertiary">
              Pending
            </h3>
            {normal.map((item, i) => (
              <PendingApprovalCard
                key={itemId(item)}
                item={item}
                isFocused={blocking.length + i === focusedIndex}
              />
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
