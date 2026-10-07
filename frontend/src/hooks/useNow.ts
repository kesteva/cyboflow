import { useEffect, useState } from 'react';

/** Re-renders every `intervalMs` while `active`; returns Date.now() as of the last tick. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}
