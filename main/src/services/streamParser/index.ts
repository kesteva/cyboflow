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
export { TypedEventNarrowing } from './typedEventNarrowing';
export { EventRouter } from './eventRouter';
export { ClaudeStreamParser } from './streamParser';
export { CompletionDetector } from './completionDetector';
export type { CompletionPayload, ForcedPayload } from './completionDetector';
export { RawEventsSink } from './rawEventsSink';
export { MessageProjection } from './messageProjection';
export type { ILogger } from './types';
