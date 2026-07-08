/**
 * Browser regression test for comment-card placement. A comment anchored inside a
 * narrow container (a table cell / <code> span) used to drag its rail card into the
 * middle of the page, because the card hugged the immediate container's right edge.
 * The card must sit at the right of the content column instead - on the side.
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "rail-narrow-anchor.html");
const STACKED = join(HERE, "fixtures", "rail-stacked.html");
const LONGQUOTE = join(HERE, "fixtures", "rail-longquote.html");
const state = { browser: null, unavailable: null };

const SEED = {
  highlights: [{
    id: "cm1",
    kind: "comment",
    prompt: "explain SISMEMBER",
    comments: ["explain SISMEMBER"],
    text: "SISMEMBER",
    range: { container: "#cmd", start: 0, end: 9, text: "SISMEMBER" },
  }],
};

before(async () => {
  try {
    const { default: puppeteer } = await import("puppeteer");
    state.browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  } catch (err) {
    state.unavailable = `no browser available: ${err.message}`;
  }
});

after(async () => {
  if (state.browser) await state.browser.close();
});

test("a comment in a narrow cell places its card on the content-column side, not mid-page", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(FIXTURE);
    await fetch(`${review.base}/api/${review.key}/highlights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SEED),
    });
    page = await state.browser.newPage();
    await page.setViewport({ width: 2000, height: 1000 }); // wide, so the rail has room
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => { const c = document.getElementById("htmlit-chrome"); return c && c.shadowRoot && c.shadowRoot.querySelector(".rail .card"); },
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 500));

    const m = await page.evaluate(() => {
      const card = document.getElementById("htmlit-chrome").shadowRoot.querySelector(".rail .card");
      const cardLeft = card.getBoundingClientRect().left;
      const codeRight = document.getElementById("cmd").getBoundingClientRect().right;
      const contentRight = document.querySelector(".layout").getBoundingClientRect().right;
      return { cardLeft, codeRight, contentRight };
    });

    // The bug: the card sat at the narrow <code>'s right edge, in the middle of the
    // page. It must instead align to the content column's right edge.
    assert.ok(m.cardLeft > m.codeRight + 300, `card should not hug the narrow anchor (card ${Math.round(m.cardLeft)}, code ${Math.round(m.codeRight)})`);
    assert.ok(m.cardLeft >= m.contentRight - 20, `card should sit at the content-column right (card ${Math.round(m.cardLeft)}, column ${Math.round(m.contentRight)})`);
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});

test("stacked comment cards do not cover (and block selection of) lower content", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(STACKED);
    // Four comments high up, on narrow <code> spans - their cards stack downward.
    const seed = { highlights: [
      { id: "s1", kind: "comment", prompt: "n1", comments: ["n1"], text: "alpha", range: { container: "#c1", start: 0, end: 5, text: "alpha" } },
      { id: "s2", kind: "comment", prompt: "n2", comments: ["n2"], text: "bravo", range: { container: "#c2", start: 0, end: 5, text: "bravo" } },
      { id: "s3", kind: "comment", prompt: "n3", comments: ["n3"], text: "charlie", range: { container: "#c3", start: 0, end: 7, text: "charlie" } },
      { id: "s4", kind: "comment", prompt: "n4", comments: ["n4"], text: "delta", range: { container: "#c4", start: 0, end: 5, text: "delta" } },
    ] };
    await fetch(`${review.base}/api/${review.key}/highlights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seed),
    });
    page = await state.browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => { const c = document.getElementById("htmlit-chrome"); return c && c.shadowRoot && c.shadowRoot.querySelectorAll(".rail .card").length >= 4; },
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 600));

    // Every point along the lower target line must hit the page, not a card in the
    // chrome. Under the old mid-page placement a stacked card covered the line and
    // stole the mouse, so it could not be selected or commented on.
    const covered = await page.evaluate(() => {
      const t = document.getElementById("target").getBoundingClientRect();
      const y = t.top + t.height / 2;
      for (let x = t.left + 4; x < t.right - 4; x += 20) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest && hit.closest("#htmlit-chrome")) return { x: Math.round(x), tag: hit.tagName };
      }
      return null;
    });
    assert.equal(covered, null, `no card should cover the target line (covered at ${covered && covered.x}px)`);
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});

test("a long comment quote previews two full lines instead of a clipped one", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(LONGQUOTE);
    const quote = "At our cancel volume (rare, tiny messages) the broadcast cost is negligible, so classic first is the pragmatic call; the durable set means a missed message is never fatal anyway.";
    await fetch(`${review.base}/api/${review.key}/highlights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ highlights: [{
        id: "lq", kind: "comment", prompt: "note", comments: ["agree"], text: quote,
        range: { container: "#q", start: 0, end: quote.length, text: quote },
      }] }),
    });
    page = await state.browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => { const c = document.getElementById("htmlit-chrome"); return c && c.shadowRoot && c.shadowRoot.querySelector(".rail .card .card-q"); },
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 400));

    const m = await page.evaluate(() => {
      const q = document.getElementById("htmlit-chrome").shadowRoot.querySelector(".rail .card .card-q");
      const cs = getComputedStyle(q);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return { contentH: q.clientHeight - pad, lineHeight: parseFloat(cs.lineHeight) };
    });
    // The bug clamped the box to ~1.5 lines (a hard max-height cut the second line
    // mid-glyph). The -webkit-line-clamp:2 preview must show two whole lines.
    assert.ok(m.contentH >= 1.9 * m.lineHeight, `quote should show ~2 lines (content ${Math.round(m.contentH)}px, line ${Math.round(m.lineHeight)}px)`);
    assert.ok(m.contentH <= 2.2 * m.lineHeight, `quote should stay clamped to 2 lines (content ${Math.round(m.contentH)}px, line ${Math.round(m.lineHeight)}px)`);
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});
