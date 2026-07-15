/**
 * Browser regression test for comments on Mermaid sequence diagrams.
 *
 * Sequence actors, messages, and notes do not use the flowchart g.node /
 * g.edgePaths structure, and most of their SVG elements have no id. A click
 * therefore used to fall through as a background pan, leaving no annotation
 * menu or stable target for the comment anchor.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "sequence.html");

async function clickSequenceText(page, selector, text) {
  const point = await page.evaluate(
    ({ selector, text }) => {
      const target = [...document.querySelectorAll(`.mermaid ${selector}`)]
        .find((el) => (el.textContent || "").includes(text));
      if (!target) return null;
      target.scrollIntoView({ block: "center" });
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { selector, text },
  );
  assert.ok(point, `expected ${selector} containing ${text}`);
  await page.mouse.click(point.x, point.y);
}

async function menuDisplay(page) {
  return page.evaluate(() => {
    const chrome = document.getElementById("htmlit-chrome");
    const menu = chrome.shadowRoot.querySelector(".selmenu");
    return getComputedStyle(menu).display;
  });
}

test("sequence diagram elements can be commented and re-resolve after reload", async (t) => {
  let browser;
  try {
    const { default: puppeteer } = await import("puppeteer");
    browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  } catch (err) {
    return t.skip(`no browser available: ${err.message}`);
  }

  let review;
  let page;
  try {
    review = await startReview(FIXTURE);
    page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const svg = document.querySelector(".mermaid svg");
        return svg && svg.__htmlitDrag && svg.querySelector(".messageText");
      },
      { timeout: 20000 },
    );

    for (const [selector, text] of [
      ["text.actor.actor-box", "Caller"],
      ["text.noteText", "first attempt can race"],
    ]) {
      await clickSequenceText(page, selector, text);
      assert.equal(await menuDisplay(page), "flex", `clicking ${text} should open the annotation menu`);
      await page.keyboard.press("Escape");
    }

    await clickSequenceText(page, ".messageText", "Resolve request");
    assert.equal(await menuDisplay(page), "flex", "clicking a sequence message should open the annotation menu");

    const highlightSaved = page.waitForResponse(
      (response) => response.url().endsWith(`/api/${review.key}/highlights`) && response.request().method() === "POST",
    );
    const targetKey = await page.evaluate(() => {
      const root = document.getElementById("htmlit-chrome").shadowRoot;
      root.querySelector('[data-act="hlcomment"]').click();
      const input = root.querySelector(".pop .ce");
      input.textContent = "Why can this race?";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Why can this race?" }));
      root.querySelector('[data-act="popadd"]').click();
      const message = [...document.querySelectorAll(".mermaid .messageText")]
        .find((el) => (el.textContent || "").includes("Resolve request"));
      return message && message.getAttribute("data-htmlit-diagram-key");
    });
    await highlightSaved;

    assert.match(targetKey || "", /^sequence-message-\d+$/, "the sequence message should receive a stable target key");

    await page.evaluate(() => {
      document.getElementById("htmlit-chrome").shadowRoot.querySelector('[data-act="send"]').click();
    });
    const feedback = await fetch(`${review.base}/api/poll?key=${review.key}&timeout=3`).then((response) => response.json());
    const prompt = (feedback.prompts || []).find((item) => item.prompt === "Why can this race?");
    assert.ok(prompt, "the sequence comment should be delivered to the agent");
    assert.equal(prompt.tag, "text");
    assert.ok(prompt.commentId, "the sequence comment should carry an anchor id");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (key) => {
        const message = [...document.querySelectorAll(".mermaid .messageText")]
          .find((el) => (el.textContent || "").includes("Resolve request"));
        const chrome = document.getElementById("htmlit-chrome");
        return message &&
          message.getAttribute("data-htmlit-diagram-key") === key &&
          chrome &&
          chrome.shadowRoot.querySelectorAll(".hls .cmbox").length === 1;
      },
      { timeout: 20000 },
      targetKey,
    );
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
    await browser.close();
  }
});
