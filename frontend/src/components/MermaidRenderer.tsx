import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

interface MermaidRendererProps {
  chart: string;
  id: string;
}

/**
 * Strip the navigation out of every <a> mermaid emits for a
 * `click <node> "<url>"` directive. The SVG lands in the app's TOP frame,
 * where a plain href navigates the whole renderer window (artifactFrameGuard
 * covers only child frames), and 'strict' strips target=_blank so the guarded
 * window-open path never sees it. Diagram content is agent- or tracker-
 * authored, so no navigation from inside a diagram is ever legitimate.
 * The anchor ELEMENT itself has to stay: mermaid positions a linked node by
 * putting that node's `transform="translate(x, y)"` on the <a>, so unwrapping
 * it would drop the node at the diagram origin (see GitHub #20).
 */
function stripNavigationAnchors(root: HTMLElement): void {
  root.querySelectorAll('a').forEach((anchor) => {
    anchor.removeAttribute('href');
    anchor.removeAttribute('xlink:href');
    anchor.removeAttribute('target');
  });
}

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ chart, id }) => {
  const elementRef = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    // Cancellation fence: `mermaid.render` is async and this effect re-runs on
    // every `chart` revision (streamed charts revise rapidly). Without the
    // fence, an OLDER render resolving last would overwrite the newer chart's
    // SVG in the shared elementRef.
    let cancelled = false;

    const renderChart = async () => {
      if (!elementRef.current || !chart) return;

      // Create a unique ID for this render (define it outside try block)
      const graphId = `mermaid-${id}-${Date.now()}`;

      try {
        // Clear any previous content
        elementRef.current.innerHTML = '';
        setHasError(false);

        // Configure mermaid
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          // mermaid's own default: runs the whole-SVG DOMPurify pass and strips
          // javascript: URLs. The app never uses click/HTML-label features, so
          // nothing here relies on 'loose' (see GitHub #20).
          securityLevel: 'strict',
          fontFamily: 'monospace',
        });

        // Render the chart
        const { svg } = await mermaid.render(graphId, chart);
        if (cancelled) return;

        // Insert the SVG
        if (elementRef.current) {
          elementRef.current.innerHTML = svg;
          stripNavigationAnchors(elementRef.current);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        console.error('Mermaid rendering error:', error);
        setHasError(true);

        // Extract meaningful error message
        let message = 'Failed to render diagram';
        if (error instanceof Error) {
          // Clean up the error message - remove version info and extra details
          message = error.message
            .replace(/mermaid version [\d.]+/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
        setErrorMessage(message);

        // Clean up any error SVGs that mermaid may have inserted
        const errorElements = document.querySelectorAll(`#${graphId}, [id^="mermaid-"]`);
        errorElements.forEach(el => {
          if (el.parentNode) {
            el.parentNode.removeChild(el);
          }
        });

        // Try to clean up mermaid's internal state
        try {
          // @ts-expect-error - Mermaid API types don't include reset method
          if (window.mermaid?.mermaidAPI?.reset) {
            // @ts-expect-error - Mermaid API types don't include reset method
            window.mermaid.mermaidAPI.reset();
          }
        } catch (e) {
          // Ignore reset errors
        }
      }
    };

    // Render with a small delay to ensure DOM is ready
    const timer = setTimeout(renderChart, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chart, id]);

  if (hasError) {
    return (
      <div className="border border-status-error/30 rounded p-2 bg-status-error/5 text-sm">
        <p className="text-status-error">
          <span className="font-semibold">⚠ Diagram error:</span>{' '}
          <span className="text-status-error/90">{errorMessage}</span>
        </p>
      </div>
    );
  }

  return (
    <div 
      ref={elementRef}
      className="mermaid-container my-4 flex justify-center items-center min-h-[100px]"
    />
  );
};