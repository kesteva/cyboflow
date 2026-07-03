import DOMPurify from 'dompurify';

// Configure DOMPurify for safe HTML output
const config = {
  ALLOWED_TAGS: ['span', 'br', 'p', 'div', 'b', 'i', 'em', 'strong', 'code', 'pre'],
  ALLOWED_ATTR: ['class', 'style'],
  KEEP_CONTENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

// Per-property style allowlist. DOMPurify has no built-in style-prop filter
// (the old `ALLOWED_STYLE_PROPS` config key was a no-op), so we enforce it via
// an afterSanitizeAttributes hook that rewrites each element's `style` attribute
// to keep only these properties — blocking layout/clickjacking injection like
// `style="position: absolute"` while leaving colour/weight styling intact.
const ALLOWED_STYLE_PROPS = ['color', 'background-color', 'font-weight'];

function filterStyleAttribute(node: Element): void {
  if (typeof node.getAttribute !== 'function' || !node.hasAttribute('style')) return;

  const kept: string[] = [];
  for (const declaration of (node.getAttribute('style') ?? '').split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) continue;
    const prop = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (prop && value && ALLOWED_STYLE_PROPS.includes(prop)) {
      kept.push(`${prop}: ${value}`);
    }
  }

  if (kept.length > 0) {
    node.setAttribute('style', kept.join('; '));
  } else {
    node.removeAttribute('style');
  }
}

/**
 * Sanitize HTML content to prevent XSS attacks
 * @param dirty - The potentially unsafe HTML string
 * @returns The sanitized HTML string
 */
export function sanitizeHtml(dirty: string): string {
  // Register the style-prop filter only around this call so the hook never
  // leaks into other DOMPurify consumers.
  DOMPurify.addHook('afterSanitizeAttributes', filterStyleAttribute);
  try {
    return DOMPurify.sanitize(dirty, config);
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/**
 * Sanitize and format git output for safe display
 * @param output - The raw git output
 * @returns The sanitized and formatted output
 */
export function sanitizeGitOutput(output: string): string {
  // First escape any HTML entities in the raw output
  const escaped = output
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
  
  // Then apply any formatting (this is now safe since we've escaped the content)
  return escaped;
}