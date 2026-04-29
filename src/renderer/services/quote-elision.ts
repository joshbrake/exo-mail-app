/**
 * Splits an email body into new content and quoted/forwarded content.
 *
 * Returns the new (top) portion of the email with trailing quoted text removed,
 * and a flag indicating whether quoted content was found and stripped.
 *
 * Used in thread view to avoid showing redundant quoted text — the previous
 * messages are already visible above in the thread.
 *
 * Detection happens in three passes:
 *   1. Known wrapper selectors (`.gmail_quote`, `blockquote[type="cite"]`, ...).
 *   2. Attribution patterns matched against flattened text of top-level body
 *      children (handles attributions split across `<b>`/`<span>`/`<br>` tags
 *      and Outlook-style `From:/Sent:/To:` header blocks).
 *   3. Thread-overlap fallback: if `priorMessageTexts` is provided, any
 *      top-level child whose normalized text appears verbatim in an earlier
 *      message in the thread is treated as quoted history and cut.
 */
export function splitQuotedContent(
  body: string,
  priorMessageTexts?: string[],
): {
  newContent: string;
  hasQuotedContent: boolean;
} {
  if (!body) return { newContent: body, hasQuotedContent: false };

  if (isHtmlContent(body)) {
    return splitHtmlQuoted(body, priorMessageTexts);
  }
  return splitPlainTextQuoted(body, priorMessageTexts);
}

/**
 * Extract plain text from an email body. HTML inputs are parsed and
 * `textContent` is returned; plain-text inputs pass through unchanged.
 *
 * Used by callers building a list of prior-message bodies to feed into
 * `splitQuotedContent`'s thread-overlap fallback.
 */
export function emailBodyToPlainText(body: string): string {
  if (!body) return "";
  if (!isHtmlContent(body)) return body;
  const doc = new DOMParser().parseFromString(body, "text/html");
  return doc.body.textContent || "";
}

// HTML detection for routing between the DOM and plain-text paths. We only
// route to the HTML path when a real HTML tag name is present — the loose
// "any `<lowercase>` tag" check in email-body-cache.ts misclassifies plain
// text containing `<bob@example.com>` as HTML, which would break the
// plain-text detector for emails with angle-bracket sender addresses.
function isHtmlContent(content: string): boolean {
  return /<(div|span|p|br|html|body|table|tr|td|a|img|ul|ol|li|h[1-6]|blockquote|style|head|meta|link)(\s|>|\/)/i.test(
    content,
  );
}

// ---------------------------------------------------------------------------
// Shared patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that match the START of attribution text in a flattened block.
 *
 * Each pattern is intentionally anchored to `^` and bounded — a long
 * unbounded `[\s\S]+?` could backtrack catastrophically on a 200KB body.
 */
const ATTRIBUTION_START_PATTERNS: RegExp[] = [
  // "On Mon, Jan 6, 2025 at 3:45 PM Bob <bob@example.com> wrote:"
  // Up to 300 chars between "On " and "wrote:" — handles attributions that
  // wrap across one or two visual lines. Word boundary after "wrote" guards
  // against matching "wrote:" mid-sentence (e.g. "we wrote: see attached").
  /^On\s[\s\S]{1,300}?\swrote:/,
  // Outlook: "-----Original Message-----"
  /^-{3,}\s*Original Message\s*-{3,}/i,
  // Gmail forwards: "---------- Forwarded message ----------"
  /^-{3,}\s*Forwarded message\s*-{3,}/i,
  // Outlook desktop sometimes uses "Begin forwarded message:"
  /^Begin forwarded message:/i,
];

/**
 * Detects an Outlook-style header block at the start of a flattened text:
 *   From: ...
 *   Sent: ... (or Date:)
 *   To: ...
 *   Subject: ...
 *
 * The fields can be on separate lines (matched via newlines) or consolidated
 * on one line. We require `From:` plus at least two of (Sent|Date|To|Subject).
 */
function isOutlookHeaderBlock(text: string): boolean {
  if (!/^From:\s*\S/.test(text)) return false;
  // Look only at the first ~600 chars — header blocks are short.
  const head = text.substring(0, 600);
  let count = 0;
  if (/(?:^|\n|\s)Sent:\s*\S/.test(head)) count++;
  if (/(?:^|\n|\s)Date:\s*\S/.test(head)) count++;
  if (/(?:^|\n|\s)To:\s*\S/.test(head)) count++;
  if (/(?:^|\n|\s)Subject:\s*\S/.test(head)) count++;
  return count >= 2;
}

