/**
 * Records the README demo GIF (docs/demo.gif) as a three-act story.
 *
 *   1. Terminal: an agent replies with a very long plain-text answer you end up
 *      skimming, so you run `/htmlit please explain this to me more`.
 *   2. Browser: the reply opens as an htmlit review. You highlight, comment, drag
 *      and comment on the diagram, then send. The agent answers inline and offers a
 *      decision; you pick one and hit Send & end.
 *   3. Terminal: the agent has your message and your pick, and gets to work.
 *
 * Everything is real: it drives the actual daemon and injected client in a headless
 * browser, captures frames over CDP, and encodes them with ffmpeg. The only added
 * chrome is a visible cursor and caption pill, since headless capture has no cursor.
 *
 * Requirements: `npm ci` (Puppeteer), Python 3 (the daemon), ffmpeg on PATH.
 * Run from the repo root: `node scripts/record-demo.mjs`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as rawSleep } from "node:timers/promises";

import { startReview } from "../tests/client/harness.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TERMINAL = pathToFileURL(join(REPO, "docs", "demo-terminal.html")).href;
const DEMO = join(REPO, "docs", "demo-source.html");
const OUT = join(REPO, "docs", "demo.gif");
const FRAMES = mkdtempSync(join(tmpdir(), "htmlit-demo-"));
const VIEW = { width: 1280, height: 760 };
// Capture at 2x device pixels and downscale, so text stays crisp (supersampling)
// instead of being rendered at 1x and softened by the downscale and palette.
const SCALE = 2;
const GIF_WIDTH = 900;

// A single knob to pace the whole demo. Every hold, click settle, drag step, and
// cursor glide is scaled by this, so raising it speeds up the entire recording
// uniformly without retiming each beat by hand.
const SPEED = 2;
const sleep = (ms) => rawSleep(Math.round(ms / SPEED));
const glide = (seconds) => (seconds / SPEED).toFixed(2) + "s";
// Full-screen narrative cards hold for a fixed span that does not scale with SPEED,
// so the small subtext stays readable however fast the surrounding action runs.
const READ_MS = 3200;
const hold = () => rawSleep(READ_MS);

const USER_QUESTION = "Should we migrate auth to the new identity service?";

// What the agent prints in the terminal: plain text, the way a CLI agent replies.
// No rendered markdown, and the table is drawn in ASCII. It is deliberately long,
// the kind of reply you skim, which is exactly what htmlit turns into a page.
const AGENT_TEXT = `Short answer: yes, but in three phases, not one. The monolith mints opaque
session tokens that only it can validate, so a single big-bang cutover is a coin
flip on every active login. A dual-write phase lets the new identity service
take over gradually while the old path stays a safe, tested fallback.

Recommendation: start with dual-write. Mirror new sessions into the identity
service while the monolith still owns reads. Promote reads only once parity
holds for a full week with no divergence.

Why not a single cutover:

  - There is no clean rollback. Once the monolith stops minting tokens, every
    live session depends on the new service being correct on day one.
  - Token formats differ. Existing sessions carry the old opaque token; the new
    service issues signed tokens, so both have to be accepted during overlap.
  - You cannot verify parity in advance. Dual-write is what gives you the data
    to prove the new path matches before you trust it.

Rollout:

  1. Dual-write. Every new session is written to both stores. A parity job
     compares them continuously and alerts on any divergence over 0.01%.
  2. Move reads. Flip reads to the identity service behind a feature flag, one
     cohort at a time (internal users, then 1%, 10%, 50%, 100%), watching the
     parity numbers and error rates at each step.
  3. Retire. Delete the monolith auth path once traffic to it is zero for seven
     straight days and no cohort has rolled back.

The shape of the change:

    def issue_session(user, dual_write=True):
        token = identity.mint(user)      # new service is the source of truth
        if dual_write:
            legacy.mirror(user, token)   # keep the monolith warm as a fallback
        return token

    def read_session(sid, prefer_new):
        if prefer_new and identity.has(sid):
            return identity.read(sid)
        return legacy.read(sid)          # fallback while reads migrate

Observability you need before phase 2:

  - A parity dashboard: writes to each store, divergences, and the divergence
    rate over time.
  - Per-cohort error and latency panels for the read path, so a bad cohort is
    obvious within minutes, not hours.
  - An alert that pages if divergence crosses 0.01% or read errors spike.

Rollback playbook:

  - Phase 1: nothing to roll back; the monolith still owns reads.
  - Phase 2: flip the feature flag for the affected cohort back to the monolith.
    Because dual-write is still on, the monolith already has every session.
  - Phase 3: do not start until you are willing to lose the fallback.

Alternatives considered:

  - Big-bang cutover: fastest, but no safe rollback. Rejected.
  - Read-through shim in the monolith: less code churn, but it keeps the
    monolith on the critical path forever. Rejected.
  - Dual-write with staged reads (this plan): one extra week of dual-write buys
    a clean rollback at every step. Recommended.

Risks and how we cover them:

    +----------------------+---------------------------------------+
    | Risk                 | Mitigation                            |
    +----------------------+---------------------------------------+
    | Session parity drift | Continuous parity job + alerting      |
    | Rollback mid-cutover | Keep dual-write on until phase 3      |
    | Token format change  | Version the token; accept both        |
    | Cohort-specific bug  | Stage reads 1% -> 10% -> 50% -> 100%  |
    | Clock skew on expiry | Pin both stores to one NTP source     |
    +----------------------+---------------------------------------+

Open questions for you:

  - How long should parity hold before we move reads: one week or two?
  - Do we migrate service-to-service tokens in the same rollout, or after?
  - Who owns the parity dashboard and the pager rotation during cutover?

Rough timeline: about four weeks. Week 1 dual-write and parity, weeks 2-3 staged
reads, week 4 soak and retire, assuming parity stays clean.

Net: the extra phase buys a clean rollback for the price of a week of
dual-write. Want me to render this as a diagram you can pick apart?`;

const BRIDGE_REPLY = "Here is the plan, rendered so you can read it. Highlight or comment on anything and I'll expand it inline.";

const frameMeta = []; // { name, ts } - frames are written to disk as they arrive
let frameSeq = 0;
let cast = null;

async function startCast(page) {
  if (!cast) {
    cast = await page.createCDPSession();
    cast.on("Page.screencastFrame", async (frame) => {
      // Write each frame straight to disk so a 2x-resolution capture never has to
      // hold thousands of large PNGs in memory at once.
      const name = `f${String(++frameSeq).padStart(6, "0")}.png`;
      try {
        writeFileSync(join(FRAMES, name), Buffer.from(frame.data, "base64"));
        frameMeta.push({ name, ts: Date.now() });
      } catch {}
      try { await cast.send("Page.screencastFrameAck", { sessionId: frame.sessionId }); } catch {}
    });
  }
  try { await cast.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE }); } catch {}
}

// Pause capture across a navigation. A fresh document paints its own background
// once before our dark cover mounts, so recording through goto() leaks a white
// flash between scenes; we resume only after the next page has booted behind the fade.
async function stopCast() {
  if (cast) { try { await cast.send("Page.stopScreencast"); } catch {} }
}

function installFade(page) {
  return page.evaluateOnNewDocument(() => {
    function mount() {
      try {
        if (document.getElementById("__fade") || !document.documentElement) return;
        const f = document.createElement("div");
        f.id = "__fade";
        f.style.cssText = "position:fixed;inset:0;background:#0d1117;z-index:2147483647;pointer-events:none;transition:opacity .35s;opacity:1";
        document.documentElement.appendChild(f);
      } catch (_) { /* the page will still render; the fade is cosmetic */ }
    }
    if (document.documentElement) mount();
    else document.addEventListener("readystatechange", mount);
  });
}
const fadeIn = (page) => page.evaluate(() => { const f = document.getElementById("__fade"); if (f) { f.style.opacity = "0"; setTimeout(() => f.remove(), 400); } });
async function fadeOut(page) {
  await page.evaluate(() => {
    let f = document.getElementById("__fade");
    if (!f) { f = document.createElement("div"); f.id = "__fade"; f.style.cssText = "position:fixed;inset:0;background:#0d1117;z-index:2147483647;pointer-events:none;transition:opacity .35s;opacity:0"; document.documentElement.appendChild(f); }
    requestAnimationFrame(() => (f.style.opacity = "1"));
  });
  await sleep(420);
}

