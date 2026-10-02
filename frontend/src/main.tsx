import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import './styles/markdown-preview.css';

// The DSN, opt-out gating, scrubbing, and transport all live in the MAIN process.
// The renderer SDK forwards events to main over a custom `sentry-ipc://` protocol
// that ONLY exists once main initialized Sentry. Initializing the renderer SDK when
// main did not floods the console with "sentry-ipc scheme not supported" errors on
// every scope sync, so gate the renderer init on main's actual Sentry state (off
// under `pnpm dev`, and in packaged builds that opted out or have no DSN).
if (window.electronAPI?.telemetry?.isSentryActive?.()) {
  Sentry.init({});
}

// Global error handlers to catch errors that React error boundaries can't.
// A stray rejection is logged, never surfaced as a blocking modal: the console
// reaches cyboflow-frontend-debug.log in dev, Sentry's own global handler
// (registered by Sentry.init above, when active) still captures the event, and
// failures the user must see go through errorStore / ErrorBoundary.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  // Suppress the default "Uncaught (in promise)" console line; the error above
  // already logs it.
  event.preventDefault();
});

window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
  // Note: We don't prevent default here as the error boundary should catch React errors
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);