// ---------------------------------------------------------------------------
// HTML quote detection
// ---------------------------------------------------------------------------

function splitHtmlQuoted(
  html: string,
  priorMessageTexts?: string[],
): {
  newContent: string;
  hasQuotedContent: boolean;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const container = unwrapSingleChildContainer(doc.body);

  // Selectors for known quoted-content wrappers, most specific first.
  const quoteSelectors = [
    ".gmail_quote", // Gmail
    ".gmail_extra", // Older Gmail
    "#divRplyFwdMsg", // Outlook
    "#appendonsend", // Outlook (newer)
    ".yahoo_quoted", // Yahoo Mail
    'blockquote[type="cite"]', // Apple Mail / Thunderbird
  ];

  let cutTarget: ChildNode | null = null;

  for (const selector of quoteSelectors) {
    const el = container.querySelector(selector);
    if (!el) continue;
    // Walk up to a direct child of the container that wraps the match.
    let target: Element = el;
    while (target.parentElement && target.parentElement !== container) {
      target = target.parentElement;
    }
    // Guard: if the entire container would be removed, skip — there'd be
    // no visible content left and the post-strip emptiness check would
    // restore the full body anyway.
    if (target === container.firstElementChild && !target.previousSibling) {
      // Only skip if this would leave nothing — check via container.children count.
      if (container.children.length === 1) continue;
    }
    cutTarget = target;
    break;
  }

  // Pass 2a: scan top-level body children with flattened text against the
  // attribution patterns above (handles attributions split across inline
  // tags, multi-line wrapping, Outlook header blocks).
  if (!cutTarget) {
    cutTarget = findCutChildByPatterns(container);
  }

  // Pass 2b: descend into each top-level child and look for marker patterns
  // in `<br>`-separated logical blocks. This catches the common Outlook /
  // mailing-list shape where the entire email body sits inside one wrapper
  // `<div>` with line breaks via `<br>` rather than sibling block elements.
  if (!cutTarget) {
    cutTarget = findCutInsideBrSeparated(container);
  }

  // Pass 3: thread-overlap fallback. If we have prior messages and pattern
  // detection missed, any block whose text appears in an earlier message is
  // quoted history.
  if (!cutTarget && priorMessageTexts && priorMessageTexts.length > 0) {
    cutTarget = findCutChildByThreadOverlap(container, priorMessageTexts);
  }

  if (!cutTarget) return { newContent: html, hasQuotedContent: false };

  removeFromCutPointOnward(cutTarget, container);
  cleanTrailingWhitespace(container);
  if (container !== doc.body) cleanTrailingWhitespace(doc.body);

  // Preserve <style> tags that the HTML5 parser moved into <head> — without
  // them, newsletters and styled emails would lose their CSS in the trimmed view.
  const headStyles = Array.from(doc.querySelectorAll("head style"))
    .map((s) => s.outerHTML)
    .join("");
  const newContent = (headStyles + doc.body.innerHTML).trim();

  // If stripping removed all visible content, show the full body instead.
  // Strip <style> blocks first — their CSS text is not visible content.
  if (
    !newContent ||
    !newContent
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, "")
      .trim()
  ) {
    return { newContent: html, hasQuotedContent: false };
  }

  return { newContent, hasQuotedContent: true };
}

/**
 * Walk top-level children of `<body>` (descending through single-child
 * wrapper divs first), and return the first child whose flattened text
 * starts with a quote-attribution marker — that child plus everything
 * following is quoted history.
 *
 * Operating on flattened text per top-level child, rather than per text
 * node, is what makes this robust to attributions broken up by inline tags
 * (`<b>`, `<span>`, `<br>`) and to multi-line Outlook header blocks where
 * each header field is in its own `<div>`.
 */
function findCutChildByPatterns(container: HTMLElement): Element | null {
  return walkPatternMatch(container);
}

/**
 * Recursive pattern walk: find the first element (in document order) whose
 * flattened text starts with a quote-attribution marker. Recurses into
 * wrapping elements when no marker is at the start of a top-level child —
 * Outlook desktop, mailing-list digests, and other clients produce HTML
 * where the body contents sit inside multiple layers of `<div>`/`<p>` and
 * the unwrap heuristic alone can't reach the relevant container (e.g. body
 * has multiple element children due to malformed namespace tags like `<o:p>`,
 * blocking single-child unwrap).
 */
