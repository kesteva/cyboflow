/**
 * McpHealthIndicator — colored dot reflecting CyboflowMcpServer health.
 *
 * Dot colors:
 *   healthy  → green  (bg-status-success)
 *   starting → yellow with pulse animation (bg-status-warning)
 *   error    → red    (bg-status-error)
 *
 * Clicking the dot opens a diagnostics popover showing:
 *   - Status string
 *   - Last health-check timestamp (or 'never')
 *   - Subprocess PID (or 'unknown')
 *   - Last error message (if any), rendered in red monospaced text
 *
 * The popover is rendered as a portal-free absolutely-positioned div anchored
 * above the indicator.  No external popover primitive is required.
 */
import { useState, useRef, useEffect } from 'react';
import { cn } from '../utils/cn';
import { useMcpHealthStore } from '../stores/mcpHealthStore';
import type { McpHealthStatus } from '../stores/mcpHealthStore';

// ---------------------------------------------------------------------------
// Dot color + label maps
// ---------------------------------------------------------------------------

const DOT_COLOR: Record<McpHealthStatus, string> = {
  healthy: 'bg-status-success',
  starting: 'bg-status-warning',
  error: 'bg-status-error',
};

const STATUS_LABEL: Record<McpHealthStatus, string> = {
  healthy: 'healthy',
  starting: 'starting',
  error: 'error',
};

// ---------------------------------------------------------------------------
// Timestamp formatter
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number | null): string {
  if (ts === null) return 'never';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function McpHealthIndicator() {
  const { status, lastCheckedAt, lastError, pid } = useMcpHealthStore();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the popover when the user clicks outside of it.
  useEffect(() => {
    if (!open) return;

    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  // Close on Escape key.
  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <div ref={containerRef} className="relative flex items-center">
      {/* Trigger button */}
      <button
        type="button"
        aria-label={`MCP server status: ${STATUS_LABEL[status]}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive/30 transition-colors"
      >
        {/* Colored dot */}
        <span className="relative flex items-center justify-center w-2 h-2">
          <span
            className={cn(
              'w-2 h-2 rounded-full',
              DOT_COLOR[status],
              status === 'starting' && 'animate-pulse',
            )}
            data-status={status}
          />
        </span>
        <span className="text-xs text-text-muted leading-none">MCP</span>
      </button>

      {/* Diagnostics popover */}
      {open && (
        <div
          role="dialog"
          aria-label="MCP server diagnostics"
          className={cn(
            'absolute bottom-full right-0 mb-2 z-50',
            'w-64 rounded-md border border-border-primary bg-bg-secondary shadow-lg',
            'p-3 text-xs text-text-primary',
          )}
        >
          <p className="font-semibold mb-2 text-text-primary">MCP Server Diagnostics</p>

          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-text-muted">Status</span>
              <span
                className={cn(
                  'font-medium',
                  status === 'healthy' && 'text-status-success',
                  status === 'starting' && 'text-status-warning',
                  status === 'error' && 'text-status-error',
                )}
              >
                {STATUS_LABEL[status]}
              </span>
            </div>

            <div className="flex justify-between">
              <span className="text-text-muted">Last checked</span>
              <span>{formatTimestamp(lastCheckedAt)}</span>
            </div>

            <div className="flex justify-between">
              <span className="text-text-muted">PID</span>
              <span>{pid !== null ? String(pid) : 'unknown'}</span>
            </div>
          </div>

          {lastError && (
            <div className="mt-2 pt-2 border-t border-border-primary">
              <p className="text-text-muted mb-1">Last error</p>
              <p className="font-mono text-status-error break-all whitespace-pre-wrap text-[10px] leading-tight">
                {lastError}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
