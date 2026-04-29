/**
 * Unit tests for splitQuotedContent() from src/renderer/services/quote-elision.ts.
 *
 * The renderer detector uses DOMParser, which Node lacks by default. The
 * `dom-setup` import is a side-effect module that registers happy-dom's
 * globals — it must come BEFORE the quote-elision import so DOMParser is
 * available when the module is evaluated.
 */
import "./helpers/dom-setup";
import { test, expect } from "@playwright/test";
import { splitQuotedContent, emailBodyToPlainText } from "../../src/renderer/services/quote-elision";

// ============================================================
// HTML — known wrapper selectors
// ============================================================

test.describe("html — known wrapper selectors", () => {
  test("strips Gmail .gmail_quote and following content", () => {
    const html = `<div>Thanks!</div><div class="gmail_quote">On Mon Bob wrote:<br>Original</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Thanks!");
    expect(result.newContent).not.toContain("Original");
  });

  test("strips Apple Mail blockquote[type=cite]", () => {
    const html = `<div>Quick reply.</div><blockquote type="cite">Older content here</blockquote>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Quick reply.");
    expect(result.newContent).not.toContain("Older content");
  });

  test("strips Outlook #divRplyFwdMsg block", () => {
    const html = `<div>My reply</div><div id="divRplyFwdMsg">From: someone</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("My reply");
    expect(result.newContent).not.toContain("From: someone");
  });
});

// ============================================================
// HTML — attribution patterns (Phase A)
// ============================================================

test.describe("html — On...wrote: attribution", () => {
  test("strips attribution on its own div", () => {
    const html = `<div>My reply.</div><div>On Mon, Jan 6, 2025 Bob &lt;b@example.com&gt; wrote:</div><div>Older message</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("My reply.");
    expect(result.newContent).not.toContain("Older message");
  });

  test("strips attribution split across inline tags (<b>, <span>)", () => {
    // The attribution is one logical line but Gmail wraps the date in <b>
    // and the email in <span>, splitting it across multiple text nodes.
    const html = `<div>Sounds good.</div><div>On <b>Monday, Jan 6, 2025</b> at 3:45 PM <span>Bob &lt;b@example.com&gt;</span> wrote:</div><div>The original.</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Sounds good.");
    expect(result.newContent).not.toContain("The original");
  });

  test("strips attribution wrapped onto a second line via <br>", () => {
    const html = `<div>Got it.</div><div>On Monday, January 6, 2025 at 3:45 PM<br>Bob &lt;b@example.com&gt; wrote:</div><div>Old content</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Got it.");
    expect(result.newContent).not.toContain("Old content");
  });
});

test.describe("html — forwarded / original-message markers", () => {
  test("strips ----- Forwarded message -----", () => {
    const html = `<div>FYI</div><div>---------- Forwarded message ----------</div><div>From: vendor</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("FYI");
    expect(result.newContent).not.toContain("From: vendor");
  });

  test("strips ----- Original Message -----", () => {
    const html = `<p>Reply.</p><p>-----Original Message-----</p><p>Old body</p>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Reply");
    expect(result.newContent).not.toContain("Old body");
  });
});