function walkPatternMatch(parent: Element): Element | null {
  const children = Array.from(parent.children);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const text = flattenChildText(child);
    if (!text) {
      // Empty wrapper — still recurse, since rare structures wrap in empty-text
      // containers (e.g. table cells).
      if (child.children.length > 0) {
        const inner = walkPatternMatch(child);
        if (inner) return inner;
      }
      continue;
    }
    const head = text.substring(0, 600);

    if (ATTRIBUTION_START_PATTERNS.some((p) => p.test(head))) return child;
    if (isOutlookHeaderBlock(head)) return child;
    if (/^From:\s*\S/.test(head) && hasFollowingHeaderLines(children, i)) {
      return child;
    }

    // No marker at the start of this child — recurse to look inside.
    if (child.children.length > 0) {
      const inner = walkPatternMatch(child);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Get a child's flattened text content for pattern matching. We replace
 * `<br>` elements with newlines first — `textContent` drops them otherwise,
 * which would collapse `From: Bob<br>Sent: ...` to `From: BobSent: ...` and
 * defeat the Outlook-header detection.
 */
function flattenChildText(child: Element): string {
  const clone = child.cloneNode(true) as Element;
  const ownerDoc = clone.ownerDocument;
  if (ownerDoc) {
    const brs = clone.querySelectorAll("br");
    for (let i = brs.length - 1; i >= 0; i--) {
      brs[i].replaceWith(ownerDoc.createTextNode("\n"));
    }
  }
  return normalizeWhitespace(clone.textContent || "");
}

/**
 * Walk each top-level child's `<br>`-separated logical blocks and look for
 * attribution / header markers. Catches the case where an entire email body
 * is one wrapper `<div>` with line breaks via `<br>` (the per-child walker
 * only sees one block of flattened text starting with the new content).
 *
 * The returned cut node may be a text node or inline element — the caller
 * uses `removeFromCutPointOnward` to handle the deeper-than-direct-child case.
 */
function findCutInsideBrSeparated(container: HTMLElement): ChildNode | null {
  // Recursive walk: at each element, group its childNodes by `<br>`
  // boundaries and look for attribution markers in the resulting blocks.
  // This catches the shape where an element's contents are interleaved text
  // nodes and `<br>`s with a marker mid-stream — which `walkPatternMatch`
  // can't see because the matching element's flattened text starts with the
  // visible content, not the marker.
  return walkBrMatch(container);
}

function walkBrMatch(parent: Element): ChildNode | null {
  const groups = collectBrSeparatedGroups(parent);
  if (groups.length >= 2) {
    const cut = findCutInGroups(groups);
    if (cut) return cut;
  }
  for (const child of Array.from(parent.children)) {
    if (child.children.length > 0 || child.childNodes.length > 1) {
      const inner = walkBrMatch(child);
      if (inner) return inner;
    }
  }
  return null;
}

interface BrGroup {
  text: string;
  firstNode: ChildNode;
}

function collectBrSeparatedGroups(parent: Element): BrGroup[] {
  const groups: BrGroup[] = [];
  let currentNodes: ChildNode[] = [];

  const flush = () => {
    if (currentNodes.length === 0) return;
    const text = normalizeWhitespace(currentNodes.map(extractInlineText).join(""));
    groups.push({ text, firstNode: currentNodes[0] });
    currentNodes = [];
  };

  for (const node of Array.from(parent.childNodes)) {
    if (isBrElement(node)) {
      flush();
    } else {
      currentNodes.push(node);
    }
  }
  flush();

  return groups;
}

function findCutInGroups(groups: BrGroup[]): ChildNode | null {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.text) continue;
    const head = g.text.substring(0, 600);
    if (ATTRIBUTION_START_PATTERNS.some((p) => p.test(head))) return g.firstNode;
    if (isOutlookHeaderBlock(head)) return g.firstNode;
    if (/^From:\s*\S/.test(head) && hasFollowingHeaderGroups(groups, i)) return g.firstNode;
  }
  return null;
}

function hasFollowingHeaderGroups(groups: BrGroup[], startIdx: number): boolean {
  let count = 0;
  let nonEmptyChecked = 0;
  for (let i = startIdx + 1; i < groups.length; i++) {
    const text = groups[i].text;
    if (!text) continue;
    if (/^(Sent|Date|To|Cc|Subject):\s*\S/.test(text)) {
      count++;
    } else {
      break;
    }
    nonEmptyChecked++;
    if (nonEmptyChecked >= 5) break;
  }
  return count >= 2;
}

