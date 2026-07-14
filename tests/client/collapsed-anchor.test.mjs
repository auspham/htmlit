/**
 * Browser regression test for comment cards whose anchor sits inside a collapsed
 * section (a CSS radio "option"): the card must stay in the rail instead of
 * vanishing, "View in document" must reveal the option and scroll to it, and the
 * agent's answer must render its markup without promoting an artifact .card into
 * a separate fixed rail card.
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "collapsed-option.html");
const state = { browser: null, unavailable: null };

const SEED = {
  highlights: [{
    id: "cm-b",
    kind: "comment",
    prompt: "Elaborate?",
    comments: ["Elaborate?"],
    text: "Take a maintenance window",
    range: { container: "#b-para", start: 0, end: 25, text: "Take a maintenance window" },
  }],
};

// Query the rail (shadow DOM) and the artifact (light DOM) state in one pass.
function readState() {
  const sr = document.getElementById("htmlit-chrome").shadowRoot;
  const card = sr.querySelector('.rail .card[data-id="cm-b"]');
  const body = card && card.querySelector(".card-answer-body");
  const answerCard = body && body.querySelector(".card");
  const answer = document.querySelector('[data-htmlit-answer-for="cm-b"]');
  return {
    cardExists: Boolean(card),
    cardVisible: Boolean(card) && getComputedStyle(card).display !== "none",
    cardPosition: card ? getComputedStyle(card).position : null,
    answerRich: Boolean(body) && body.classList.contains("rich"),
    answerCardPosition: answerCard ? getComputedStyle(answerCard).position : null,
    listItems: body ? body.querySelectorAll("ol li").length : 0,
    answerShown: Boolean(answer) && answer.getClientRects().length > 0,
    bChecked: document.getElementById("s-b").checked,
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

test("a comment in a collapsed option stays carded, reveals on jump, and renders its list", async (t) => {
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
    await page.waitForFunction(
      () => { const c = document.getElementById("htmlit-chrome"); return c && c.shadowRoot && c.shadowRoot.querySelector('.rail .card[data-id="cm-b"]'); },
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 400));

    const before = await page.evaluate(readState);
    assert.equal(before.cardExists, true);
    assert.equal(before.cardVisible, true, "card should stay visible while Option B is collapsed");
    assert.equal(before.cardPosition, "fixed", "the rail comment card should stay fixed");
    assert.equal(before.bChecked, false);
    assert.equal(before.answerShown, false, "the answer/anchor is collapsed to start");
    assert.equal(before.answerRich, true);
    assert.equal(before.answerCardPosition, "static", "artifact .card content should remain inside the agent answer");
    assert.equal(before.listItems, 3, "the answer's numbered list should render, not flatten to text");

    await page.evaluate(() => document.getElementById("htmlit-chrome").shadowRoot.querySelector('.rail .card[data-id="cm-b"] .card-answer-jump').click());
    await new Promise((r) => setTimeout(r, 500));

    const after = await page.evaluate(readState);
    assert.equal(after.bChecked, true, "View in document should open Option B");
    assert.equal(after.answerShown, true, "and reveal the anchored content");
    assert.equal(after.cardVisible, true);
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});
