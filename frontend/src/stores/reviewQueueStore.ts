// PARALLEL-STUB: replaced at merge by TASK-401's full implementation
// Minimal Zustand-shaped placeholder for parallel execution in TASK-402.
import { create } from 'zustand';
import type { Approval } from '../../../shared/types/approvals';

interface ReviewQueueState {
  queue: Approval[];
  init: () => void;
}

export const useReviewQueueStore = create<ReviewQueueState>()(() => ({
  queue: [],
  init: () => {},
}));