function isBrElement(node: ChildNode): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR";
}

function extractInlineText(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType === Node.ELEMENT_NODE) {
    return flattenChildText(node as Element);
  }
  return "";
}

/**
 * Remove `cutNode` and everything that follows it in document order, up to
 * (but not including) `container`. Preserves visible content above the cut
 * by walking up from `cutNode`'s parents and removing each ancestor's
 * following siblings — but not the ancestors themselves.
 *
 * Handles three cases uniformly:
 *   - cutNode is a direct child of container → remove cutNode + following sibs.
 *   - cutNode is nested inside a wrapper that is a direct child of container
 *     → remove cutNode + following sibs within wrapper, then remove the
 *     wrapper's following sibs in container.
 *   - cutNode is deeply nested → remove at every ancestor level up to container.
 */
function removeFromCutPointOnward(cutNode: ChildNode, container: Element): void {
  // Snapshot the ancestor chain BEFORE any removal — once cutNode is removed,
  // its parentNode reference goes null.
  const ancestors: ChildNode[] = [];
  let p = cutNode.parentNode;
  while (p && p !== container) {
    ancestors.push(p as ChildNode);
    p = p.parentNode;
  }

  // Step 1: remove cutNode and its following siblings within its parent. Then
  // strip trailing whitespace/spacer-paragraphs at that level, so Outlook
  // `<p>&nbsp;</p>` blocks that sat between the visible content and the cut
  // point don't leave a tall gap behind.
  const cutParent = cutNode.parentNode as Element | null;
  removeNodeAndFollowing(cutNode);
  if (cutParent) cleanTrailingWhitespace(cutParent);

  // Step 2: for each ancestor up to (but not including) container, remove that
  // ancestor's following siblings within ITS parent (the ancestor itself stays
  // because it contains the visible content above the cut), then clean the
  // grandparent's tail too. Without this, trailing spacer paragraphs at higher
  // levels in the tree render as empty space below the visible content.
  for (const anc of ancestors) {
    if (anc.nextSibling) {
      removeNodeAndFollowing(anc.nextSibling as ChildNode);
    }
    const ancParent = anc.parentNode as Element | null;
    if (ancParent) cleanTrailingWhitespace(ancParent);
  }
}

/** True when at least 2 of the next few siblings start with header-shaped text. */
function hasFollowingHeaderLines(children: Element[], startIdx: number): boolean {
  let count = 0;
  for (let i = startIdx + 1; i < Math.min(startIdx + 6, children.length); i++) {
    const text = flattenChildText(children[i]);
    if (/^(Sent|Date|To|Cc|Subject):\s*\S/.test(text)) {
      count++;
    } else if (text) {
      // Stop at the first non-header, non-empty sibling.
      break;
    }
  }
  return count >= 2;
}

/**
 * If `body` has a single substantive element child wrapping its content
 * (common for Outlook web and rich HTML emails), descend into that child so
 * the per-child walks operate on the actual content blocks rather than a
 * single outer wrapper.
 */
function unwrapSingleChildContainer(body: HTMLElement): HTMLElement {
  let container: HTMLElement = body;
  while (
    container.children.length === 1 &&
    /^(div|section|article|main|center|table|tbody|tr|td)$/i.test(container.children[0].tagName)
  ) {
    container = container.children[0] as HTMLElement;
  }
  return container;
}

/**
 * Pass 3: find the first top-level body child whose normalized text appears
 * in an earlier message of the same thread. That block is quoted history.
 *
 * Comparison is on whitespace-normalized lowercased plain text — robust to
 * formatting differences (the forwarder may have re-styled or re-wrapped
 * the original).
 */
