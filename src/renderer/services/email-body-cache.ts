import DOMPurify from "dompurify";

/**
 * Checks if content appears to be HTML.
 * Re-exported so EmailDetail.tsx can use the same check for theme decisions
 * without duplicating the implementation.
 */
export function isHtmlContent(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

/**
 * Detects HTML that is essentially plain text in a minimal wrapper — the actual
 * line breaks are \n characters rather than <br>, <p>, or block-level elements.
 */
function isPlainTextInHtml(html: string): boolean {
  if (/<(?:br|p|blockquote|table|pre|h[1-6])[\s/>]/i.test(html)) return false;
  const divCount = (html.match(/<div[\s>]/gi) || []).length;
  if (divCount > 3) return false;
  const textContent = html.replace(/<[^>]*>/g, "");
  return (textContent.match(/\n/g) || []).length >= 2;
}

/**
 * Detect whether HTML email has its own background colors (rich marketing emails).
 * Re-exported so EmailDetail.tsx can use it for theme decisions.
 *
 * White/transparent backgrounds are excluded — many email clients set an explicit
 * `background-color: white` or `bgcolor="#ffffff"` which is just the default, not
 * an indicator of rich styling.
 */
export function hasRichBackground(html: string): boolean {
  const isDefaultBg = (value: string): boolean => {
    const v = value.trim().toLowerCase();
    return (
      v === "white" ||
      v === "#fff" ||
      v === "#ffffff" ||
      v === "transparent" ||
      v === "none" ||
      v === "inherit" ||
      v === "initial" ||
      v === "unset" ||
      /^rgba?\s*\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*[\d.]+)?\s*\)$/.test(v)
    );
  };

  // Check bgcolor HTML attributes for non-white colors
  for (const m of html.matchAll(/bgcolor\s*=\s*["']?([^"'>;]+)["']?/gi)) {
    if (!isDefaultBg(m[1])) return true;
  }
  // Check background-color CSS declarations for non-white colors
  for (const m of html.matchAll(/background-color\s*:\s*([^;}"'!]+)/gi)) {
    if (!isDefaultBg(m[1])) return true;
  }
  // Check background shorthand CSS declarations for non-white colors.
  // Skip url() values — background images (e.g. tracking pixels) aren't "rich" backgrounds.
  for (const m of html.matchAll(/background\s*:\s*([^;}"'!]+)/gi)) {
    const val = m[1].trim().toLowerCase();
    if (/^url\(/.test(val)) continue;
    if (!isDefaultBg(m[1])) return true;
  }

  return false;
}

/**
 * Replace inline data: URIs larger than ~50KB with a lightweight SVG placeholder.
 * Emails can contain multi-MB base64 images/videos that make DOMParser,
 * DOMPurify, and iframe rendering extremely slow. Call this before any heavy
 * processing (quote splitting, sanitization, rendering).
 *
 * Exported so EmailDetail can strip once and pass the light body to both
 * splitQuotedContent and EmailBodyRenderer.
 */
const MAX_DATA_URI_LEN = 50_000; // ~37KB decoded

export function stripLargeDataUris(body: string, useLightMode = true): string {
  if (!body.includes("data:")) return body;

  return body.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*["'])(data:[^"']+)(["'][^>]*>)/gi,
    (_match, before: string, dataUri: string, after: string) => {
      if (dataUri.length < MAX_DATA_URI_LEN) return _match;
      const mimeMatch = dataUri.match(/^data:([^;,]+)/);
      const mime = mimeMatch?.[1] ?? "image";
      const sizeKB = Math.round((dataUri.length * 3) / 4 / 1024);
      const sizeLabel = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
      const fill = useLightMode ? "#f3f4f6" : "#374151";
      const textFill = useLightMode ? "#6b7280" : "#9ca3af";
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60">` +
        `<rect width="400" height="60" rx="8" fill="${fill}"/>` +
        `<text x="200" y="35" text-anchor="middle" fill="${textFill}" font-family="system-ui" font-size="13">` +
        `Inline ${mime} (${sizeLabel}) — too large to display inline` +
        `</text></svg>`;
      return `${before}data:image/svg+xml,${encodeURIComponent(svg)}${after}`;
    },
  );
}

const SANITIZE_CONFIG = {
  WHOLE_DOCUMENT: true,
  ALLOWED_TAGS: [
    "p",
    "br",
    "div",
    "span",
    "a",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "small",
    "sup",
    "sub",
    "del",
    "ins",
    "mark",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "tr",
    "td",
    "th",
    "thead",
    "tbody",
    "tfoot",
    "caption",
    "col",
    "colgroup",
    "img",
    "figure",
    "figcaption",
    "blockquote",
    "pre",
    "code",
    "hr",
    "center",
    "font",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "aside",
    "style",
    "html",
    "head",
    "body",
  ],
  ALLOWED_ATTR: [
    "href",
    "src",
    "alt",
    "title",
    "style",
    "class",
    "id",
    "target",
    "width",
    "height",
    "border",
    "cellpadding",
    "cellspacing",
    "colspan",
    "rowspan",
    "align",
    "valign",
    "bgcolor",
    "color",
    "face",
    "size",
    "type",
    "dir",
    "role",
    "span",
  ],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|data|cid):)/i,
};

