/**
 * useWorkflowTokenAnimation — RAF clock for animated workflow token.
 *
 * Advances t in [0, 1) at 0.18/sec by default via requestAnimationFrame.
 * Functional updater pattern avoids stale-closure t reads on each frame.
 * Cancels RAF callback on unmount — no leaked handle.
 *
 * Options:
 *   enabled  — when false, no RAF is scheduled and t stays 0 (default true)
 *   speed    — multiplier for advance rate (default 0.18; speed=1.0 → full
 *              cycle per second)
 *
 * TASK-770 / IDEA-026
 */
import { useState, useEffect, useRef } from 'react';

export interface UseWorkflowTokenAnimationOptions {
  enabled?: boolean;
  speed?: number;
}

/**
 * Returns numeric t in [0, 1) that advances at `speed` units per second.
 * Default speed is 0.18 so a full cycle takes ~5.6 seconds.
 */
export function useWorkflowTokenAnimation(
  options: UseWorkflowTokenAnimationOptions = {},
): number {
  const { enabled = true, speed = 0.18 } = options;

  const [t, setT] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const tick = (now: number) => {
      if (lastRef.current !== null) {
        const dt = (now - lastRef.current) / 1000;
        setT((prev) => (prev + dt * speed) % 1);
      }
      lastRef.current = now;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastRef.current = null;
    };
  }, [enabled, speed]);

  return t;
}