function findCutChildByThreadOverlap(
  container: HTMLElement,
  priorTexts: string[],
): Element | null {
  const MIN_BLOCK_LENGTH = 80;
  const PER_PRIOR_CAP = 50_000;

  const priors = priorTexts
    .map((t) => normalizeForOverlap(t).substring(0, PER_PRIOR_CAP))
    .filter((t) => t.length >= MIN_BLOCK_LENGTH);
  if (priors.length === 0) return null;

  for (const child of Array.from(container.children)) {
    const text = normalizeForOverlap(child.textContent || "");
    if (text.length < MIN_BLOCK_LENGTH) continue;
    if (priors.some((p) => p.includes(text))) return child;
  }
  return null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeForOverlap(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Remove `node` and every sibling that follows it. */
function removeNodeAndFollowing(node: ChildNode): void {
  const toRemove: ChildNode[] = [];
  let current: ChildNode | null = node;
  while (current) {
    toRemove.push(current);
    current = current.nextSibling;
  }
  for (const n of toRemove) n.remove();
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

/** Strip trailing <br>, empty whitespace text nodes, and empty container elements. */
function cleanTrailingWhitespace(el: Element): void {
  let last = el.lastChild;
  while (last) {
    if (last.nodeType === Node.TEXT_NODE && !last.textContent?.trim()) {
      const prev = last.previousSibling;
      last.remove();
      last = prev;
    } else if (isElement(last)) {
      if (last.tagName === "BR") {
        const prev = last.previousSibling;
        last.remove();
        last = prev;
      } else if (!last.textContent?.trim() && !last.querySelector("img")) {
        const prev = last.previousSibling;
        last.remove();
        last = prev;
      } else {
        break;
      }
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Plain-text quote detection
// ---------------------------------------------------------------------------

function splitPlainTextQuoted(
  text: string,
  priorMessageTexts?: string[],
): {
  newContent: string;
  hasQuotedContent: boolean;
} {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // "On ... wrote:" attribution, possibly wrapped onto the next line.
    if (/^On\s/.test(line)) {
      const singleLine = /^On\s.+?\swrote:\s*$/.test(line);
      const nextLine = lines[i + 1]?.trim() ?? "";
      const twoLine = !singleLine && /\swrote:\s*$/.test(nextLine);
      if (singleLine || twoLine) {
        const above = lines.slice(0, i).join("\n").trimEnd();
        if (above) return { newContent: above, hasQuotedContent: true };
      }
    }

    // Forwarded message marker
    if (/^-{3,}\s*Forwarded message\s*-{3,}$/.test(line)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return { newContent: above, hasQuotedContent: true };
    }

    // Outlook "Original Message" marker
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(line)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return { newContent: above, hasQuotedContent: true };
    }

    // Outlook header block: "From:" line followed by at least two of
    // Sent:/Date:/To:/Cc:/Subject: in the immediately following lines.
    if (/^From:\s*\S/.test(line) && isOutlookHeaderBlockInLines(lines, i)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return { newContent: above, hasQuotedContent: true };
    }

    // Block of ">" quoted lines — only split if there's real content above.
    if (line.startsWith(">")) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above && !above.split("\n").every((l) => l.trim().startsWith(">"))) {
        return { newContent: above, hasQuotedContent: true };
      }
    }
  }

  // Pass 3: thread-overlap fallback for plain text — split on blank lines
  // and check each block.
  if (priorMessageTexts && priorMessageTexts.length > 0) {
    const overlapResult = findPlainTextOverlap(text, priorMessageTexts);
    if (overlapResult) return overlapResult;
  }

  return { newContent: text, hasQuotedContent: false };
}

function isOutlookHeaderBlockInLines(lines: string[], startIdx: number): boolean {
  let count = 0;
  for (let i = startIdx + 1; i < Math.min(startIdx + 6, lines.length); i++) {
    const line = lines[i].trim();
    if (/^(Sent|Date|To|Cc|Subject):\s*\S/.test(line)) {
      count++;
    } else if (line) {
      break;
    }
  }
  return count >= 2;
}

function findPlainTextOverlap(
  text: string,
  priorTexts: string[],
): { newContent: string; hasQuotedContent: boolean } | null {
  const MIN_BLOCK_LENGTH = 80;
  const PER_PRIOR_CAP = 50_000;

  const priors = priorTexts
    .map((t) => normalizeForOverlap(t).substring(0, PER_PRIOR_CAP))
    .filter((t) => t.length >= MIN_BLOCK_LENGTH);
  if (priors.length === 0) return null;

  // Split on blank lines into blocks. Track each block's character offset so
  // we can cut the original text at the right position.
  const blocks: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip blank-line runs to find block start.
    while (i < text.length && /[\s]/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    // Read until two consecutive newlines (or EOF).
    while (i < text.length) {
      if (text[i] === "\n" && text[i + 1] === "\n") break;
      i++;
    }
    blocks.push({ start, end: i, text: text.substring(start, i) });
  }

  for (const block of blocks) {
    const norm = normalizeForOverlap(block.text);
    if (norm.length < MIN_BLOCK_LENGTH) continue;
    if (priors.some((p) => p.includes(norm))) {
      const above = text.substring(0, block.start).trimEnd();
      if (above) return { newContent: above, hasQuotedContent: true };
    }
  }
  return null;
}
