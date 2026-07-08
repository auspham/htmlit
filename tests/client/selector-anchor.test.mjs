/**
 * Browser regression test for annotation-selector anchoring.
 *
 * When a selection's anchor element had no id, the client built an *unrooted* CSS
 * path for it ("div:nth-of-type(1) > ul > li:nth-of-type(2) > strong"). If an
 * earlier subtree in the document shared that same tag/nth-of-type skeleton
 * (e.g. a <strong> nested in a card grid), document.querySelector re-resolved the
 * path to that decoy instead. resolveRange's text guard then failed, pendingRects
 * came back empty, and openSelMenu -> clearPending closed the menu and wiped the
 * selection - so the line could not be highlighted or commented on at all.
 *
 * The fixture reproduces exactly that collision. Selecting the target <strong>
 * must open the annotation menu (rooting the path at <body> makes it resolve to
 * the correct element).
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "selector-collision.html");
const state = { browser: null, unavailable: null };

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

// Select the whole text of the first element matching `needle`, then fire the
// mouseup the client listens for, and report the annotation menu's display.
async function selectAndMenu(page, needle) {
  return page.evaluate(async (needle) => {
    function findText(n) {
      const w = document.createTreeWalker(document.querySelector(".layout") || document.body, NodeFilter.SHOW_TEXT);
      let x;
      while ((x = w.nextNode())) if ((x.nodeValue || "").toLowerCase().includes(n)) return x;
      return null;
    }
    const node = findText(needle.toLowerCase());
    if (!node) return { found: false };
    const host = node.parentElement;
    host.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 100));

    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.nodeValue.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 200)); // the client finalizes the selection in a setTimeout(0)

    const menu = document.getElementById("htmlit-chrome").shadowRoot.querySelector(".selmenu");
    return { found: true, selection: sel.toString(), menu: getComputedStyle(menu).display };
  }, needle);
}

test("selecting a nested inline element opens the annotation menu despite a decoy subtree", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(FIXTURE);
    page = await state.browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => { const c = document.getElementById("htmlit-chrome"); return c && c.shadowRoot && c.shadowRoot.querySelector(".selmenu"); },
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 300));

    const target = await selectAndMenu(page, "leaked testbed lock");
    assert.ok(target.found, "target line should exist in the fixture");
    // Under the bug the unrooted path resolved to the decoy <strong> ("polls the
    // queue"), the text guard failed, and the menu was force-closed (display:none).
    assert.equal(target.menu, "flex", `annotation menu should open for the target line (got display:${target.menu})`);
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});
