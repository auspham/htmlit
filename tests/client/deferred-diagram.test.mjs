/**
 * Browser regression test: a Mermaid diagram inside a hidden tab must not render
 * collapsed. Mermaid sizes a diagram from its laid-out text, so a display:none
 * pane yields nothing; the client defers the hidden diagram and renders it the
 * moment the tab is revealed.
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "hidden-diagram.html");
const state = { browser: null, review: null, page: null, unavailable: null };

// Measure the diagram inside a pane: whether it rendered (data-processed + an svg
// with real width), reading getBBox only when it is visible.
function measure(paneSel) {
  const m = document.querySelector(paneSel + " .mermaid");
  const svg = m ? m.querySelector("svg") : null;
  let width = 0;
  try { width = svg ? Math.round(svg.getBBox().width) : 0; } catch (e) { width = 0; }
  return { hasMermaid: Boolean(m), processed: Boolean(m) && m.hasAttribute("data-processed"), width };
}

before(async () => {
  try {
    const { default: puppeteer } = await import("puppeteer");
    state.browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  } catch (err) {
    state.unavailable = `no browser available: ${err.message}`;
    return;
  }
  try {
    state.review = await startReview(FIXTURE);
  } catch (err) {
    state.unavailable = `daemon did not start: ${err.message}`;
    return;
  }
  state.page = await state.browser.newPage();
  await state.page.setViewport({ width: 1000, height: 900 });
  await state.page.goto(state.review.url, { waitUntil: "domcontentloaded" });
  await state.page.waitForSelector(".pane-a .mermaid svg", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 500));
});

after(async () => {
  if (state.page) await state.page.close();
  if (state.browser) await state.browser.close();
  if (state.review) await state.review.stop();
});

test("a diagram in a hidden tab renders on reveal, not collapsed at load", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);

  const a = await state.page.evaluate(measure, ".pane-a");
  const b = await state.page.evaluate(measure, ".pane-b");
  // The visible tab renders immediately at real size.
  assert.equal(a.processed, true);
  assert.ok(a.width > 100, `visible diagram should have real width, got ${a.width}`);
  // The hidden tab's diagram is deferred - present but not yet rendered.
  assert.equal(b.hasMermaid, true);
  assert.equal(b.processed, false, "hidden diagram should be deferred, not rendered while collapsed");

  // Reveal tab B; the ResizeObserver should render it once it gains size.
  await state.page.evaluate(() => document.getElementById("t-b").click());
  await new Promise((r) => setTimeout(r, 700));

  const revealed = await state.page.evaluate(measure, ".pane-b");
  assert.equal(revealed.processed, true, "hidden diagram should render once its tab is revealed");
  assert.ok(revealed.width > 100, `revealed diagram should have real width, got ${revealed.width}`);
});
