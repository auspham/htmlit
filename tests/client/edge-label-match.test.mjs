/**
 * Browser regression test for edge-label to edge matching in a dense diagram.
 *
 * A hub inside a subgraph fans many labelled edges out in different directions. The
 * old matcher compared label and path positions in mismatched coordinate frames and
 * assigned greedily in DOM order, so a label could bind to the wrong edge - and then
 * dragging an unrelated node flung that label across the diagram (the "PBI discussion
 * lands on Blob storage" report). Each label must stay bound to its own edge, so
 * dragging a target moves only the labels of edges actually connected to it.
 *
 * Skips rather than fails when no browser or Python is available.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "dense-labels.html");
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

function labelCenters(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".mermaid svg g.edgeLabels g.edgeLabel")]
        .filter((g) => (g.textContent || "").trim())
        .map((g) => {
          const r = g.getBoundingClientRect();
          return [(g.textContent || "").trim(), { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }];
        }),
    ),
  );
}

async function dragNodeContaining(page, text, dx, dy) {
  const t = await page.evaluate((needle) => {
    const svg = document.querySelector(".mermaid svg");
    const node = [...svg.querySelectorAll("g.node")].find((n) => (n.textContent || "").includes(needle));
    node.scrollIntoView({ block: "center" });
    const r = node.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, text);
  await page.mouse.move(t.cx, t.cy);
  await page.mouse.down();
  for (let s = 1; s <= 14; s++) await page.mouse.move(t.cx + (dx * s) / 14, t.cy + (dy * s) / 14);
  await page.mouse.up();
}

// Each label's distance (px) to the nearest point on any edge path, by text.
function labelToLineDistances(page) {
  return page.evaluate(() => {
    const svg = document.querySelector(".mermaid svg");
    const paths = [...svg.querySelectorAll("g.edgePaths > path")].map((pa) => {
      const pts = [];
      try {
        const L = pa.getTotalLength();
        for (let i = 0; i <= 30; i++) {
          const q = pa.getPointAtLength((L * i) / 30);
          const sp = svg.createSVGPoint();
          sp.x = q.x;
          sp.y = q.y;
          const s = sp.matrixTransform(svg.getScreenCTM());
          pts.push({ x: s.x, y: s.y });
        }
      } catch (e) { /* empty path */ }
      return pts;
    });
    return Object.fromEntries(
      [...svg.querySelectorAll("g.edgeLabels g.edgeLabel")].filter((g) => (g.textContent || "").trim()).map((g) => {
        const r = g.getBoundingClientRect();
        const c = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        let best = Infinity;
        for (const pts of paths) for (const pt of pts) best = Math.min(best, Math.hypot(c.x - pt.x, c.y - pt.y));
        return [(g.textContent || "").trim(), Math.round(best)];
      }),
    );
  });
}

test("edge labels sit on their own edge on a fresh render, without dragging", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(FIXTURE);
    page = await state.browser.newPage();
    await page.setViewport({ width: 1300, height: 950 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".mermaid svg") && document.querySelector(".mermaid svg").__htmlitDrag, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 800));

    // Mermaid drops labels on curved edges (metadata, commands) a good way off the
    // line; htmlit used to leave them there until dragged. They must land on their
    // arrow at load now, so no label sits far from every edge.
    const dists = await labelToLineDistances(page);
    for (const [label, d] of Object.entries(dists)) {
      assert.ok(d <= 12, `label "${label}" should sit on its edge at load, but is ${d}px off`);
    }
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});

test("each edge label stays bound to its own edge in a dense subgraph diagram", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);
  let review, page;
  try {
    review = await startReview(FIXTURE);
    page = await state.browser.newPage();
    await page.setViewport({ width: 1300, height: 950 });
    await page.goto(review.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".mermaid svg") && document.querySelector(".mermaid svg").__htmlitDrag, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 700));

    const before = await labelCenters(page);
    await dragNodeContaining(page, "Blob storage", 50, 150);
    const afterBlob = await labelCenters(page);

    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const movedBlob = (label) => dist(before[label], afterBlob[label]);
    // The Blob-connected edge's label must follow the dragged node...
    assert.ok(movedBlob("detail, patches, logs") > 4, "the W->Blob label should follow the Blob node");
    // ...while a label on an edge that does NOT touch Blob (W->Cosmos) must stay put.
    // Under the old frame/greedy mismatch this one was flung instead.
    assert.ok(movedBlob("metadata") < 4, "an unrelated edge's label must not move when Blob is dragged");
    assert.ok(movedBlob("PBI discussion / status / close") < 4, "the W->ADO label must not move when Blob is dragged");

    // Dragging Cosmos (reached by heavily curved edges) must move its edge labels but
    // not 'commands' (W->command-keys). Matching on the arc-midpoint of a curved edge
    // - which sits nowhere near the label - mis-bound 'commands' to a Cosmos edge, so
    // it wrongly followed Cosmos. This pins the label to its whole path instead.
    const beforeCos = await labelCenters(page);
    await dragNodeContaining(page, "Cosmos", -120, -40);
    const afterCos = await labelCenters(page);
    const movedCos = (label) => dist(beforeCos[label], afterCos[label]);
    assert.ok(movedCos("metadata") > 4, "the W->Cosmos label should follow the Cosmos node");
    assert.ok(movedCos("commands") < 4, "the W->command label must not move when Cosmos is dragged");
  } finally {
    if (page) await page.close();
    if (review) await review.stop();
  }
});
