/**
 * Browser regression test for the answer -> anchor jump: clicking an agent answer
 * block's "You asked:" header scrolls back to (and flashes) the spot the user asked
 * about. The reverse jump (anchor -> answer) already existed; this pins the missing
 * direction so the two are symmetric.
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "answer-anchor.html");
const state = { browser: null, unavailable: null };

const SEED = {
  highlights: [{
    id: "cm-x",
    kind: "comment",
    prompt: "Elaborate?",
    comments: ["Elaborate?"],
    text: "Take a maintenance window",
    range: { container: "#ask-para", start: 0, end: 25, text: "Take a maintenance window" },
  }],
};

const ANCHOR = 'mark.htmlit-cm[data-htmlit-cm="cm-x"]';

function anchorState() {
  const mark = document.querySelector('mark.htmlit-cm[data-htmlit-cm="cm-x"]');
  if (!mark) return { exists: false };
  const r = mark.getBoundingClientRect();
  return {
    exists: true,
    flashed: mark.classList.contains("htmlit-new"),
    inView: r.top >= 0 && r.top <= window.innerHeight,
  };
}

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

test("clicking an answer's 'You asked' header jumps back to the anchor", async (t) => {
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
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((sel) => document.querySelector(sel), { timeout: 20000 }, ANCHOR);

    // Scroll the answer (far below) into view, so the anchor near the top is off-screen.
    const header = await page.evaluate(() => {
      const block = document.querySelector('[data-htmlit-answer-for="cm-x"]');
      block.scrollIntoView({ block: "center" });
      const r = block.getBoundingClientRect();
      return { x: r.left + 24, y: r.top + 8 }; // the "You asked:" header / top padding
    });

    const before = await page.evaluate(anchorState);
    assert.equal(before.exists, true, "the comment anchor mark should be present");
    assert.equal(before.flashed, false);
    assert.equal(before.inView, false, "anchor is scrolled out of view before the jump");

    await page.mouse.click(header.x, header.y);
    await new Promise((r) => setTimeout(r, 500));

    const after = await page.evaluate(anchorState);
    assert.equal(after.flashed, true, "clicking the answer header should flash the anchor");
    assert.equal(after.inView, true, "and scroll it back into view");
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});
