import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "state-lifecycle.html");

const state = { browser: null, page: null, review: null, unavailable: null, errors: [] };

before(async () => {
  try {
    const { default: puppeteer } = await import("puppeteer");
    state.browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    state.review = await startReview(FIXTURE);
  } catch (err) {
    state.unavailable = `browser test unavailable: ${err.message}`;
    return;
  }
  state.page = await state.browser.newPage();
  state.page.on("pageerror", (error) => state.errors.push(String(error)));
  state.page.on("console", (message) => message.type() === "error" && state.errors.push(message.text()));
  await state.page.setViewport({ width: 1400, height: 1200 });
  await state.page.goto(state.review.url, { waitUntil: "domcontentloaded" });
  await state.page.waitForFunction(
    () => document.querySelector(".mermaid svg")?.__htmlitDrag,
    { timeout: 20000 },
  );
});

after(async () => {
  if (state.page) await state.page.close();
  if (state.browser) await state.browser.close();
  if (state.review) await state.review.stop();
});

function diagramState() {
  return state.page.evaluate(() => {
    const svg = document.querySelector(".mermaid svg");
    const path = (id) => svg.querySelector(`g.edgePaths > path[id$="-${id}"]`)?.getAttribute("d");
    const label = (id) => svg.querySelector(`g.edgeLabels [data-id="${id}"]`)?.parentElement?.getAttribute("transform");
    return {
      finishedPath: path("edge5"),
      failedPath: path("edge3"),
      finishedLabel: label("edge5"),
      failedLabel: label("edge3"),
    };
  });
}

async function dragFinished(dx, dy) {
  const target = await state.page.evaluate(() => {
    const node = [...document.querySelectorAll(".mermaid svg g.node")]
      .find((element) => (element.textContent || "").trim() === "FINISHED");
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await state.page.mouse.move(target.x, target.y);
  await state.page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await state.page.mouse.move(target.x + (dx * step) / 12, target.y + (dy * step) / 12);
  }
  await state.page.mouse.up();
}

describe("Mermaid state lifecycle rearrange", () => {
  test("a transition label follows its own edge when the target state moves", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);

    const beforeState = await diagramState();
    await dragFinished(-80, 70);
    const afterState = await diagramState();

    assert.notEqual(afterState.finishedPath, beforeState.finishedPath);
    assert.notEqual(afterState.finishedLabel, beforeState.finishedLabel);
    assert.equal(afterState.failedPath, beforeState.failedPath);
    assert.equal(afterState.failedLabel, beforeState.failedLabel);
  });

  test("no browser errors occurred", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);
    assert.deepEqual(state.errors, []);
  });
});
