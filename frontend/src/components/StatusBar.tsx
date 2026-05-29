/**
 * StatusBar — persistent app-shell footer bar.
 *
 * Renders at the bottom of the app shell (below the main content row).
 * Ships v1 with only the McpHealthIndicator on the right side.
 * The left side shows a low-key "Cyboflow" label that can host future
 * indicators (active run count, queue depth, network/auth status).
 *
 * Layout note: The parent `App.tsx` wraps the existing content row and this
 * bar in a `flex-col` container so the bar occupies exactly `h-6` at the
 * bottom without shrinking the main content.
 */
import { McpHealthIndicator } from './McpHealthIndicator';

export function StatusBar() {
  return (
    <footer
      className="h-6 flex items-center justify-between px-3 bg-bg-secondary border-t border-border-primary shrink-0"
      aria-label="Application status bar"
    >
      {/* Left side: app label — extension point for future indicators */}
      <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted leading-none select-none">Cyboflow</span>

      {/* Right side: status indicators */}
      <div className="flex items-center gap-2">
        <McpHealthIndicator />
      </div>
    </footer>
  );
}