async function installOverlay(page) {
  await page.evaluate((glideDur) => {
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.style.cssText =
      "position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483646;pointer-events:none;" +
      "transition:left " + glideDur + " cubic-bezier(.4,0,.2,1),top " + glideDur + " cubic-bezier(.4,0,.2,1);will-change:left,top;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));";
    cursor.innerHTML =
      "<svg width='24' height='24' viewBox='0 0 24 24'><path d='M4 2 L4 20 L9 15 L12.5 22 L15 21 L11.5 14 L18 14 Z' fill='#fff' stroke='#111' stroke-width='1.2' stroke-linejoin='round'/></svg>";
    document.documentElement.appendChild(cursor);
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    caption.style.cssText =
      "position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483645;pointer-events:none;" +
      "background:rgba(17,18,22,.92);color:#fff;font:600 15px/1 ui-sans-serif,system-ui,sans-serif;padding:10px 18px;" +
      "border-radius:999px;opacity:0;transition:opacity .3s;white-space:nowrap;box-shadow:0 4px 18px rgba(0,0,0,.35);";
    document.documentElement.appendChild(caption);
    const narrative = document.createElement("div");
    narrative.id = "demo-narrative";
    narrative.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;text-align:center;padding:0 8vw;opacity:0;transition:opacity .5s;" +
      "background:radial-gradient(130% 130% at 50% 42%,rgba(13,17,23,.92),rgba(13,17,23,.995));font-family:ui-sans-serif,system-ui,sans-serif;";
    const narBig = document.createElement("div");
    narBig.style.cssText = "color:#fff;font-weight:750;font-size:40px;line-height:1.25;letter-spacing:-.02em;max-width:900px;";
    const narSub = document.createElement("div");
    narSub.style.cssText = "color:#9aa5b1;font-size:20px;line-height:1.5;margin-top:18px;max-width:720px;";
    narrative.appendChild(narBig);
    narrative.appendChild(narSub);
    document.documentElement.appendChild(narrative);
    window.__demo = {
      SMOOTH: "left " + glideDur + " cubic-bezier(.4,0,.2,1), top " + glideDur + " cubic-bezier(.4,0,.2,1)",
      move(x, y, instant) {
        // Point-to-point moves glide (readable); drags and text sweeps track the
        // pointer with no easing, so the cursor stays glued to what it is moving.
        cursor.style.transition = instant ? "none" : this.SMOOTH;
        cursor.style.left = x - 3 + "px";
        cursor.style.top = y - 2 + "px";
      },
      pulse(x, y) {
        const r = document.createElement("div");
        r.style.cssText = "position:fixed;left:" + (x - 6) + "px;top:" + (y - 6) + "px;width:12px;height:12px;border-radius:50%;z-index:2147483644;pointer-events:none;background:rgba(124,58,237,.55);transition:transform .4s,opacity .4s;";
        document.documentElement.appendChild(r);
        requestAnimationFrame(() => { r.style.transform = "scale(4)"; r.style.opacity = "0"; });
        setTimeout(() => r.remove(), 450);
      },
      caption(text) { caption.textContent = text; caption.style.opacity = text ? "1" : "0"; },
      narrate(big, sub) {
        if (!big) { narrative.style.opacity = "0"; return; }
        narBig.innerHTML = big;
        narSub.innerHTML = sub || "";
        narrative.style.opacity = "1";
      },
    };
  }, glide(0.42));
}

