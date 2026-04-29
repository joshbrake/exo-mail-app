/**
 * Strips quoted/forwarded email content from an email body.
 * Works in Node.js (no DOM APIs required) — uses regex-based detection.
 *
 * Used to reduce token usage when sending emails to Claude for analysis.
 * Quoted content from previous messages in a thread is redundant when
 * the analyzer already has the thread history or only needs the latest message.
 *
 * Detection patterns mirror those in `src/renderer/services/quote-elision.ts`,
 * which handles the user-facing below-the-fold UI. They share the same
 * markers (Gmail/Outlook/Yahoo wrappers, "On ... wrote:", forwarded markers,
 * Original Message, Outlook header blocks) so the analyzer sees the same
 * trimmed body the user does.
 */

function isHtml(body: string): boolean {
  return /<(div|span|p|br|html|body|table|tr|td|a|img|ul|ol|li|h[1-6]|blockquote|style|head|meta|link)(\s|>|\/)/i.test(
    body,
  );
}

export function stripQuotedContent(body: string): string {
  if (!body) return body;
  const stripped = isHtml(body) ? stripHtmlQuoted(body) : stripPlainTextQuoted(body);
  return stripMediaContent(stripped);
}

// ---------------------------------------------------------------------------
// Media stripping — remove images, videos, audio that waste analysis tokens
// ---------------------------------------------------------------------------

