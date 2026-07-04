/**
 * Browser regression tests for the Mermaid rearrange feature in the injected
 * client, focused on the subgraph bug: dragging a node inside a subgraph used to
 * fling the arrows drawn between subgraphs, because their endpoints were bound to
 * inner nodes in a mismatched coordinate frame. These tests drive the real
 * daemon-served page with a headless browser and assert the arrows hold still.
 *
 * If no browser or Python is available, the suite skips rather than fails, so a
 * contributor without the toolchain can still run the rest of the tests. CI
 * always provides both, so there the suite runs for real.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "subgraph.html");
const INTER_EDGE = /^L_S\d+_S\d+/; // an arrow drawn between two subgraphs

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
  await state.page.setViewport({ width: 1400, height: 2000 });
  await state.page.goto(state.review.url, { waitUntil: "domcontentloaded" });
  await state.page.waitForFunction(
    () => {
      const svgs = [...document.querySelectorAll(".mermaid svg")];
      return svgs.length >= 2 && svgs.every((s) => s.__htmlitDrag);
    },
    { timeout: 20000 },
  );
});

after(async () => {
  if (state.page) await state.page.close();
  if (state.browser) await state.browser.close();
  if (state.review) await state.review.stop();
});

/** Index of the first diagram that contains subgraphs (g.cluster), and one without. */
function diagramIndices() {
  return state.page.evaluate(() => {
    const svgs = [...document.querySelectorAll(".mermaid svg")];
    const withClusters = svgs.findIndex((s) => s.querySelector("g.cluster"));
    const withoutClusters = svgs.findIndex((s) => !s.querySelector("g.cluster"));
    return { withClusters, withoutClusters };
  });
}

function edgeMap(svgIndex) {
  return state.page.evaluate((i) => {
    const svg = document.querySelectorAll(".mermaid svg")[i];
    const map = {};
    svg.querySelectorAll("g.edgePaths > path").forEach((p) => {
      map[p.id.replace(/^.*?-L_/, "L_")] = p.getAttribute("d");
    });
    return map;
  }, svgIndex);
}

function nodeCount(svgIndex) {
  return state.page.evaluate(
    (i) => document.querySelectorAll(".mermaid svg")[i].querySelectorAll("g.node").length,
    svgIndex,
  );
}

/** Drag one node by a screen-space offset and let the client rebuild its edges. */
async function dragNode(svgIndex, nodeIndex, dx, dy) {
  const target = await state.page.evaluate(
    ({ i, n }) => {
      const svg = document.querySelectorAll(".mermaid svg")[i];
      svg.scrollIntoView({ block: "center" });
      const node = svg.querySelectorAll("g.node")[n];
      const r = node.getBoundingClientRect();
      return { id: node.id, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    },
    { i: svgIndex, n: nodeIndex },
  );
  const steps = 12;
  await state.page.mouse.move(target.cx, target.cy);
  await state.page.mouse.down();
  for (let s = 1; s <= steps; s++) {
    await state.page.mouse.move(target.cx + (dx * s) / steps, target.cy + (dy * s) / steps);
  }
  await state.page.mouse.up();
  return target.id;
}

describe("mermaid subgraph rearrange", () => {
  test("dragging any inner node leaves the inter-subgraph arrows untouched", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);

    const { withClusters } = await diagramIndices();
    assert.ok(withClusters >= 0, "expected a diagram with subgraphs");

    const baseline = await edgeMap(withClusters);
    const interEdges = Object.keys(baseline).filter((id) => INTER_EDGE.test(id));
    assert.ok(interEdges.length >= 2, "fixture should have arrows between subgraphs");

    const count = await nodeCount(withClusters);
    for (let n = 0; n < count; n++) {
      await dragNode(withClusters, n, -70, 60);
      const after = await edgeMap(withClusters);
      for (const id of interEdges) {
        assert.equal(after[id], baseline[id], `inter-subgraph arrow ${id} moved when dragging node #${n}`);
      }
    }
  });

  test("dragging a node moves its own connected edge", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);

    const { withClusters } = await diagramIndices();
    const before = await edgeMap(withClusters);
    await dragNode(withClusters, 0, 90, 40);
    const after = await edgeMap(withClusters);

    const intraChanged = Object.keys(before).filter(
      (id) => !INTER_EDGE.test(id) && before[id] !== after[id],
    );
    assert.ok(intraChanged.length >= 1, "the dragged node's own edge should follow it");
  });

  test("a diagram without subgraphs still rearranges", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);

    const { withoutClusters } = await diagramIndices();
    assert.ok(withoutClusters >= 0, "expected a plain diagram");
    const before = await edgeMap(withoutClusters);
    await dragNode(withoutClusters, 1, 60, 30);
    const after = await edgeMap(withoutClusters);
    assert.notDeepEqual(after, before, "dragging a node should rebuild at least one edge");
  });

  test("no console or page errors occurred while rearranging", async (t) => {
    if (state.unavailable) return t.skip(state.unavailable);
    assert.deepEqual(state.errors, [], `unexpected browser errors:\n${state.errors.join("\n")}`);
  });
});
