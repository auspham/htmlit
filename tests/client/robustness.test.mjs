/**
 * Browser regression tests for the artifact-robustness safeguards: a bare artifact
 * (no CSS) gets readable base typography and an invalid Mermaid diagram degrades to
 * its source instead of Mermaid's error graphic, while an artifact that styles
 * itself is never overridden (the base stylesheet carries zero specificity).
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BARE = join(HERE, "fixtures", "bare-diagram.html");
const STYLED = join(HERE, "fixtures", "styled-artifact.html");
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

async function open(fixture, ready) {
  const review = await startReview(fixture);
  const page = await state.browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(review.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ready, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  return { review, page, errors };
}

async function pollWarningKinds(review) {
  const res = await fetch(`${review.base}/api/poll?key=${review.key}&timeout=3`);
  const body = await res.json();
  return (body.layout_warnings || []).map((w) => w.kind);
}

test("bare artifact gets base typography and a bad diagram degrades to source", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let ctx;
  try {
    ctx = await open(BARE, ".htmlit-diagram-error, .mermaid[data-processed]");
    const result = await ctx.page.evaluate(() => ({
      baseFirst: document.head.firstElementChild && document.head.firstElementChild.id,
      bodyFont: getComputedStyle(document.body).fontFamily,
      fallbacks: document.querySelectorAll(".htmlit-diagram-error").length,
      fallbackShowsSource: /flowchart TB/.test(document.querySelector(".htmlit-diagram-error") ? document.querySelector(".htmlit-diagram-error").textContent : ""),
      renderedDiagrams: document.querySelectorAll(".mermaid svg").length,
      bomb: document.body.innerText.includes("Syntax error"),
    }));
    assert.equal(result.baseFirst, "htmlit-base-css");
    assert.match(result.bodyFont, /^ui-sans-serif/);
    assert.equal(result.fallbacks, 1);
    assert.equal(result.fallbackShowsSource, true);
    assert.equal(result.renderedDiagrams, 1);
    assert.equal(result.bomb, false);
    assert.deepEqual(ctx.errors, [], `unexpected browser errors:\n${ctx.errors.join("\n")}`);
  } finally {
    if (ctx) { await ctx.page.close(); await ctx.review.stop(); }
  }
});

test("a rendered diagram exposes a Code toggle for its source", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let ctx;
  try {
    ctx = await open(BARE, ".mermaid svg");
    const result = await ctx.page.evaluate(() => {
      const box = [...document.querySelectorAll(".mermaid")].find((b) => b.querySelector("svg"));
      const btn = box && box.querySelector("[data-htmlit-codebtn]");
      const before = { hasBtn: Boolean(btn), label: btn && btn.textContent };
      if (btn) btn.click();
      const view = box && box.querySelector("[data-htmlit-code]");
      const shown = {
        codeShown: Boolean(view) && getComputedStyle(view).display !== "none",
        svgHidden: getComputedStyle(box.querySelector("svg")).display === "none",
        labelAfter: btn && btn.textContent,
        showsSource: Boolean(view) && /flowchart/.test(view.textContent),
      };
      if (btn) btn.click();
      const bar = box.querySelector("[data-htmlit-tools]");
      const restored = {
        barDisplay: bar ? getComputedStyle(bar).display : "none",
        svgVisibleAgain: getComputedStyle(box.querySelector("svg")).display !== "none",
        codeHiddenAgain: Boolean(view) && getComputedStyle(view).display === "none",
        labelBack: btn && btn.textContent,
      };
      return { ...before, ...shown, ...restored };
    });
    assert.equal(result.hasBtn, true);
    assert.equal(result.label, "Code");
    assert.equal(result.codeShown, true);
    assert.equal(result.svgHidden, true);
    assert.equal(result.labelAfter, "Diagram");
    assert.equal(result.showsSource, true);
    assert.match(result.barDisplay, /flex/);
    assert.equal(result.svgVisibleAgain, true);
    assert.equal(result.codeHiddenAgain, true);
    assert.equal(result.labelBack, "Code");
  } finally {
    if (ctx) { await ctx.page.close(); await ctx.review.stop(); }
  }
});

test("a self-styled artifact is never overridden by the base stylesheet", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let ctx;
  try {
    ctx = await open(STYLED, "#htmlit-chrome");
    const result = await ctx.page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const pre = getComputedStyle(document.querySelector("pre"));
      return { bodyFont: body.fontFamily, bodyBg: body.backgroundColor, preBg: pre.backgroundColor, preBorder: pre.borderTopStyle };
    });
    assert.match(result.bodyFont, /Georgia/);
    assert.equal(result.bodyBg, "rgb(255, 251, 230)");
    assert.equal(result.preBg, "rgb(32, 32, 32)");
    assert.equal(result.preBorder, "dashed");
  } finally {
    if (ctx) { await ctx.page.close(); await ctx.review.stop(); }
  }
});

test("serve-time warnings flag a broken diagram and a missing stylesheet", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let ctx;
  try {
    ctx = await open(BARE, ".htmlit-diagram-error");
    const kinds = await pollWarningKinds(ctx.review);
    assert.ok(kinds.includes("mermaid-syntax"), `expected mermaid-syntax warning, got ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("no-artifact-css"), `expected no-artifact-css warning, got ${JSON.stringify(kinds)}`);
  } finally {
    if (ctx) { await ctx.page.close(); await ctx.review.stop(); }
  }
});

test("a styled artifact raises no missing-stylesheet warning", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let ctx;
  try {
    ctx = await open(STYLED, "#htmlit-chrome");
    const kinds = await pollWarningKinds(ctx.review);
    assert.ok(!kinds.includes("no-artifact-css"), `unexpected no-artifact-css warning, got ${JSON.stringify(kinds)}`);
  } finally {
    if (ctx) { await ctx.page.close(); await ctx.review.stop(); }
  }
});
