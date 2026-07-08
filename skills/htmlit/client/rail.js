import { HighlightKind, PANEL_W, RAIL_W, state as appState } from "./state.js";
import { ui } from "./dom.js";
import { highlightNew, revealElement } from "./content.js";
import { renderPills } from "./chat.js";
import { clipRectsToFrame, rectsToArray, scheduleReposition } from "./overlays.js";
import { answerForId, findHighlight, persistHighlights, removeHighlight, resolveDiagramTarget, resolveRange } from "./annotate.js";
import { send } from "./send.js";

var railOn = false;
var railRO = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(function () { scheduleRailPos(); }) : null;
var railPosPending = false;
var railBuilt = "";      // signature of the last rebuild, to avoid needless rebuilds
export function commentAnchors() { return appState.highlights.filter(function (h) { return h.kind === HighlightKind.COMMENT; }); }
export function railComments(h) { return (h.comments && h.comments.length) ? h.comments : (h.prompt ? [h.prompt] : []); }
// Read/clear a contenteditable box (our textareas are all contenteditable divs now).
export function ceText(el) { return el ? (el.innerText || el.textContent || "").replace(/\u00A0/g, " ").replace(/\s+$/, "").trim() : ""; }
export function ceClear(el) { if (el) el.innerHTML = ""; }
// Reflow the rail on the next frame (coalesced) - used by the card ResizeObserver.
export function scheduleRailPos() { if (railPosPending) return; railPosPending = true; requestAnimationFrame(function () { railPosPending = false; positionRail(); }); }
export function anchorTop(h) {
  var rects = [];
  if (h.range) { var lr = resolveRange(h.range); rects = lr ? rectsToArray(lr.getClientRects()) : []; }
  else if (h.target) { var el = resolveDiagramTarget(h.target); rects = el ? clipRectsToFrame(el, rectsToArray(el.getClientRects())) : []; }
  var top = Infinity;
  rects.forEach(function (r) { if (r.width || r.height) top = Math.min(top, r.top); });
  return top === Infinity ? null : top;
}
// Where the card sits vertically. Prefer the exact anchor rects; if the anchor is in
// a collapsed section (no rects), fall back to the nearest visible ancestor so the
// card stays in the rail instead of vanishing.
export function anchorTopResolved(h) {
  var t = anchorTop(h);
  if (t != null) return t;
  for (var n = anchorContainerEl(h); n && n !== document.body; n = n.parentElement) {
    if (!n.getBoundingClientRect) continue;
    var r = n.getBoundingClientRect();
    if (r.width || r.height) return r.top;
  }
  return null;
}
// Bring an anchor (or its answer) into view even when it sits in a collapsed
// section: reveal the section, re-place the cards for the new layout, then flash and
// scroll to the target on the next frame (once the reveal has laid out).
export function jumpTo(el) {
  if (!el) return;
  revealElement(el);
  positionRail();
  requestAnimationFrame(function () { positionRail(); highlightNew([el]); });
}
// The block that visually "owns" a comment anchor: the text's container element,
// or a diagram element's framed canvas. Its right edge is where the cards sit.
export function anchorContainerEl(h) {
  if (h.range) { try { return document.querySelector(h.range.container); } catch (e) { return null; } }
  if (h.target) {
    var el = resolveDiagramTarget(h.target);
    if (el && el.closest) { var frame = el.closest(".mermaid"); if (frame) return frame; }
    return el;
  }
  return null;
}
export function anchorRight(h) {
  var el = anchorContainerEl(h);
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return (r.width || r.height) ? r.right : null;
}
export function setRailMargin(on) {
  if (on === railOn) return;
  railOn = on;
  document.documentElement.style.setProperty("margin-right", (PANEL_W + (railOn ? RAIL_W : 0)) + "px");
  scheduleReposition();
}
export function anchorFlashEl(h) {
  if (h.range) { try { return document.querySelector('mark[data-htmlit-cm="' + (window.CSS && CSS.escape ? CSS.escape(h.id) : h.id) + '"]'); } catch (e) { return null; } }
  if (h.target) return resolveDiagramTarget(h.target);
  return null;
}
// The live CSS selector for an anchor's target (text container, or a diagram
// element's current id), used when queueing a comment for the agent.
export function anchorSelector(h) {
  if (h.range) return h.range.container;
  if (h.target) { var el = resolveDiagramTarget(h.target); if (el && el.id) return "#" + el.id; }
  return "";
}
// An anchor is a "draft" while it has any un-sent comment queued in the composer.
export function anchorHasDraft(h) {
  return appState.queue.some(function (q) { return q.commentId && q.commentId === h.id; });
}
// Queue a follow-up comment on an existing anchor. Like commitComment, this does
// NOT send immediately - it joins the composer queue as a draft and is delivered
// only when the user hits Send, so every card action follows the same model.
export function queueAnchorComment(h, text) {
  if (!text) return;
  h.comments = railComments(h).concat(text); h.prompt = text;
  appState.queue.push({ selector: anchorSelector(h), tag: h.range ? "text" : "g",
    text: h.text || (h.range && h.range.text) || "", prompt: text,
    range: h.range || null, target: h.target || null, commentId: h.id, _appended: true });
  persistHighlights(); renderPills(); rebuildRail(true);
}
export function makeCard(h) {
  var card = document.createElement("div");
  card.className = "card";
  card.setAttribute("data-id", h.id);
  var quote = document.createElement("div");
  quote.className = "card-q";
  quote.textContent = (h.range && h.range.text) || h.text || "(target)";
  quote.title = "Jump to the highlighted spot";
  quote.addEventListener("click", function () { jumpTo(anchorFlashEl(h)); });
  card.appendChild(quote);
  if (anchorHasDraft(h)) {
    card.classList.add("draft");
    var draftTag = document.createElement("div");
    draftTag.className = "card-draft";
    draftTag.textContent = "Queued \u00B7 press Send to deliver";
    card.appendChild(draftTag);
  }
  var thread = document.createElement("div");
  thread.className = "card-thread";
  railComments(h).forEach(function (text, i) {
    thread.appendChild(makeCmtRow(h, i, text));
  });
  card.appendChild(thread);
  var answerEl = answerForId(h.id);
  if (answerEl) {
    var ans = document.createElement("div");
    ans.className = "card-answer";
    var lbl = document.createElement("div"); lbl.className = "card-answer-lbl"; lbl.textContent = "Agent";
    var body = document.createElement("div"); body.className = "card-answer-body rich";
    // Render the answer's own HTML (lists, emphasis, code) rather than flattening it
    // to text - a numbered list would otherwise lose its numbers. Strip ids so the
    // clone never duplicates an id that is live in the document.
    var clone = answerEl.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("[id]"), function (n) { n.removeAttribute("id"); });
    body.innerHTML = clone.innerHTML;
    var jump = document.createElement("button"); jump.className = "card-answer-jump"; jump.textContent = "View in document \u2192";
    jump.addEventListener("click", function () { jumpTo(answerForId(h.id)); });
    ans.appendChild(lbl); ans.appendChild(body); ans.appendChild(jump);
    card.appendChild(ans);
  }
  var add = document.createElement("div");
  add.className = "card-add";
  var ta = document.createElement("div");
  ta.className = "ce";
  ta.setAttribute("contenteditable", "true");
  ta.setAttribute("role", "textbox");
  ta.setAttribute("aria-multiline", "true");
  ta.setAttribute("data-ph", "Reply or add a comment\u2026");
  var addBtn = document.createElement("button");
  addBtn.className = "btn card-send"; addBtn.textContent = "Queue";
  function submitAdd() {
    var t = ceText(ta); if (!t) { ta.focus(); return; }
    queueAnchorComment(h, t); ceClear(ta);
  }
  addBtn.addEventListener("click", submitAdd);
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAdd(); } });
  add.appendChild(ta); add.appendChild(addBtn);
  card.appendChild(add);
  var rm = document.createElement("button");
  rm.className = "card-remove"; rm.title = "Remove this comment"; rm.innerHTML = "&times;";
  rm.addEventListener("click", function () { removeHighlight(h.id); rebuildRail(true); });
  card.appendChild(rm);
  return card;
}
export function makeCmtRow(h, i, text) {
  var row = document.createElement("div");
  row.className = "cmt";
  var span = document.createElement("span");
  span.className = "cmt-txt"; span.textContent = text;
  var edit = document.createElement("button");
  edit.className = "cmt-edit"; edit.title = "Edit this comment"; edit.textContent = "\u270E";
  edit.addEventListener("click", function () {
    var editor = document.createElement("div");
    editor.className = "cmt-editta ce";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.textContent = text;
    var save = document.createElement("button"); save.className = "btn"; save.textContent = "Save";
    var cancel = document.createElement("button"); cancel.className = "btn ghost"; cancel.textContent = "Cancel";
    function editorText() { return (editor.innerText || editor.textContent || "").replace(/\u00A0/g, " ").replace(/\s+$/, "").trim(); }
    function done(newText) {
      if (newText != null && newText !== text) {
        var arr = railComments(h).slice(); arr[i] = newText; h.comments = arr;
        if (i === arr.length - 1) h.prompt = newText;
        // Queue the edit like any other comment - it's delivered on the next Send.
        appState.queue.push({ selector: anchorSelector(h), tag: h.range ? "text" : "g",
          text: h.text || (h.range && h.range.text) || "", prompt: newText,
          range: h.range || null, target: h.target || null, commentId: h.id,
          _edited: true, _idx: i, _prev: text });
        persistHighlights(); renderPills();
      }
      rebuildRail(true);
    }
    save.addEventListener("click", function () { var v = editorText(); if (v) done(v); else editor.focus(); });
    cancel.addEventListener("click", function () { done(null); });
    editor.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save.click(); } if (e.key === "Escape") { e.preventDefault(); cancel.click(); } });
    row.classList.add("editing");
    row.innerHTML = ""; var rowBtns = document.createElement("div"); rowBtns.className = "cmt-editrow";
    rowBtns.appendChild(cancel); rowBtns.appendChild(save);
    row.appendChild(editor); row.appendChild(rowBtns);
    setTimeout(function () {
      editor.focus();
      try { var r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
    }, 0);
  });
  row.appendChild(span); row.appendChild(edit);
  return row;
}
// Rebuild all cards from the model (force=true always rebuilds).
export function rebuildRail(force) {
  if (!ui.rail) return;
  var anchors = commentAnchors();
  setRailMargin(anchors.length > 0);
  var sig = anchors.map(function (h) { var a = answerForId(h.id); return h.id + ":" + railComments(h).join("\u0001") + ":" + (a ? (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) : ""); }).join("|");
  if (!force && sig === railBuilt) { positionRail(); return; }
  railBuilt = sig;
  if (railRO) railRO.disconnect();
  ui.rail.innerHTML = "";
  anchors.forEach(function (h) { ui.rail.appendChild(makeCard(h)); });
  if (railRO) Array.prototype.forEach.call(ui.rail.children, function (c) { railRO.observe(c); });
  positionRail();
}
// Reposition cards vertically to track their anchors, with downward collision
// avoidance (Google-Docs style). Cards whose anchor can't be resolved are hidden.
export function positionRail() {
  if (!ui.rail) return;
  var cards = Array.prototype.slice.call(ui.rail.children);
  var items = [], contentRight = 0;
  cards.forEach(function (card) {
    var h = findHighlight(card.getAttribute("data-id"));
    var top = h ? anchorTopResolved(h) : null;
    if (top == null) { card.style.display = "none"; return; }
    card.style.display = "";
    var right = h ? anchorRight(h) : null;
    if (right != null) contentRight = Math.max(contentRight, right);
    items.push({ card: card, top: top });
  });
  if (!items.length) { updateRailScrollRoom(0); return; }
  // Horizontal: sit the cards just to the right of the content column (Google-Docs
  // style) rather than out by the panel, but never let them slide under the panel.
  var cardW = items[0].card.offsetWidth || 276;
  var left = (contentRight || (window.innerWidth - PANEL_W - RAIL_W)) + 14;
  var maxLeft = window.innerWidth - PANEL_W - cardW - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < 12) left = 12;
  // Vertical: stack downward with collision avoidance, anchored in DOCUMENT space
  // (no viewport floor). Pinning the first card to the viewport top would make the
  // stack scroll-dependent - the page would grow as you scrolled and the lower
  // cards could never be reached. Document-anchored, the whole stack tracks the
  // page: scrolling (the page or the rail) moves the cards up/down to reveal them.
  items.sort(function (a, b) { return a.top - b.top; });
  var cursor = -Infinity, maxBottom = 0;
  items.forEach(function (it) {
    var top = Math.max(it.top, cursor);
    it.card.style.left = left + "px";
    it.card.style.top = top + "px";
    cursor = top + it.card.offsetHeight + 10;
    maxBottom = Math.max(maxBottom, top + window.pageYOffset + it.card.offsetHeight);
  });
  // A tall card near the bottom of a short page can extend past the end of the
  // document, with no scroll room to reach it. Grow the page's scrollable height
  // (via html padding-bottom) just enough that every card can be scrolled fully
  // into view. maxBottom is document-relative, so it is stable across scroll.
  updateRailScrollRoom(maxBottom);
}
var railPad = 0;
export function updateRailScrollRoom(maxCardBottom) {
  var el = document.documentElement;
  var natural = el.scrollHeight - railPad;
  var pad = Math.max(0, Math.ceil(maxCardBottom + 40 - natural));
  if (Math.abs(pad - railPad) > 1) { railPad = pad; el.style.setProperty("padding-bottom", pad + "px"); }
}

/* send */