/**
 * Extract <style> tags and body content from a WHOLE_DOCUMENT sanitized output.
 * DOMPurify with WHOLE_DOCUMENT: true returns `<html><head>...</head><body>...</body></html>`.
 * We pull out any <style> blocks and the body innerHTML to merge into our iframe template.
 */
function extractFromSanitizedDoc(sanitizedHtml: string): {
  styles: string;
  bodyContent: string;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizedHtml, "text/html");

  // Collect all <style> tags (from both head and body)
  const styleTags = doc.querySelectorAll("style");
  const styles = Array.from(styleTags)
    .map((s) => s.outerHTML)
    .join("\n");

  // Remove style tags from body before extracting body content
  doc.body.querySelectorAll("style").forEach((s) => s.remove());

  return { styles, bodyContent: doc.body.innerHTML };
}

function buildIframeHtml(
  sanitizedDoc: string,
  useLightMode: boolean,
  needsPreLine: boolean,
): string {
  const { styles: emailStyles, bodyContent } = extractFromSanitizedDoc(sanitizedDoc);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <base target="_blank">
  ${emailStyles}
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      /* Loose line-height (1.6) is only desirable for plain-text-in-HTML
         (pre-line) bodies. HTML emails (especially Outlook with its explicit
         spacer paragraphs) render with too much vertical whitespace at 1.6.
         Pin to 1.2 explicitly for HTML rather than the keyword "normal",
         which resolves to font-dependent values; Aptos and other modern
         fonts can compute "normal" as high as 1.5, leaving the gaps loose. */
      line-height: ${needsPreLine ? "1.6" : "1.2"};
      color: ${useLightMode ? "#374151" : "#e5e7eb"};
      background: ${useLightMode ? "transparent" : "#1f2937"};
      margin: 0;
      padding: 4px 8px;
      word-break: break-word;
      overflow-wrap: break-word;${needsPreLine ? "\n      white-space: pre-line;" : ""}
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${useLightMode ? "#3b82f6" : "#60a5fa"}; }
    table { max-width: 100%; border-collapse: collapse; }
    /* Contain wide tables/images so they don't overflow the viewport */
    .email-wrapper { max-width: 100%; overflow-x: auto; }
    td, th { vertical-align: top; }
    pre, code { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
    blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid ${useLightMode ? "#e5e7eb" : "#4b5563"}; color: ${useLightMode ? "#6b7280" : "#9ca3af"}; }
    hr { border: none; border-top: 1px solid ${useLightMode ? "#e5e7eb" : "#4b5563"}; margin: 16px 0; }
    ${
      !useLightMode
        ? `
    /* Override inline styles that assume a white background.
       Only applied in dark-content mode (non-rich HTML emails). */
    body, div, p, span, td, th, li, font, h1, h2, h3, h4, h5, h6 {
      color: #e5e7eb !important;
    }
    div, p, span, td, th, li, font, h1, h2, h3, h4, h5, h6,
    table, tr, thead, tbody, tfoot, center, blockquote, pre {
      background-color: transparent !important;
    }
    blockquote, blockquote * { color: #9ca3af !important; background-color: transparent !important; }
    a { color: #60a5fa !important; }
    `
        : ""
    }
  </style>