test.describe("html — Outlook header block", () => {
  test("detects multi-div From/Sent/To/Subject header block", () => {
    const html = `
      <div>Sure, I'll take a look.</div>
      <div>From: Bob &lt;bob@example.com&gt;</div>
      <div>Sent: Monday, January 6, 2025 3:45 PM</div>
      <div>To: Alice &lt;alice@example.com&gt;</div>
      <div>Subject: Re: Q4 planning</div>
      <div>The original message body</div>
    `;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Sure, I'll take a look");
    expect(result.newContent).not.toContain("The original message body");
  });

  test("detects single-div consolidated header block", () => {
    const html = `<div>Done.</div><div>From: Bob<br>Sent: Mon Jan 6<br>To: Alice<br>Subject: Re: Q4</div><div>Old body</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Done.");
    expect(result.newContent).not.toContain("Old body");
  });

  test("does not split when 'From:' appears mid-sentence (no following headers)", () => {
    const html = `<div>From the project lead, we got approval. Moving forward!</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(false);
  });

  test("detects header block buried inside a single <br>-separated wrapper div", () => {
    // Real failure mode: the entire email body is one <div> with line breaks
    // via <br>. The new content sits at the start, the "From: ..." Outlook
    // header block appears later in the same div. Walking only direct body
    // children misses this.
    const html = `<div>Dear Karl,<br><br>Thank you very much for sharing this wonderful news.<br><br>Best regards,<br>Siqi Sun<br><br>From: Karl Haushalter &lt;haushalter@g.hmc.edu&gt;<br>Sent: Tuesday, April 28, 2026 12:15 AM<br>To: Sun, Siqi &lt;siqis@wustl.edu&gt;<br>Cc: Carissa Saugstad<br>Subject: Re: Application<br><br>Dear Siqi,<br>I am pleased to share the news...</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Thank you very much");
    expect(result.newContent).not.toContain("Dear Siqi,");
    expect(result.newContent).not.toContain("From: Karl Haushalter");
  });

  test("detects 'On ... wrote:' attribution buried inside a <br>-separated wrapper div", () => {
    const html = `<div>My reply.<br><br>On Wed, Apr 15, 2026 at 5:22 PM Karl &lt;k@example.com&gt; wrote:<br>Older content<br>more older</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("My reply");
    expect(result.newContent).not.toContain("Older content");
  });

  test("strips trailing spacer paragraphs at nested levels after cut", () => {
    // Real bug: when the cut point is deeply nested, trailing
    // `<p>&nbsp;</p>` spacer paragraphs at intermediate levels stay behind
    // and render as a tall blank gap below the visible content. The fix
    // is to clean trailing whitespace at every ancestor level after cut.
    const html = `<html><body>
      <div class="WordSection1">
        <p class="MsoNormal">Hi all,</p>
        <p class="MsoNormal">&nbsp;</p>
        <p class="MsoNormal">Short reply here.</p>
        <p class="MsoNormal">&nbsp;</p>
        <p class="MsoNormal">&nbsp;</p>
        <p class="MsoNormal">&nbsp;</p>
        <div style="border-top:solid #E1E1E1 1.0pt">
          <p class="MsoNormal"><b>From:</b> Bob<br><b>Sent:</b> Mon<br><b>To:</b> Alice<br><b>Subject:</b> X</p>
        </div>
        <p class="MsoNormal">Old quoted body</p>
      </div>
    </body></html>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Short reply here");
    expect(result.newContent).not.toContain("From: Bob");
    // The 3 trailing `<p>&nbsp;</p>` spacers between "Short reply" and the
    // header block must NOT survive — they were the source of the tall gap.
    // Counting `<p>` occurrences is a robust check: we expect "Hi all,",
    // a spacer, and "Short reply here." — 3 paragraphs.
    const pCount = (result.newContent.match(/<p\b/gi) || []).length;
    expect(pCount).toBeLessThanOrEqual(3);
  });

  test("detects header block in Outlook desktop's WordSection1 layout", () => {
    // Real failing case: Outlook desktop wraps content in `<div class="WordSection1">`
    // and produces an `<o:p>` Office namespace tag that some HTML parsers (including
    // happy-dom and historically some browsers) split into multiple body-level
    // children, defeating the single-child unwrap heuristic. The header block lives
    // inside a bordered `<div>` whose `<p>` contains nested `<span>`s and `<b>`s with
    // `<br>` line breaks. Detection must recurse through the nested wrappers.
    const html = `<html><body>
      <div class="WordSection1">
        <p class="MsoNormal">Dear Karl,<o:p></o:p></p>
        <p class="MsoNormal">Thank you very much for sharing this wonderful news.<o:p></o:p></p>
        <p class="MsoNormal">Best regards,</p>
        <p class="MsoNormal">Siqi Sun</p>
        <div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">
          <p class="MsoNormal">
            <b><span style="font-size:11.0pt">From:</span></b>
            <span style="font-size:11.0pt">
              Karl Haushalter &lt;haushalter@g.hmc.edu&gt;
              <br>
              <b>Sent:</b> Tuesday, April 28, 2026 12:15 AM<br>
              <b>To:</b> Sun, Siqi &lt;siqis@wustl.edu&gt;<br>
              <b>Cc:</b> Carissa Saugstad &lt;csaugstad@g.hmc.edu&gt;<br>
              <b>Subject:</b> Re: Application for Future Faculty Leaders in AI<o:p></o:p>
            </span>
          </p>
        </div>
        <p class="MsoNormal">&nbsp;</p>
        <div>
          <p class="MsoNormal">Dear Siqi,</p>
          <p class="MsoNormal">I am pleased to share the news...</p>
        </div>
      </div>
    </body></html>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Thank you very much");
    expect(result.newContent).toContain("Siqi Sun");
    expect(result.newContent).not.toContain("From: Karl Haushalter");
    expect(result.newContent).not.toContain("Dear Siqi");
    expect(result.newContent).not.toContain("I am pleased to share");
  });
});

// ============================================================
// HTML — thread-overlap fallback (Phase B)
// ============================================================

