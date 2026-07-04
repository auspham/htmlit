import { HighlightKind, state as appState } from "./state.js";
import { ui } from "./dom.js";
import { inChrome } from "./util.js";
import { removeItem } from "./chat.js";
import { applyHighlights, getPending, hasAnswer, pendingRects, repositionSelMenu, resolveDiagramTarget, resolveRange } from "./annotate.js";
import { positionRail } from "./rail.js";

export function itemLiveRange(q) {
  return q.range ? resolveRange(q.range) : null;
}
export function rectsToArray(list) { return list && list.length ? Array.prototype.slice.call(list) : []; }
// Clip an element's client rects to its Mermaid frame - the pannable,
// overflow:hidden viewport. A node/edge that is zoomed or panned outside the
// frame would otherwise have its overlay (anchor box, pin, pending outline)
// drawn at raw screen coords, floating over the rest of the page; clipping hides
// the off-frame part (and the whole overlay once the target leaves the frame).
// Non-diagram elements have no frame, so their rects pass through unchanged.
export function clipRectsToFrame(el, rects) {
  var frame = el && el.closest && el.closest(".mermaid");
  if (!frame) return rects;
  var f = frame.getBoundingClientRect();
  var out = [];
  rects.forEach(function (r) {
    var left = Math.max(r.left, f.left), top = Math.max(r.top, f.top);
    var right = Math.min(r.right, f.right), bottom = Math.min(r.bottom, f.bottom);
    if (right - left > 0.5 && bottom - top > 0.5) out.push({ left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top });
  });
  return out;
}
export function itemRects(q) {
  if (q.range) {
    var lr = itemLiveRange(q);
    return lr ? rectsToArray(lr.getClientRects()) : [];
  }
  if (q.selector) {
    var el;
    try { el = document.querySelector(q.selector); } catch (e) { el = null; }
    if (!el || inChrome(el)) return [];
    var rs = rectsToArray(el.getClientRects());
    if (!rs.length) { var b = el.getBoundingClientRect(); if (b.width || b.height) rs = [b]; }
    return clipRectsToFrame(el, rs);
  }
  return [];
}
// Paint transient overlay rects for queued comments and the in-progress pending
// target. Persistent note highlights are real <mark>s (see applyHighlights), not
// overlays. Never mutates the artifact DOM, so it is morph-safe.
export function drawRects(rects, cls) {
  rects.forEach(function (r) {
    if (r.width < 1 && r.height < 1) return;
    var d = document.createElement("div");
    d.className = cls ? "hlrect " + cls : "hlrect";
    d.style.left = r.left + "px";
    d.style.top = r.top + "px";
    d.style.width = r.width + "px";
    d.style.height = r.height + "px";
    ui.hls.appendChild(d);
  });
}
export function renderHighlights() {
  if (!ui.hls) return;
  ui.hls.innerHTML = "";
  appState.queue.forEach(function (q) {
    if (q.range || q.selector) drawRects(itemRects(q), "");
  });
  // Persistent "you asked here" boxes for diagram-element comment anchors (text
  // anchors are real <mark>s instead). These survive Mermaid re-renders because
  // they re-resolve from a stable {src,nodeKey} target.
  drawDiagramAnchors();
  // Draw the pending purple outline only once it is a committed "Ask agent"
  // target: a diagram/element (which has no native selection to show it) or after
  // the comment box is opened (pending.asked). A plain text selection *before*
  // choosing Ask agent relies on the browser's own selection, so we don't paint an
  // extra purple box during that phase.
  var pending = getPending();
  if (pending && (pending.kind === "el" || pending.asked)) drawRects(pendingRects(), "pending");
}
export function drawDiagramAnchors() {
  appState.highlights.forEach(function (h) {
    if (h.kind !== HighlightKind.COMMENT || !h.target) return;
    var el = resolveDiagramTarget(h.target);
    if (!el) return;
    var answered = hasAnswer(h.id);
    // A native SVG <title> gives the hover tooltip; the overlay box below is
    // purely visual (pointer-events:none) so it never blocks dragging the node.
    try {
      var ttl = el.querySelector(":scope > title[data-htmlit]");
      if (!ttl) { ttl = document.createElementNS("http://www.w3.org/2000/svg", "title"); ttl.setAttribute("data-htmlit", ""); el.insertBefore(ttl, el.firstChild); }
      ttl.textContent = (h.prompt ? "You asked: " + h.prompt : "You asked the agent about this") + (answered ? "  \u2014 click to see the answer" : "");
    } catch (e) {}
    clipRectsToFrame(el, rectsToArray(el.getClientRects())).forEach(function (r) {
      if (r.width < 1 && r.height < 1) return;
      var d = document.createElement("div");
      d.className = "hlrect cmbox" + (answered ? " answered" : "");
      d.style.left = r.left + "px"; d.style.top = r.top + "px";
      d.style.width = r.width + "px"; d.style.height = r.height + "px";
      // no pointer-events: the click/drag is handled by the SVG underneath, so a
      // drag still moves the node and a click routes through diagramClick().
      ui.hls.appendChild(d);
    });
  });
}
// Pin each queued comment onto the artifact at the start of its target.
export function renderMarkers() {
  if (!ui.markers) return;
  ui.markers.innerHTML = "";
  appState.queue.forEach(function (q, i) {
    if (!q.range && !q.selector) return;
    var rects = itemRects(q);
    if (!rects.length) return;
    var r = rects[0];
    var pin = document.createElement("div");
    pin.className = "marker";
    pin.textContent = String(i + 1);
    pin.title = (q.prompt || q.text || "Highlighted") + "  (click to remove)";
    pin.style.left = r.left + "px";
    pin.style.top = r.top + "px";
    pin.addEventListener("click", function () { removeItem(i); });
    ui.markers.appendChild(pin);
  });
}

/* comment rail (Google Docs)
   Each comment anchor gets a card in the right margin, vertically aligned to its
   highlighted text / diagram element. From the card the user reads the thread of
   asks, edits a previous ask (which re-sends it to the agent), adds a follow-up,
   jumps to the answer, or removes the anchor. Cards are *rebuilt* only when the
   model changes and merely *repositioned* on scroll/resize, so an open editor is
   never destroyed mid-typing. */

// Keep every overlay glued to its target as the page scrolls or resizes (the
// boxes are position:fixed, so without this they would drift off the item).
var repositionScheduled = false;
export function repositionOverlays() {
  renderMarkers();
  renderHighlights();
  repositionSelMenu();
  positionRail();
}
export function scheduleReposition() {
  if (repositionScheduled) return;
  repositionScheduled = true;
  requestAnimationFrame(function () {
    repositionScheduled = false;
    repositionOverlays();
  });
}

export function wireOverlayEvents() {
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);
}
