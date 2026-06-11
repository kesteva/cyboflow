/**
 * Barrel for the dynamic-workflow detection/tracking subsystem.
 * See shared/types/dynamicWorkflows.ts for the cross-process contract.
 */
export { DynamicWorkflowTracker, dynamicWorkflowEvents } from './dynamicWorkflowTracker';
export type { DynamicWorkflowRunContext } from './dynamicWorkflowTracker';
export { DynamicWorkflowDetector } from './dynamicWorkflowDetector';
export type {
  DynamicWorkflowDetectorOptions,
  DynamicWorkflowLaunchInfo,
  DynamicWorkflowNotification,
} from './dynamicWorkflowDetector';
export { JournalTailer, readCompletionRecord } from './journalTailer';
export type { DynamicWorkflowCompletionRecord, JournalTailerOptions } from './journalTailer';
export { parseScriptMeta } from './scriptMeta';
export type { ParsedScriptMeta } from './scriptMeta';