const moveCursor = (page, x, y, instant = false) => page.evaluate((p) => window.__demo.move(p.x, p.y, p.instant), { x, y, instant });
const pulse = (page, x, y) => page.evaluate((p) => window.__demo.pulse(p.x, p.y), { x, y });
const caption = (page, text) => page.evaluate((t) => window.__demo.caption(t), text);
const narrate = (page, big, sub) => page.evaluate((n) => window.__demo.narrate(n.big, n.sub), { big, sub });
const termCaption = (page, text) => page.evaluate((t) => window.cli.caption(t), text);

function shadowCenter(page, selector) {
  return page.evaluate((sel) => {
    const host = document.getElementById("htmlit-chrome");
    const el = host && host.shadowRoot && host.shadowRoot.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

async function clickAt(page, x, y, settle = 480) {
  await moveCursor(page, x, y);
  await sleep(settle);
  await pulse(page, x, y);
  await page.mouse.click(x, y);
}

async function clickShadow(page, selector, settle = 480) {
  const c = await shadowCenter(page, selector);
  if (!c) throw new Error("shadow element not found: " + selector);
  await clickAt(page, c.x, c.y, settle);
  return c;
}

/** Locate a phrase and return the client-space start and end points of its text. */
function locatePhrase(page, phrase) {
  return page.evaluate((text) => {
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(text);
      if (idx === -1) continue;
      const first = document.createRange();
      first.setStart(node, idx);
      first.setEnd(node, idx + 1);
      const last = document.createRange();
      last.setStart(node, idx + text.length - 1);
      last.setEnd(node, idx + text.length);
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      return { sx: a.left, sy: a.top + a.height / 2, ex: b.right, ey: b.top + b.height / 2 };
    }
    return null;
  }, phrase);
}

/** Select the phrase from its start up to `frac` of its length (0..1). */
function growSelection(page, phrase, frac) {
  return page.evaluate((args) => {
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(args.text);
      if (idx === -1) continue;
      const end = idx + Math.max(1, Math.round(args.text.length * args.frac));
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }, { text: phrase, frac });
}

/** Finalize the full selection and raise the annotation menu, as a real mouseup would. */
function finishSelection(page, phrase) {
  return page.evaluate((text) => {
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const r = range.getBoundingClientRect();
      node.parentElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true, clientX: r.right, clientY: r.bottom }));
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return null;
  }, phrase);
}

