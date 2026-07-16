/**
 * LiveCanvasEmbed tests — the ui-prototype / generic canvas embed (dual-path).
 *
 * Verifies:
 *   - HTML branch (static mockup): srcDoc + a BARE `sandbox=""` (no allow-scripts,
 *     no allow-same-origin) + `referrerPolicy`, and NO toolbar/footer. Network
 *     egress is closed by the CSP `<meta>` the main handler prepends to the
 *     document (see injectPrototypeCsp / artifactHtml.test.ts), NOT by an iframe
 *     `csp` attribute — that attribute was never shipped in Chromium/Electron and
 *     is deliberately absent. jsdom cannot ENFORCE the sandbox/CSP — these assert
 *     the attributes are present; real enforcement is an Electron-level check.
 *   - URL branch (legacy live canvas): localhost URLs render an allow-scripts
 *     iframe; non-localhost URLs are refused; reload re-keys the iframe.
 *   - the isLocalhostUrl allowlist.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LiveCanvasEmbed, isLocalhostUrl } from '../LiveCanvasEmbed';

describe('isLocalhostUrl', () => {
  it('accepts http(s) localhost hosts on a non-shell port', () => {
    expect(isLocalhostUrl('http://localhost:8081')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1:3001/path')).toBe(true);
    expect(isLocalhostUrl('https://localhost:5173')).toBe(true);
    expect(isLocalhostUrl('http://[::1]:8080')).toBe(true);
  });
  it('rejects remote hosts, non-http protocols, and garbage', () => {
    expect(isLocalhostUrl('https://example.com')).toBe(false);
    expect(isLocalhostUrl('http://10.0.0.5:8081')).toBe(false);
    expect(isLocalhostUrl('file:///etc/passwd')).toBe(false);
    expect(isLocalhostUrl('file://remote/share')).toBe(false);
    expect(isLocalhostUrl('javascript:alert(1)')).toBe(false);
    expect(isLocalhostUrl('not a url')).toBe(false);
  });
  it('rejects bind-all sentinel hosts (0.0.0.0 and ::) — not real loopback', () => {
    expect(isLocalhostUrl('http://0.0.0.0:8081')).toBe(false);
    expect(isLocalhostUrl('http://[::]:8081')).toBe(false);
  });
  it('rejects the shell origin to prevent a same-origin sandbox escape', () => {
    // The test env (jsdom) origin IS the shell origin here; any localhost URL
    // matching it (host + port) must be refused even though the host is local.
    const shell = new URL(window.location.origin);
    expect(isLocalhostUrl(window.location.origin)).toBe(false);
    expect(isLocalhostUrl(`${window.location.origin}/some/path`)).toBe(false);
    // A different port on the same local host is still embeddable (not shell origin).
    const otherPort = shell.port === '8082' ? '8083' : '8082';
    expect(isLocalhostUrl(`${shell.protocol}//${shell.hostname}:${otherPort}`)).toBe(true);
  });
});

describe('LiveCanvasEmbed — html branch (static mockup)', () => {
  const DOC = '<html><head></head><body><h1>Mockup</h1></body></html>';

  it('renders a bare-sandbox srcDoc iframe with no-referrer (no inert csp attribute)', () => {
    render(<LiveCanvasEmbed html={DOC} />);
    const iframe = screen.getByTestId('live-canvas-iframe');
    // srcDoc carries the document inline (NOT a cross-origin src).
    expect(iframe).toHaveAttribute('srcdoc', DOC);
    expect(iframe).not.toHaveAttribute('src');
    // SECURITY: sandbox is BARE — the empty string, NOT "allow-scripts …".
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    // The `csp` iframe attribute is a no-op in Chromium/Electron and must NOT be
    // emitted — the injected CSP <meta> is the real egress control.
    expect(iframe).not.toHaveAttribute('csp');
  });

  it('renders NO reload/open toolbar and NO server-down footer for the html branch', () => {
    render(<LiveCanvasEmbed html={DOC} />);
    expect(screen.queryByTestId('live-canvas-reload')).not.toBeInTheDocument();
    expect(screen.queryByTestId('live-canvas-open')).not.toBeInTheDocument();
    expect(screen.queryByText(/dev server may not be running/i)).not.toBeInTheDocument();
  });
});

describe('LiveCanvasEmbed — url branch (legacy live canvas)', () => {
  it('renders a sandboxed iframe for a localhost URL (allow-scripts unchanged)', () => {
    render(<LiveCanvasEmbed url="http://localhost:8081" interactive />);
    const iframe = screen.getByTestId('live-canvas-iframe');
    expect(iframe).toHaveAttribute('src', 'http://localhost:8081');
    // Legacy cross-origin-safe sandbox is UNCHANGED.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(iframe).not.toHaveAttribute('srcdoc');
    expect(screen.getByTestId('live-canvas-open')).toHaveAttribute('href', 'http://localhost:8081');
  });

  it('refuses a non-localhost URL (no iframe)', () => {
    render(<LiveCanvasEmbed url="https://evil.example.com" interactive />);
    expect(screen.getByTestId('live-canvas-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('live-canvas-iframe')).not.toBeInTheDocument();
  });

  it('pauses (about:blank) while the document is hidden, restores on re-show', () => {
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get');
    hiddenSpy.mockReturnValue(false);
    try {
      render(<LiveCanvasEmbed url="http://localhost:8081" interactive />);
      // Visible: the live URL is loaded.
      expect(screen.getByTestId('live-canvas-iframe')).toHaveAttribute('src', 'http://localhost:8081');

      // Window hidden/minimized: the frame is unloaded so its animation loop stops.
      hiddenSpy.mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(screen.getByTestId('live-canvas-iframe')).toHaveAttribute('src', 'about:blank');
      // The "Open in browser" affordance still points at the real URL while paused.
      expect(screen.getByTestId('live-canvas-open')).toHaveAttribute('href', 'http://localhost:8081');

      // Re-shown: the live URL is restored (a fresh fetch).
      hiddenSpy.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(screen.getByTestId('live-canvas-iframe')).toHaveAttribute('src', 'http://localhost:8081');
    } finally {
      hiddenSpy.mockRestore();
    }
  });

  it('reload re-keys the iframe (remounts to refetch)', () => {
    render(<LiveCanvasEmbed url="http://localhost:8081" interactive />);
    const before = screen.getByTestId('live-canvas-iframe');
    fireEvent.click(screen.getByTestId('live-canvas-reload'));
    const after = screen.getByTestId('live-canvas-iframe');
    // A keyed remount yields a new DOM node instance.
    expect(after).not.toBe(before);
    expect(after).toHaveAttribute('src', 'http://localhost:8081');
  });
});
