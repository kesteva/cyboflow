/**
 * posixPath — the one idiom for "normalize a path to forward slashes so a
 * match/comparison is platform-blind".
 *
 * Windows paths carry backslashes; POSIX paths cannot contain them, so
 * replacing `\` with `/` is an identity operation on macOS/Linux and a
 * normalization on Windows. Every site that needs that normalization
 * (quick-session matchers, file-listing filters, timer-census frame labels,
 * reaper command-line matching, rung-1 path validation) uses this module's
 * one shared name.
 *
 * Matching-only by convention: normalize a COPY for comparison (git output,
 * command lines, stack frames are already '/'-shaped on POSIX); report or
 * store the platform-native path untouched unless the consumer is itself a
 * matcher. NOT a general path normalizer — no `..` collapsing, no case
 * folding, no UNC handling.
 */

/**
 * Replace backslashes with forward slashes (identity on POSIX input).
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}
