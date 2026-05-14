/**
 * streamParser — Public API barrel.
 *
 * Single import point for downstream consumers (TASK-202, TASK-203, TASK-205).
 * Import individual classes from this file, not from their implementation modules.
 *
 * @example
 * import { EventRouter, RawEventsSink } from '../services/streamParser';
 */

export { TypedEventNarrowing } from './typedEventNarrowing';
export { EventRouter } from './eventRouter';
export { RawEventsSink } from './rawEventsSink';
export { MessageProjection } from './messageProjection';
export type { ILogger } from './types';
