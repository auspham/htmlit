/**
 * Browser regression test for the native diff renderer.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "diff.html");
const state = { browser: null, page: null, review: null, unavailable: null, errors: [] };

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
  state.page.on("pageerror", (e) => state.errors.push(String(e)));
  state.page.on("console", (m) => m.type() === "error" && state.errors.push(m.text()));
  await state.page.setViewport({ width: 560, height: 900 });
  await state.page.goto(state.review.url, { waitUntil: "domcontentloaded" });
  await state.page.waitForSelector(".htmlit-diff", { timeout: 20000 });
});

after(async () => {
  if (state.page) await state.page.close();
  if (state.browser) await state.browser.close();
  if (state.review) await state.review.stop();
});

test("diff blocks render unified and split views with aligned rows", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);

  const result = await state.page.evaluate(() => {
    const diff = document.querySelector(".htmlit-diff");
    const unified = diff.querySelector(".htmlit-diff-unified");
    const split = diff.querySelector(".htmlit-diff-split");
    const unifiedRadio = diff.querySelector(".htmlit-diff-unified-radio");
    const splitRadio = diff.querySelector(".htmlit-diff-split-radio");
    const rows = [...unified.querySelectorAll(".htmlit-diff-row:not(.htmlit-diff-hunk)")];
    const sourceLines = 10;
    const expectedRows = sourceLines - 1;
    const delIndex = rows.findIndex((row) => row.classList.contains("htmlit-diff-del"));
    const addIndex = rows.findIndex((row, index) => index > delIndex && row.classList.contains("htmlit-diff-add"));
    const delRect = rows[addIndex - 1].querySelector(".htmlit-diff-text").getBoundingClientRect();
    const addRect = rows[addIndex].querySelector(".htmlit-diff-text").getBoundingClientRect();
    const rowHeight = delRect.height;
    const aligned = rows.every((row) => {
      const text = row.querySelector(".htmlit-diff-text").getBoundingClientRect();
      const numbers = [...row.querySelectorAll(".htmlit-diff-no")];
      return numbers.some((cell) => cell.textContent.trim()) && numbers.every((cell) => Math.abs(cell.getBoundingClientRect().top - text.top) < 0.5);
    });
    const unifiedChecked = unifiedRadio.checked;
    const wrapsWithoutScroll = unified.scrollWidth <= unified.clientWidth + 1;
    splitRadio.checked = true;
    splitRadio.dispatchEvent(new Event("change", { bubbles: true }));
    const splitStyle = getComputedStyle(split).display;
    const unifiedStyle = getComputedStyle(unified).display;
    const isRed = (bg) => { const m = bg.match(/rgba?\(([^)]+)\)/); if (!m) return false; const [r, g, b] = m[1].split(",").map(Number); return r > 120 && g < 90 && b < 90; };
    const splitPairedRow = [...split.querySelectorAll(".htmlit-diff-row")].find((row) => row.classList.contains("htmlit-diff-del") && row.classList.contains("htmlit-diff-add"));
    const splitAddNotRed = !splitPairedRow || !isRed(getComputedStyle(splitPairedRow.querySelector(".htmlit-diff-new-text")).backgroundColor);
    const splitNewNo = split.querySelector(".htmlit-diff-row:not(.htmlit-diff-hunk) .htmlit-diff-new-no");
    const splitDivider = Boolean(splitNewNo) && parseFloat(getComputedStyle(splitNewNo).borderLeftWidth) >= 1;
    const splitFillerCell = split.querySelector(".htmlit-diff-filler");
    const splitFillerHatched = Boolean(splitFillerCell) && /gradient/.test(getComputedStyle(splitFillerCell).backgroundImage);
    return {
      hasDiff: Boolean(diff),
      hasViews: Boolean(unified && split && unifiedRadio && splitRadio),
      unifiedChecked,
      rowCount: rows.length,
      expectedRows,
      adjacentChangedRows: addIndex === delIndex + 2 && Math.abs(addRect.top - delRect.bottom) < 0.5 && rowHeight > 0,
      aligned,
      wrapsWithoutScroll,
      toggleUserSelect: getComputedStyle(diff.querySelector(".htmlit-diff-toggle")).userSelect,
      splitVisible: splitStyle !== "none",
      unifiedHidden: unifiedStyle === "none",
      splitAddNotRed,
      splitDivider,
      splitFillerHatched,
      splitColumns: getComputedStyle(split.querySelector(".htmlit-diff-row:not(.htmlit-diff-hunk)")).gridTemplateColumns.split(" ").length,
    };
  });

  assert.equal(result.hasDiff, true);
  assert.equal(result.hasViews, true);
  assert.equal(result.unifiedChecked, true);
  assert.equal(result.rowCount, result.expectedRows);
  assert.equal(result.adjacentChangedRows, true);
  assert.equal(result.aligned, true);
  assert.equal(result.wrapsWithoutScroll, true);
  assert.equal(result.toggleUserSelect, "none");
  assert.equal(result.splitVisible, true);
  assert.equal(result.splitAddNotRed, true);
  assert.equal(result.splitDivider, true);
  assert.equal(result.splitFillerHatched, true);
  assert.equal(result.unifiedHidden, true);
  assert.equal(result.splitColumns, 4);
  assert.deepEqual(state.errors, [], `unexpected browser errors:\n${state.errors.join("\n")}`);
});
