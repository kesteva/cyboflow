/**
 * streamParser — Public API barrel.
 *
 * Single import point for downstream consumers (TASK-202, TASK-203, TASK-205).
 * Import individual classes from this file, not from their implementation modules.
 *
 * @example
 * import { ClaudeStreamParser, EventRouter } from '../services/streamParser';
 */

export { LineBufferer } from './lineBufferer';
export { JSONParser } from './jsonParser';
export type { IWarnLogger } from './jsonParser';
export { TypedEventNarrowing } from './typedEventNarrowing';
export type { IDebugLogger } from './typedEventNarrowing';
export { EventRouter } from './eventRouter';
export { ClaudeStreamParser } from './streamParser';
export type { IStreamParserLogger } from './streamParser';
export { CompletionDetector } from './completionDetector';
export type { ICompletionDetectorLogger, CompletionPayload, ForcedPayload } from './completionDetector';
export { RawEventsSink } from './rawEventsSink';
export type { IRawEventsSinkLogger } from './rawEventsSink';
export { MessageProjection } from './messageProjection';
export type { IMessageProjectionLogger } from './messageProjection';
