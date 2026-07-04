/**
 * Regression test for live agent replies rendering exactly once.
 *
 * When an agent replies while a browser is open, the daemon broadcasts a single
 * authoritative `chat-sync` (a full re-render of the conversation). A previous
 * version also pushed a separate `agent-reply` event that appended the same
 * bubble again, so every live reply showed up twice. This test opens a review,
 * posts a reply over HTTP, and asserts the panel shows the reply once.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { startReview } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "subgraph.html");
const REPLY = "Here is the expanded explanation you asked for.";

const state = { browser: null, page: null, review: null, unavailable: null };

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
  await state.page.goto(state.review.url, { waitUntil: "domcontentloaded" });
  await state.page.waitForFunction(() => !!document.getElementById("htmlit-chrome"), { timeout: 20000 });
});

after(async () => {
  if (state.page) await state.page.close();
  if (state.browser) await state.browser.close();
  if (state.review) await state.review.stop();
});

function countAgentBubbles(page, text) {
  return page.evaluate((needle) => {
    const root = document.getElementById("htmlit-chrome").shadowRoot;
    return [...root.querySelectorAll(".bubble.agent")].filter((b) => b.textContent.includes(needle)).length;
  }, text);
}

test("a live agent reply renders exactly one bubble", async (t) => {
  if (state.unavailable) return t.skip(state.unavailable);

  const res = await fetch(`${state.review.base}/api/agent-reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: state.review.key, text: REPLY, presence: "listening" }),
  });
  assert.equal(res.status, 200);

  await state.page.waitForFunction(
    (needle) => {
      const root = document.getElementById("htmlit-chrome").shadowRoot;
      return [...root.querySelectorAll(".bubble.agent")].some((b) => b.textContent.includes(needle));
    },
    { timeout: 5000 },
    REPLY,
  );
  await sleep(300); // allow any stray duplicate event to land before counting

  assert.equal(await countAgentBubbles(state.page, REPLY), 1, "the agent reply should appear exactly once");
});
