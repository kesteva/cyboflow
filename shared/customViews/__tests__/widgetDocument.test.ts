import { describe, expect, it } from 'vitest';
import { ARTIFACT_INTERACTIVE_CSP } from '../../types/artifacts';
import type { WidgetSpec } from '../../types/customViews';
import { buildWidgetDocument, WIDGET_ACT_MESSAGE, WIDGET_DATA_MESSAGE, WIDGET_RESIZE_MESSAGE } from '../widgetDocument';

function htmlSpec(html: string): WidgetSpec {
  return {
    version: 1,
    sources: { tasks: { type: 'sql', sql: 'SELECT id FROM tasks' } },
    render: { type: 'html', html },
  };
}

describe('buildWidgetDocument', () => {
  it('starts with the doctype, charset meta, then the CSP meta carrying the exact ARTIFACT_INTERACTIVE_CSP string', () => {
    const doc = buildWidgetDocument(htmlSpec('<p>hi</p>'), { theme: { ink: '#1a1815' } });
    expect(doc.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true);
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_INTERACTIVE_CSP}">`);
  });

  it('places the author html after the prelude script, inside <body>', () => {
    const doc = buildWidgetDocument(htmlSpec('<div id="marker">author content</div>'), { theme: {} });
    const preludeEnd = doc.indexOf('</script>');
    const bodyStart = doc.indexOf('<body>');
    const markerIndex = doc.indexOf('author content');
    expect(preludeEnd).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(preludeEnd);
    expect(markerIndex).toBeGreaterThan(bodyStart);
    expect(doc).toContain('<div id="marker">author content</div>');
    expect(doc.endsWith('</body></html>')).toBe(true);
  });

  it('never contains "allow-same-origin"', () => {
    const doc = buildWidgetDocument(htmlSpec('<script>window.cyboflow.act("x")</script>'), { theme: {} });
    expect(doc).not.toContain('allow-same-origin');
  });

  it('emits theme tokens as CSS custom properties', () => {
    const doc = buildWidgetDocument(htmlSpec('<p></p>'), { theme: { ink: '#1a1815', paper: '#fefdfb' } });
    expect(doc).toContain('--ink:#1a1815;');
    expect(doc).toContain('--paper:#fefdfb;');
  });

  it('defines the window.cyboflow bridge using the exported message type constants', () => {
    const doc = buildWidgetDocument(htmlSpec('<p></p>'), { theme: {} });
    expect(doc).toContain('window.cyboflow');
    expect(doc).toContain(`'${WIDGET_DATA_MESSAGE}'`);
    expect(doc).toContain(`'${WIDGET_ACT_MESSAGE}'`);
    expect(doc).toContain(`'${WIDGET_RESIZE_MESSAGE}'`);
  });

  it('throws for a shape render', () => {
    const spec: WidgetSpec = {
      version: 1,
      sources: { tasks: { type: 'sql', sql: 'SELECT id FROM tasks' } },
      render: { type: 'shape', shape: 'stat', source: 'tasks', value: 'id' },
    };
    expect(() => buildWidgetDocument(spec, { theme: {} })).toThrow(/render\.type/);
  });
});
