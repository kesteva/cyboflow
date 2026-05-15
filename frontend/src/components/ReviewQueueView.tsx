import { useEffect } from 'react';
import { useReviewQueueStore } from '../stores/reviewQueueStore';
import { PendingApprovalCard } from './PendingApprovalCard';
import { useReviewQueueKeyboard } from '../hooks/useReviewQueueKeyboard';

export default function ReviewQueueView() {
  const queue = useReviewQueueStore(s => s.queue);
  const { focusedIndex } = useReviewQueueKeyboard(queue);

  useEffect(() => {
    useReviewQueueStore.getState().init();
  }, []);

  // Scroll the focused card into view whenever focusedIndex changes.
  useEffect(() => {
    const focused = queue[focusedIndex];
    if (focused !== undefined) {
      document
        .querySelector(`[data-approval-id="${focused.id}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex, queue]);

  return (
    <div className="w-[360px] h-full flex flex-col border-r border-border-primary bg-bg-secondary overflow-y-auto">
      <div className="px-4 py-3 border-b border-border-primary">
        <h2 className="text-sm font-semibold text-text-primary">Review Queue</h2>
        <span className="text-xs text-text-muted">{queue.length} pending</span>
      </div>
      {queue.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          No pending approvals
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {queue.map((a, i) => (
            <PendingApprovalCard
              key={a.id}
              approval={a}
              isFocused={i === focusedIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
}
