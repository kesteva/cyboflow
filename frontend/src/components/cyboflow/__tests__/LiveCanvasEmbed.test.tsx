/**
 * LiveCanvasEmbed tests — the ui-prototype live-canvas iframe.
 *
 * Verifies: localhost URLs render a sandboxed iframe; non-localhost URLs are
 * refused; reload re-keys the iframe; and the isLocalhostUrl allowlist.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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

describe('LiveCanvasEmbed', () => {
  it('renders a sandboxed iframe for a localhost URL', () => {
    render(<LiveCanvasEmbed url="http://localhost:8081" />);
    const iframe = screen.getByTestId('live-canvas-iframe');
    expect(iframe).toHaveAttribute('src', 'http://localhost:8081');
    // Cross-origin-safe sandbox: scripts run, but no top-nav/popups.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(screen.getByTestId('live-canvas-open')).toHaveAttribute('href', 'http://localhost:8081');
  });

  it('refuses a non-localhost URL (no iframe)', () => {
    render(<LiveCanvasEmbed url="https://evil.example.com" />);
    expect(screen.getByTestId('live-canvas-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('live-canvas-iframe')).not.toBeInTheDocument();
  });

  it('reload re-keys the iframe (remounts to refetch)', () => {
    render(<LiveCanvasEmbed url="http://localhost:8081" />);
    const before = screen.getByTestId('live-canvas-iframe');
    fireEvent.click(screen.getByTestId('live-canvas-reload'));
    const after = screen.getByTestId('live-canvas-iframe');
    // A keyed remount yields a new DOM node instance.
    expect(after).not.toBe(before);
    expect(after).toHaveAttribute('src', 'http://localhost:8081');
  });
});