</head>
<body><div class="email-wrapper">${bodyContent}</div></body>
</html>`;
}

export type SanitizedResult =
  | {
      isHtml: true;
      htmlContent: string;
    }
  | {
      isHtml: false;
      htmlContent: null;
    };

/**
 * LRU cache for pre-sanitized email body HTML. Stores the complete iframe HTML
 * document (DOMPurify output + CSS) so switching between emails doesn't
 * re-sanitize each time.
 *
 * Cache key: `${emailId}:${lightMode}` — different themes produce different CSS,
 * so each theme variant is cached separately.
 */
class EmailBodyCache {
  private cache = new Map<string, SanitizedResult>();
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  private makeKey(emailId: string, useLightMode: boolean): string {
    return `${emailId}:${useLightMode ? "l" : "d"}`;
  }

  /**
   * Get cached sanitized HTML, or compute + cache it synchronously.
   *
   * The cache key is `emailId:lightMode` — `body` is only used on cache miss
   * to compute the result. This is correct because Gmail message bodies are
   * immutable: the body for a given emailId never changes.
   */
  getOrCompute(emailId: string, body: string, useLightMode: boolean): SanitizedResult {
    const key = this.makeKey(emailId, useLightMode);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Move to end for LRU freshness
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const result = this.compute(body, useLightMode);
    this.set(key, result);
    return result;
  }

  /**
   * Check if a result is already cached.
   */
  has(emailId: string, useLightMode: boolean): boolean {
    return this.cache.has(this.makeKey(emailId, useLightMode));
  }

  /**
   * Precompute sanitized HTML in the background without blocking the current render.
   * Uses requestIdleCallback where available, falls back to setTimeout(0).
   * Returns a cancel function so callers can clean up stale precompute requests
   * (e.g., in a useEffect cleanup when the user rapidly switches threads).
   */
  precompute(emailId: string, body: string, useLightMode: boolean): () => void {
    const key = this.makeKey(emailId, useLightMode);
    if (this.cache.has(key)) return () => {};

    const useIdleCallback = typeof requestIdleCallback === "function";

    const handle: number = useIdleCallback
      ? requestIdleCallback(() => {
          if (this.cache.has(key)) return;
          const result = this.compute(body, useLightMode);
          this.set(key, result);
        })
      : window.setTimeout(() => {
          if (this.cache.has(key)) return;
          const result = this.compute(body, useLightMode);
          this.set(key, result);
        }, 0);

    return () => {
      if (useIdleCallback) {
        cancelIdleCallback(handle);
      } else {
        clearTimeout(handle);
      }
    };
  }

  /**
   * Invalidate cached entries for an email.
   */
  invalidate(emailId: string): void {
    const toDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${emailId}:`)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private set(key: string, value: SanitizedResult): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first in Map iteration order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  private compute(body: string, useLightMode: boolean): SanitizedResult {
    if (!isHtmlContent(body)) {
      return { isHtml: false, htmlContent: null };
    }

    const stripped = stripLargeDataUris(body, useLightMode);

    const needsPreLine = isPlainTextInHtml(stripped);
    const clean = DOMPurify.sanitize(stripped, SANITIZE_CONFIG);
    const htmlContent = buildIframeHtml(clean, useLightMode, needsPreLine);

    return { isHtml: true, htmlContent };
  }
}

/** Singleton cache instance shared across all EmailBodyRenderer components */
export const emailBodyCache = new EmailBodyCache();
