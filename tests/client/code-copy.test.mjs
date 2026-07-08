/**
 * Browser test for code-block chrome: a plain code block is borderless and carries a
 * Copy button, a diff stays framed with NO copy button, and the Mermaid "Code" toggle
 * reveals the source as a real code block (line numbers) with its own Copy button.
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "code-blocks.html");
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

test("code blocks are borderless with a Copy button; diffs stay framed without one", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(FIXTURE);
    page = await state.browser.newPage();
    await page.setViewport({ width: 1000, height: 900 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".htmlit-code:not(.htmlit-diff)") && document.querySelector(".mermaid svg"), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 400));

    const info = await page.evaluate(() => {
      const code = document.querySelector(".htmlit-code:not(.htmlit-diff)");
      const diff = document.querySelector(".htmlit-diff");
      return {
        codeBorder: getComputedStyle(code).borderTopWidth,
        codeHasCopy: !!code.querySelector(".htmlit-copy"),
        codeHasLinenos: !!code.querySelector(".htmlit-linenos"),
        diffBorder: getComputedStyle(diff).borderTopWidth,
        diffHasCopy: !!diff.querySelector(".htmlit-copy"),
      };
    });
    assert.equal(info.codeBorder, "0px", "a plain code block should have no border");
    assert.ok(info.codeHasCopy, "a code block should have a Copy button");
    assert.ok(info.codeHasLinenos, "a code block should keep its line numbers");
    assert.notEqual(info.diffBorder, "0px", "a diff should keep its frame");
    assert.ok(!info.diffHasCopy, "a diff should not have a Copy button");
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});

test("the Mermaid Code toggle shows the source with line numbers and a Copy button", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(FIXTURE);
    page = await state.browser.newPage();
    await page.setViewport({ width: 1000, height: 900 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".mermaid [data-htmlit-codebtn]"), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 400));

    const before = await page.evaluate(() => {
      const copy = document.querySelector(".mermaid [data-htmlit-codecopy]");
      return { copyVisible: copy ? getComputedStyle(copy).display !== "none" : false };
    });
    assert.equal(before.copyVisible, false, "the source Copy button is hidden until Code is shown");

    await page.evaluate(() => document.querySelector(".mermaid [data-htmlit-codebtn]").click());
    await new Promise((r) => setTimeout(r, 200));

    const after = await page.evaluate(() => {
      const copy = document.querySelector(".mermaid [data-htmlit-codecopy]");
      const ok = copy && getComputedStyle(copy).display !== "none";
      copy.click();
      return {
        hasLinenos: !!document.querySelector(".mermaid [data-htmlit-code] .htmlit-linenos"),
        highlighted: !!document.querySelector(".mermaid [data-htmlit-code] code.hljs span[class^='hljs-']"),
        copyVisible: ok,
        copyLabel: copy.textContent,
      };
    });
    assert.ok(after.hasLinenos, "the Mermaid source should render with line numbers");
    assert.ok(after.highlighted, "the Mermaid source should be syntax-highlighted");
    assert.ok(after.copyVisible, "the source Copy button should appear with the code view");
    assert.equal(after.copyLabel, "Copied", "clicking Copy should give feedback");
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});