function stripMediaContent(body: string): string {
  return (
    body
      // <img> tags (inline images, tracking pixels, CID-embedded images)
      .replace(/<img\s[^>]*>/gi, "")
      // <video>...</video> and <audio>...</audio>
      .replace(/<video\s[^>]*>[\s\S]*?<\/video>/gi, "")
      .replace(/<audio\s[^>]*>[\s\S]*?<\/audio>/gi, "")
      // Base64 data URIs that may appear in src attributes or plain text
      .replace(/data:(image|video|audio)\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[media removed]")
  );
}

// ---------------------------------------------------------------------------
// HTML quote stripping (regex-based, no DOM)
// ---------------------------------------------------------------------------

function stripHtmlQuoted(html: string): string {
  // Find the earliest occurrence of a known quoted-content wrapper
  // and truncate everything from that point onward.
  const quotePatterns = [
    /<div\s[^>]*class\s*=\s*["'][^"']*gmail_quote[^"']*["'][^>]*>/i,
    /<div\s[^>]*class\s*=\s*["'][^"']*gmail_extra[^"']*["'][^>]*>/i,
    /<div\s[^>]*id\s*=\s*["']divRplyFwdMsg["'][^>]*>/i,
    /<div\s[^>]*id\s*=\s*["']appendonsend["'][^>]*>/i,
    /<div\s[^>]*class\s*=\s*["'][^"']*yahoo_quoted[^"']*["'][^>]*>/i,
    /<blockquote\s[^>]*type\s*=\s*["']cite["'][^>]*>/i,
  ];

  let cutIndex = html.length;
  for (const pattern of quotePatterns) {
    const match = pattern.exec(html);
    if (match && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  if (cutIndex < html.length) {
    return returnIfHasContent(html, cutIndex) ?? html;
  }

  // Fallback: forwarded message marker in HTML text
  const fwdMatch = /-{3,}\s*Forwarded message\s*-{3,}/.exec(html);
  if (fwdMatch) {
    const result = returnIfHasContent(html, fwdMatch.index);
    if (result) return result;
  }

  // Fallback: Outlook "Original Message" separator
  const origMatch = /-{3,}\s*Original Message\s*-{3,}/i.exec(html);
  if (origMatch) {
    const result = returnIfHasContent(html, origMatch.index);
    if (result) return result;
  }

  // Fallback: "Begin forwarded message:" (Apple Mail / iOS forwards)
  const beginFwdMatch = /(?:^|>|\n)\s*Begin forwarded message:/i.exec(html);
  if (beginFwdMatch) {
    const startIdx = html.toLowerCase().indexOf("begin forwarded message:", beginFwdMatch.index);
    const result = returnIfHasContent(html, startIdx);
    if (result) return result;
  }

  // Fallback: "On ... wrote:" pattern (common in HTML replies without a class marker).
  // Anchored to a line boundary (start of string, or after <br>/<div>/<p>) to avoid
  // matching mid-sentence occurrences like "On this point, engineers wrote:".
  const wroteMatch = /(?:^|<br\s*\/?>|<\/div>|<\/p>)\s*On\s.+?\swrote:\s*(<br\s*\/?>|\n|$)/i.exec(
    html,
  );
  if (wroteMatch) {
    // Cut at the "On" itself, not the preceding tag
    const onIndex = html.toLowerCase().indexOf("on", wroteMatch.index);
    const result = returnIfHasContent(html, onIndex);
    if (result) return result;
  }

  // Fallback: Outlook header block — "From: ..." at a line/block boundary
  // followed within ~600 chars by at least two of (Sent|Date|To|Subject).
  const outlookCut = findOutlookHeaderBlockHtml(html);
  if (outlookCut !== null) {
    const result = returnIfHasContent(html, outlookCut);
    if (result) return result;
  }

  return html;
}

/**
 * Search HTML for a `From:` field at a line/block boundary, and return its
 * index if it's followed within a short window by at least two more
 * Outlook-style header fields. Returns `null` if no header block is found.
 */
function findOutlookHeaderBlockHtml(html: string): number | null {
  const fromPattern = /(?:^|<br\s*\/?>|<\/div>|<\/p>|<p[^>]*>|<div[^>]*>|\n)\s*From:\s/gi;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(html))) {
    const startIdx = html.toLowerCase().indexOf("from:", match.index);
    if (startIdx < 0) continue;
    // Strip tags from a 600-char window so we can check field names against
    // the rendered text rather than markup.
    const windowText = html.substring(startIdx, startIdx + 600).replace(/<[^>]*>/g, " ");
    let count = 0;
    if (/\bSent:\s*\S/i.test(windowText)) count++;
    if (/\bDate:\s*\S/i.test(windowText)) count++;
    if (/\bTo:\s*\S/i.test(windowText)) count++;
    if (/\bSubject:\s*\S/i.test(windowText)) count++;
    if (count >= 2) return startIdx;
  }
  return null;
}

/** Truncate html at `index` and return it only if visible text remains. */
function returnIfHasContent(html: string, index: number): string | null {
  const trimmed = html.substring(0, index).trim();
  // Check that stripping didn't remove all visible text
  const visibleText = trimmed
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
  return visibleText ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Plain-text quote stripping
// ---------------------------------------------------------------------------

function stripPlainTextQuoted(text: string): string {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // "On ... wrote:" attribution line (may span two lines when Gmail/Outlook
    // wraps long names or dates)
    if (/^On\s/.test(line)) {
      const singleLine = /^On\s.+?\swrote:\s*$/.test(line);
      const nextLine = lines[i + 1]?.trim() ?? "";
      const twoLine = !singleLine && /\swrote:\s*$/.test(nextLine);
      if (singleLine || twoLine) {
        const above = lines.slice(0, i).join("\n").trimEnd();
        if (above) return above;
      }
    }

    // Forwarded message marker
    if (/^-{3,}\s*Forwarded message\s*-{3,}$/.test(line)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return above;
    }

    // Outlook "Original Message" separator
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(line)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return above;
    }

    // Apple Mail / iOS forwards: "Begin forwarded message:"
    if (/^Begin forwarded message:/i.test(line)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return above;
    }

    // Outlook header block: "From:" line followed by at least two of
    // Sent:/Date:/To:/Cc:/Subject: in the immediately following lines.
    if (/^From:\s*\S/.test(line) && hasOutlookHeaderFollowing(lines, i)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return above;
    }

    // Block of ">" quoted lines — only strip if there's non-quoted content above
    if (line.startsWith(">")) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above && !above.split("\n").every((l) => l.trim().startsWith(">"))) {
        return above;
      }
    }
  }

  return text;
}

function hasOutlookHeaderFollowing(lines: string[], startIdx: number): boolean {
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