/** Drag-select a phrase: move to its start, sweep across it while the selection
 *  grows under the cursor, then raise the menu. Mirrors how a person highlights. */
async function highlightPhrase(page, phrase) {
  const span = await locatePhrase(page, phrase);
  if (!span) return null;
  await moveCursor(page, span.sx, span.sy);
  await sleep(380);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await moveCursor(page, span.sx + (span.ex - span.sx) * f, span.sy + (span.ey - span.sy) * f, true);
    await growSelection(page, phrase, f);
    await sleep(30);
  }
  await sleep(140);
  return finishSelection(page, phrase);
}

async function typeComment(page, text) {
  await clickShadow(page, ".pop .ce", 320);
  await sleep(120);
  await page.keyboard.type(text, { delay: Math.round(30 / SPEED) });
  await sleep(350);
}

/**
 * Smooth-scroll a mermaid node to the centre and return its viewport centre once
 * the scroll has settled. Scrolling smoothly (instead of an instant jump) keeps the
 * transition into the diagram from snapping, and waiting for the node position to
 * stabilise means the returned point is the final one the drag and click beats need.
 *
 * @param {import("puppeteer").Page} page demo page
 * @param {string} label node text to match
 * @returns {Promise<{x: number, y: number} | null>} node centre or null when absent
 */
