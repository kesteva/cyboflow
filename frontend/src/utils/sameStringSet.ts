/**
 * Order-independent set-equality for two string arrays. Used by the composer's
 * MCP / plugin toggle pills to decide whether a `disabled` / `selected` prop has
 * GENUINELY changed (reload, session switch, async column arrival) versus the
 * fresh `?? []` array identity the composer hands them on every render — the
 * latter must NOT clobber the pill's optimistic local state.
 */
export function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((x) => seen.has(x));
}
