/**
 * Tier-3 widget document theme tokens (docs/proposals/CUSTOM-VIEWS.md §5.4).
 *
 * A tier-3 widget frame is served from a cross-origin loopback document with
 * no access to the app's own stylesheet — `buildWidgetDocument`
 * (`shared/customViews/widgetDocument.ts`) writes these as `--<token>:<value>;`
 * custom properties on `:root` instead. Values are the light "paper" theme's
 * literal colors from `frontend/src/styles/tokens/colors.css` (the app's
 * default theme); there is no dark-mode variant for v1 — see plan §5.4/§11.
 *
 * Keep this file free of Node.js built-ins so it runs in any environment.
 */

export const WIDGET_THEME_TOKENS: Record<string, string> = {
  paper: '#f5f1e8',
  'paper-1': '#faf7ef',
  'paper-2': '#ebe4d2',
  'paper-3': '#efeadc',
  'paper-4': '#e1d8c0',
  'paper-white': '#ffffff',
  ink: '#1a1815',
  'ink-2': '#6a5e44',
  'ink-3': '#9c8e6c',
  line: '#d8cfb8',
  'line-2': '#e6dec7',
  terracotta: '#c96442',
  'terracotta-deep': '#a8543a',
  'green-accent': '#2d8a5b',
  'amber-accent': '#d4a72c',
  'warm-red': '#b5482f',
};