function mermaidNodeCenter(page, label) {
  return page.evaluate((text) => new Promise((resolve) => {
    var svg = document.querySelector(".mermaid svg");
    if (!svg) { resolve(null); return; }
    var node = [...svg.querySelectorAll("g.node")].find(function (n) { return (n.textContent || "").includes(text); });
    if (!node) { resolve(null); return; }
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    var last = null;
    var still = 0;
    var frames = 0;
    (function measure() {
      var r = node.getBoundingClientRect();
      still = last !== null && Math.abs(r.top - last) < 0.5 ? still + 1 : 0;
      last = r.top;
      frames += 1;
      if (still >= 3 || frames > 120) resolve({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      else requestAnimationFrame(measure);
    })();
  }), label);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the agent's inline answers (linked to the comment ids) plus a decision. */
function answerFor(p) {
  const q = (p.prompt || "").toLowerCase();
  if (q.includes("dual-write") || q.includes("how long") || q.includes("run"))
    return "It runs until parity holds for seven straight days with zero divergence, which is about two weeks in practice. The parity job gates the promotion automatically, so you never have to guess.";
  if (q.includes("decides") || q.includes("yes") || q.includes("no"))
    return "It is a risk gate. Choose <strong>dual-write</strong> unless a maintenance window is long enough to re-issue every active session. For a live service that is effectively never, so dual-write is the safe default.";
  return "Good question. The short version: dual-write keeps a clean rollback available the whole way through.";
}

/** One inline answer, tagged with the comment id so htmlit renders it in the
 *  comment's rail card and lets you click through to it from the anchor. */
function answerBlock(p) {
  return `<section data-htmlit-answer data-htmlit-answer-for="${escapeHtml(p.commentId)}" data-question="${escapeHtml(p.prompt || "")}"><p>${answerFor(p)}</p></section>`;
}

/** The one decision the agent asks the human to make, kept separate from the
 *  inline comment answers. */
function buildDecisionSection() {
  return `
<section id="agent-response">
  <style>
    #agent-response h2 { margin-top: 26px; }
    .options { display: grid; gap: 10px; margin: 8px 0 4px; }
    .options label { display: block; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; cursor: pointer; background: var(--card); }
    .options label:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
    .options input { position: absolute; opacity: 0; }
    .options .t { font-weight: 700; }
    .options .t em { font-style: normal; font-size: 11px; font-weight: 700; color: #fff; background: var(--good); padding: 1px 7px; border-radius: 999px; margin-left: 8px; }
    .options .d { display: block; color: var(--muted); font-size: 13.5px; margin-top: 2px; }
  </style>
  <h2>Pick a rollout timeline and I'll set it up</h2>
  <div class="options">
    <label><input type="radio" name="timeline" value="aggressive"><span class="t">Aggressive</span><span class="d">1 week of parity, then promote reads</span></label>
    <label><input type="radio" name="timeline" value="balanced"><span class="t">Balanced<em>recommended</em></span><span class="d">2 weeks of parity before reads move</span></label>
    <label><input type="radio" name="timeline" value="cautious"><span class="t">Cautious</span><span class="d">4 weeks of parity plus a manual sign-off</span></label>
  </div>
</section>`;
}

/** Answer each comment inline, right next to the element it targets, so the
 *  answer sits by the question and appears in the comment's rail card. Then
 *  append the single decision the agent needs back from the human. */
async function agentRespondsInline(review) {
  const post = (path, body) => fetch(review.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await fetch(`${review.base}/api/poll?key=${review.key}&timeout=3`).then((r) => r.json()).catch(() => ({}));
  const prompts = ((res && res.prompts) || []).filter((p) => p.commentId);
  let html = readFileSync(review.artifact, "utf8");
  for (const p of prompts) {
    const block = answerBlock(p);
    const q = (p.prompt || "").toLowerCase();
    if (/dual-write|how long|run/.test(q) && html.includes("where nobody can log in.</p>")) {
      html = html.replace("where nobody can log in.</p>", "where nobody can log in.</p>\n\n    " + block);
    } else if (html.includes("<h2>Why not cut over in one pass?</h2>")) {
      html = html.replace("<h2>Why not cut over in one pass?</h2>", block + "\n\n    <h2>Why not cut over in one pass?</h2>");
    } else {
      html = html.replace("</main>", "    " + block + "\n</main>");
    }
  }
  html = html.replace("</main>", buildDecisionSection() + "\n</main>");
  writeFileSync(review.artifact, html);
  await post("/api/agent-reply", { key: review.key, text: "Answered both comments inline, right where you asked. One decision left for you below.", presence: "listening" });
}

async function sceneTerminalIntro(page, review) {
  await page.goto(TERMINAL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.cli, { timeout: 8000 });
  await startCast(page);
  await fadeIn(page);
  await sleep(500);

  // Type the question and press enter.
  await page.evaluate((q) => window.cli.typeInput(q.text, q.cps), { text: USER_QUESTION, cps: Math.round(30 * SPEED) });
  await sleep(500);
  await page.evaluate(() => window.cli.submitInput());
  await sleep(500);

  // The agent thinks, then streams its reply in like a CLI generating tokens.
  await page.evaluate(() => window.cli.thinking(true));
  await sleep(1500);
  await page.evaluate(async (text) => { window.cli.thinking(false); await window.cli.streamAgentText(text); }, AGENT_TEXT);
  await sleep(900);

  // The reply is long: one quick scroll up to skim it, then make the point.
  await page.evaluate((ms) => window.cli.scrollTo(0, ms), Math.round(700 / SPEED));
  await sleep(600);

  // Full-screen narrative: hold the point so the viewer actually reads it.
  await page.evaluate((n) => window.cli.narrate(n.big, n.sub), {
    big: "The longer the reply, the more we <span class='hl'>skim</span>.",
    sub: "and skimming is how the assumption that mattered slips right past you.",
  });
  await hold();
  await page.evaluate((n) => window.cli.narrate(n.big, n.sub), {
    big: "So don't skim it. <span class='hl'>&ldquo;html it.&rdquo;</span>",
    sub: "turn the reply into a page you can read, question, and steer.",
  });
  await hold();
  await page.evaluate(() => window.cli.narrate(""));
  await sleep(600);

  // Ask the agent to open it in htmlit. It replies with the local URL, then opens,
  // mirroring what the real command prints before it launches the browser.
  await page.evaluate((cps) => window.cli.typeInput("/htmlit please explain this to me more", cps), Math.round(26 * SPEED));
  await sleep(900);
  await page.evaluate(() => window.cli.submitInput());
  await sleep(450);
  await page.evaluate(() => window.cli.thinking(true));
  await sleep(1300);
  await page.evaluate((url) => {
    window.cli.thinking(false);
    window.cli.pushAgentHtml(
      '<pre class="raw">Opening a review surface for this reply.\n  <span class="link">' + url +
      '</span>  <span class="dim">(opening in your browser...)</span></pre>',
    );
  }, review.url);
  await page.evaluate(() => window.cli.hideCursor());
  await sleep(1900);
}

async function sceneHtmlit(page, review) {
  await fadeOut(page);
  await stopCast();
  await page.goto(review.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".mermaid svg") && document.getElementById("htmlit-chrome"), { timeout: 20000 });
  await installOverlay(page);
  await startCast(page);
  await moveCursor(page, 620, 380);
  await fadeIn(page);
  await sleep(1100);

  // Bridge card: it is the same agent session, now interactive.
  await narrate(page, 'Same agent session, <span style="color:#a371f7">now interactive.</span>', "Ask a question, clear up a misunderstanding, and steer the work, right on the page.");
  await hold();
  await narrate(page, "");
  await sleep(700);

  caption(page, "Highlight the important parts to note them");
  await highlightPhrase(page, "three phases, not one");
  await sleep(550);
  await clickShadow(page, '.selmenu [data-act="hlmark"]');
  await sleep(1100);

  caption(page, "Ask the agent, inline on the text");
  await highlightPhrase(page, "dual-write phase");
  await sleep(550);
  await clickShadow(page, '.selmenu [data-act="hlcomment"]');
  await sleep(450);
  await typeComment(page, "How long does dual-write need to run?");
  await clickShadow(page, '[data-act="popadd"]');
  await sleep(1100);

  caption(page, "Rearrange the diagram to read it");
  const from = await mermaidNodeCenter(page, "Big-bang cutover");
  if (from) {
    await moveCursor(page, from.x, from.y);
    await sleep(450);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const to = { x: from.x + 150, y: from.y + 40 };
    const steps = 22;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await page.mouse.move(x, y);
      await moveCursor(page, x, y, true);
      await sleep(24);
    }
    await page.mouse.up();
    await sleep(1000);
  }

  caption(page, "Comment on a node in the diagram");
  const decision = await mermaidNodeCenter(page, "Dual-write sessions");
  if (decision) {
    await clickAt(page, decision.x, decision.y, 500);
    await sleep(450);
    await clickShadow(page, '.selmenu [data-act="hlcomment"]');
    await sleep(400);
    await typeComment(page, "What decides yes vs no here?");
    await clickShadow(page, '[data-act="popadd"]');
    await sleep(1000);
  }

  caption(page, "Code and diffs render, fully highlighted");
  await page.evaluate(() => {
    const c = [...document.querySelectorAll("pre code")].find((el) => /language-python/.test(el.className));
    if (c) c.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  await sleep(2200);
  await page.evaluate(() => {
    const d = document.querySelector(".htmlit-diff");
    if (d) d.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  await sleep(2000);

  // The diff has a Unified/Split toggle: switch it to the two-column split view.
  caption(page, "Read a diff unified, or split into two columns");
  const splitToggle = await page.evaluate(() => {
    const radio = document.querySelector(".htmlit-diff-split-radio");
    const label = radio && radio.closest("label");
    if (!label) return null;
    label.scrollIntoView({ block: "center" });
    const r = label.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (splitToggle) { await clickAt(page, splitToggle.x, splitToggle.y, 500); await sleep(2000); }

  // Scroll back up to the comment you queued so its card is in view, then send.
  caption(page, "Back to your comment, then send it");
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("p")].find((p) => /dual-write phase/.test(p.textContent));
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  await sleep(1500);
  await clickShadow(page, '[data-act="send"]');
  await sleep(900);

  caption(page, "The agent answers right next to your question");
  await agentRespondsInline(review);
  await sleep(2600);

  // Scroll the answer off-screen, then use the card's jump to land back on it.
  caption(page, "Or click the card to jump to the answer");
  await page.evaluate(() => { const c = document.querySelector(".mermaid"); if (c) c.scrollIntoView({ block: "center", behavior: "smooth" }); });
  await sleep(1000);
  await page.waitForFunction(() => {
    const r = document.getElementById("htmlit-chrome");
    return r && r.shadowRoot && r.shadowRoot.querySelector(".card .card-answer-jump");
  }, { timeout: 6000 }).catch(() => {});
  await clickShadow(page, ".card .card-answer-jump").catch(() => {});
  await sleep(2400);

  caption(page, "And it offers a decision to make");
  await page.evaluate(() => { const s = document.getElementById("agent-response"); if (s) s.scrollIntoView({ block: "center", behavior: "smooth" }); });
  await sleep(1400);
  const opt = await page.evaluate(() => {
    const label = [...document.querySelectorAll("#agent-response .options label")].find((l) => l.textContent.includes("Balanced"));
    if (!label) return null;
    const r = label.getBoundingClientRect();
    return { x: r.left + 24, y: r.top + r.height / 2 };
  });
  if (opt) { await clickAt(page, opt.x, opt.y, 550); await sleep(1200); }

  caption(page, "Approve, then Send & end");
  const box = await shadowCenter(page, ".composer .ce");
  if (box) { await clickAt(page, box.x, box.y, 350); await page.keyboard.type("Balanced timeline it is. Sounds good, let's get it done.", { delay: Math.round(26 / SPEED) }); await sleep(500); }
  await clickShadow(page, '[data-act="sendend"]');
  await sleep(1500);
  caption(page, "");
}

async function sceneTerminalOutro(page) {
  await fadeOut(page);
  await stopCast();
  await page.goto(TERMINAL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.cli, { timeout: 8000 });
  await startCast(page);
  await page.evaluate(() => {
    window.cli.hideCursor();
    window.cli.pushUser("Balanced timeline it is. Sounds good, let's get it done.");
    window.cli.thinking(true);
  });
  await fadeIn(page);
  await sleep(1300);
  await page.evaluate((scrollMs) => {
    window.cli.thinking(false);
    window.cli.pushAgentHtml(
      '<pre class="raw">On it. Dual-write rollout on the balanced timeline (2 weeks of parity).\nApplying your two clarifications.</pre>' +
      "<div class='task' data-i='0'><span class='box'></span>Add dual-write to issue_session</div>" +
      "<div class='task' data-i='1'><span class='box'></span>Wire the parity job + divergence alert</div>" +
      "<div class='task' data-i='2'><span class='box'></span>Set the 2-week promotion gate</div>" +
      "<div class='thinking' style='margin-top:12px'><span class='spin'></span><span>working&hellip;</span></div>",
    );
    window.cli.scrollTo(1, scrollMs);
  }, Math.round(500 / SPEED));
  await sleep(700);
  termCaption(page, "The agent has your answers and your decision, and gets to work");
  for (const i of [0, 1, 2]) {
    await sleep(1000);
    await page.evaluate((idx) => { const t = document.querySelector(`.task[data-i='${idx}']`); if (t) t.classList.add("done"); document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight; }, i);
  }
  await sleep(1400);
  termCaption(page, "");
  await sleep(600);
}

function writeFrames() {
  const lines = [];
  for (let i = 0; i < frameMeta.length; i++) {
    const next = frameMeta[i + 1] ? frameMeta[i + 1].ts : frameMeta[i].ts + 1500;
    const dur = Math.max(0.03, Math.min(2.2, (next - frameMeta[i].ts) / 1000));
    lines.push(`file '${frameMeta[i].name}'`, `duration ${dur.toFixed(3)}`);
  }
  if (frameMeta.length) lines.push(`file '${frameMeta[frameMeta.length - 1].name}'`);
  writeFileSync(join(FRAMES, "list.txt"), lines.join("\n") + "\n");
}

function encodeGif() {
  // Downscale the 2x frames to GIF_WIDTH with lanczos (the supersample that keeps
  // text sharp), and give text the full 256-colour budget with a light dither.
  const filter =
    `fps=10,scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];` +
    "[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", filter, "-loop", "0", "-y", OUT], { cwd: FRAMES, stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed; is it installed and on PATH?");
  optimizeGif();
}

/**
 * Shrink the GIF with gifsicle if it is available. This is optional: without it
 * the ffmpeg output is already valid, just larger. Contributors who want the
 * smaller committed size can install gifsicle (`npm i -g gifsicle` or a system
 * package).
 */
function optimizeGif() {
  const probe = spawnSync("gifsicle", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) {
    console.log("gifsicle not found; skipping GIF size optimization");
    return;
  }
  const r = spawnSync("gifsicle", ["-O3", "--lossy=80", "-o", OUT, OUT], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("gifsicle failed while optimizing the GIF");
}

async function main() {
  const review = await startReview(DEMO);
  await fetch(`${review.base}/api/agent-reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: review.key, text: BRIDGE_REPLY, presence: "listening" }) });

  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--force-color-profile=srgb"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...VIEW, deviceScaleFactor: SCALE });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await installFade(page);

    await sceneTerminalIntro(page, review);
    await sceneHtmlit(page, review);
    await sceneTerminalOutro(page);

    try { await cast.send("Page.stopScreencast"); } catch {}
    await sleep(200);
    writeFrames();
    console.log(`captured ${frameMeta.length} frames; encoding ${OUT}`);
  } finally {
    await browser.close();
    await review.stop();
  }
  encodeGif();
  rmSync(FRAMES, { recursive: true, force: true });
  console.log("done");
}

main().catch((e) => { rmSync(FRAMES, { recursive: true, force: true }); console.error(e); process.exit(1); });