test.describe("html — thread-overlap fallback", () => {
  const priorBody =
    "Hi team, please review the attached Q4 planning document by end of week. " +
    "Key items to discuss: budget allocation, headcount changes, and project timeline.";

  test("strips a block whose text appears verbatim in an earlier message", () => {
    const html = `<div>Will review tomorrow morning.</div><div>${priorBody}</div>`;
    const result = splitQuotedContent(html, [priorBody]);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toContain("Will review tomorrow");
    expect(result.newContent).not.toContain("Key items to discuss");
  });

  test("ignores too-short blocks", () => {
    // Short repeated phrase should not trigger overlap.
    const html = `<div>Will review.</div><div>Thanks!</div>`;
    const result = splitQuotedContent(html, ["Earlier message that includes Thanks! at the end"]);
    expect(result.hasQuotedContent).toBe(false);
  });

  test("no-op when no prior messages provided", () => {
    const html = `<div>Reply</div><div>${priorBody}</div>`;
    const result = splitQuotedContent(html);
    // No pattern markers, no priors — full body returned.
    expect(result.hasQuotedContent).toBe(false);
  });

  test("ignores priors that are themselves shorter than the threshold", () => {
    const html = `<div>Reply</div><div>Hi</div>`;
    const result = splitQuotedContent(html, ["Hi"]);
    expect(result.hasQuotedContent).toBe(false);
  });
});

// ============================================================
// HTML — guards
// ============================================================

test.describe("html — guards", () => {
  test("returns full body when stripping would leave nothing", () => {
    // A bare attribution-only body shouldn't produce empty newContent.
    const html = `<div>On Mon Bob wrote:</div><div>Older</div>`;
    const result = splitQuotedContent(html);
    // Either it doesn't split (no content above), or it falls back to full body.
    if (result.hasQuotedContent) {
      expect(result.newContent.length).toBeGreaterThan(0);
    } else {
      expect(result.newContent).toBe(html);
    }
  });

  test("returns full body when no markers and no prior matches", () => {
    const html = `<div>Just a normal email.</div><div>Nothing to see here.</div>`;
    const result = splitQuotedContent(html);
    expect(result.hasQuotedContent).toBe(false);
    expect(result.newContent).toBe(html);
  });
});

// ============================================================
// Plain text — existing behavior
// ============================================================

test.describe("plain text — On...wrote:", () => {
  test("splits at attribution line", () => {
    const input = `Thanks, I'll take a look.

On Mon, Jan 6, 2025 at 3:45 PM Bob <bob@example.com> wrote:
> Can you review the proposal?`;
    const result = splitQuotedContent(input);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toBe("Thanks, I'll take a look.");
  });

  test("splits at wrapped two-line attribution", () => {
    const input = `Sounds good.

On Monday, January 6, 2025 at 3:45 PM,
Bob <bob@example.com> wrote:
> What do you think?`;
    const result = splitQuotedContent(input);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toBe("Sounds good.");
  });
});

test.describe("plain text — markers", () => {
  test("splits at forwarded message marker", () => {
    const input = `FYI.

---------- Forwarded message ----------
From: vendor`;
    const result = splitQuotedContent(input);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toBe("FYI.");
  });

  test("splits at -----Original Message-----", () => {
    const input = `Reply here.

-----Original Message-----
From: someone`;
    const result = splitQuotedContent(input);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toBe("Reply here.");
  });
});

test.describe("plain text — Outlook header block", () => {
  test("splits at From:/Sent:/To:/Subject: block", () => {
    const input = `Sure, I'll take a look.

From: Bob <bob@example.com>
Sent: Monday, January 6, 2025 3:45 PM
To: Alice <alice@example.com>
Subject: Re: Q4 planning

Original message body here.`;
    const result = splitQuotedContent(input);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toBe("Sure, I'll take a look.");
  });

  test("does not split on lone From: line", () => {
    const input = `From the project team, we are done.`;
    const result = splitQuotedContent(input);
    expect(result.hasQuotedContent).toBe(false);
  });
});

test.describe("plain text — thread overlap", () => {
  test("splits at a block contained in a prior message", () => {
    const prior =
      "Please send me the latest revenue projections for Q4. Specifically I need the breakdown by region and product line.";
    const input = `Working on it now, will send by EOD.

${prior}`;
    const result = splitQuotedContent(input, [prior]);
    expect(result.hasQuotedContent).toBe(true);
    expect(result.newContent).toBe("Working on it now, will send by EOD.");
  });
});

// ============================================================
// emailBodyToPlainText
// ============================================================

test.describe("emailBodyToPlainText", () => {
  test("extracts text content from HTML", () => {
    const html = `<div>Hello <b>world</b>.</div><div>Second paragraph.</div>`;
    expect(emailBodyToPlainText(html)).toContain("Hello world");
    expect(emailBodyToPlainText(html)).toContain("Second paragraph");
  });

  test("returns plain text unchanged", () => {
    expect(emailBodyToPlainText("Just text here.")).toBe("Just text here.");
  });

  test("returns empty string for empty input", () => {
    expect(emailBodyToPlainText("")).toBe("");
  });
});
