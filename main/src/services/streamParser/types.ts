/**
 * Shared logger interface for the streamParser pipeline.
 *
 * Structurally compatible with `main/src/utils/logger.ts` Logger class so a
 * real Logger instance is assignable to ILogger without adaptation.
 */
export interface ILogger {
  warn(message: string): void;
  info?(message: string): void;
  verbose?(message: string): void;
}
