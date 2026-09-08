/**
 * posixPath — the one idiom for "normalize a path to forward slashes so a
 * match/comparison is platform-blind".
 *
 * On Windows, paths carry backslash separators, so replacing `\` with `/`
 * normalizes them to the same '/'-shaped form git/fs already emit on POSIX.
 * But POSIX paths CAN legally contain a literal backslash — it is an ordinary
 * filename character there, not a separator — so this is NOT an identity
 * operation on macOS/Linux for such a path, and callers must not treat it as
 * one. Every site that needs the Windows-side normalization (quick-session
 * matchers, file-listing filters, timer-census frame labels, reaper
 * command-line matching, rung-1 path validation) uses this module's one
 * shared name.
 *
 * Matching-only by convention: normalize a COPY for comparison (git output,
 * command lines, stack frames are already '/'-shaped on POSIX); report or
 * store the platform-native path untouched, and never hand a normalized copy
 * back to git/fs on POSIX — doing so renames a path with a literal backslash
 * into one that was never tracked. NOT a general path normalizer — no `..`
 * collapsing, no case folding, no UNC handling.
 */

/**
 * Replace backslashes with forward slashes (identity on POSIX input).
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}
