/**
 * Browser regression test for the Mermaid rearrange feature: dragging a node used
 * to rebuild each connected edge as a straight line, which flattened curves and -
 * worse - stacked every parallel edge between the same two nodes onto one identical
 * segment. The rebuild now carries each edge's original path onto the moved
 * endpoints, so curvature and the separation of parallel edges survive a drag.
 *
 * Like the sibling suite, this skips (rather than fails) when no browser or Python
 * is available, and drives the real daemon-served client with a headless browser.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "parallel-edges.html");

const state = { browser: null, page: null, review: null, unavailable: null, errors: [] };

async function launchBrowser() {
  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
}

before(async () => {
  try {
    state.browser = await launchBrowser();
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
  await state.page.setViewport({ width: 1200, height: 800 });
  await state.page.goto(state.review.url, { waitUntil: "domcontentloaded" });
  await state.page.waitForFunction(
    () => {
      const svgs = [...document.querySelectorAll(".mermaid svg")];
      return svgs.length >= 1 && svgs.every((s) => s.__htmlitDrag);
    },
    { timeout: 20000 },
  );
});

after(async () => {
  if (state.page) await state.page.close();
  if (state.browser) await state.browser.close();
  if (state.review) await state.review.stop();
});

/** The `d` of every parallel A->B edge, plus its coordinate-pair count and endpoints. */
function edgePaths() {
  return state.page.evaluate(() => {
    const svg = document.querySelector(".mermaid svg");
    return [...svg.querySelectorAll("g.edgePaths > path")].map((p) => {
      const d = p.getAttribute("d") || "";
      const nums = (d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
      const round = (n) => Math.round(n);
      const pt = (i) => round(nums[i]) + "," + round(nums[i + 1]);
      return { id: p.id, d, pairs: nums.length / 2, start: pt(0), end: pt(nums.length - 2) };
    });
  });
}

/** Drag the first node by a screen-space offset and let the client rebuild edges. */
async function dragFirstNode(dx, dy) {
  const target = await state.page.evaluate(() => {
    const svg = document.querySelector(".mermaid svg");
    svg.scrollIntoView({ block: "center" });
    const node = svg.querySelectorAll("g.node")[0];
    const r = node.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  await state.page.mouse.move(target.cx, target.cy);
  await state.page.mouse.down();
  for (let s = 1; s <= 12; s++) {
    await state.page.mouse.move(target.cx + (dx * s) / 12, target.cy + (dy * s) / 12);
  }
  await state.page.mouse.up();
}

/** Grab an edge label by its text and drag it by a screen-space offset (bends the edge). */
async function dragLabel(text, dx, dy) {
  const target = await state.page.evaluate((t) => {
    const svg = document.querySelector(".mermaid svg");
    svg.scrollIntoView({ block: "center" });
    const g = [...svg.querySelectorAll("g.edgeLabels g.edgeLabel")].find((l) => (l.textContent || "").trim() === t);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  }, text);
  if (!target) throw new Error(`edge label ${text} not found`);
  await state.page.mouse.move(target.cx, target.cy);
  await state.page.mouse.down();
  for (let s = 1; s <= 12; s++) {
    await state.page.mouse.move(target.cx + (dx * s) / 12, target.cy + (dy * s) / 12);
  }
  await state.page.mouse.up();
}

function dist(p, q) {
  const a = p.split(",").map(Number), c = q.split(",").map(Number);
  return Math.hypot(a[0] - c[0], a[1] - c[1]);
}

describe("mermaid parallel-edge rearrange", () => {
  test("dragging a node keeps parallel edges curved and separated", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);

    const before = await edgePaths();
    assert.ok(before.length >= 3, "fixture should render several parallel edges");
    // Mermaid bows parallel edges apart, so they start curved (multi-point) and distinct.
    assert.ok(
      before.every((e) => e.pairs > 2),
      "parallel edges should start as curves, not straight segments",
    );
    assert.equal(new Set(before.map((e) => e.d)).size, before.length, "edges should start distinct");

    await dragFirstNode(-60, 70);
    const after = await edgePaths();

    // The bug: every edge became an identical 2-point straight line (all d equal).
    assert.ok(
      after.every((e) => e.pairs > 2),
      "each edge should stay curved after the drag, not collapse to a straight line",
    );
    assert.equal(
      new Set(after.map((e) => e.d)).size,
      after.length,
      "parallel edges must stay separated, not stack onto one segment",
    );
    // The endpoints (arrowheads in particular) must stay fanned out too, not converge
    // on a single toward-centre point - the "end arrows stick together" regression.
    assert.equal(
      new Set(after.map((e) => e.end)).size,
      after.length,
      "arrowheads must stay separated, not stack on one point",
    );
    assert.equal(
      new Set(after.map((e) => e.start)).size,
      after.length,
      "edge starts must stay separated too",
    );
    assert.notDeepEqual(after, before, "the dragged node's edges should follow it");
  });

  test("dragging an edge label bends only that edge and keeps its arrowhead pinned", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);

    const before = await edgePaths();
    const b = Object.fromEntries(before.map((e) => [e.id, e]));

    await dragLabel("e0", 0, 60); // pull a label perpendicular to the horizontal edges

    const after = await edgePaths();
    const changed = after.filter((e) => e.d !== b[e.id].d);
    assert.equal(changed.length, 1, "exactly the grabbed edge should bend, not the others");

    const edge = changed[0];
    assert.ok(edge.pairs <= 3, "the bent edge should become a single quadratic");
    // The bug: bending recomputed endpoints from the node centres, so the arrowhead
    // jumped to the shared toward-centre point. It must stay on its own endpoint.
    assert.ok(
      dist(edge.end, b[edge.id].end) <= 6,
      `the arrowhead should stay pinned when bending (moved ${Math.round(dist(edge.end, b[edge.id].end))}px)`,
    );
  });

  test("no console or page errors occurred while rearranging", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);
    assert.deepEqual(state.errors, [], `unexpected browser errors:\n${state.errors.join("\n")}`);
  });
});
