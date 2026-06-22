import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import './styles/markdown-preview.css';

// The DSN, opt-out gating, scrubbing, and transport all live in the MAIN process.
// This renderer init is inert (a no-op) when main did not initialize Sentry, so no
// extra gating is needed here.
Sentry.init({});

// Global error handlers to catch errors that React error boundaries can't
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  // Prevent default browser behavior (showing error in console)
  event.preventDefault();

  // Show a user-friendly error message
  alert('An unexpected error occurred. The application may need to be restarted.\n\nError: ' + (event.reason?.message || String(event.reason)));
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