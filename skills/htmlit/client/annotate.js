import { HighlightKind, KEY, PANEL_W, state as appState } from "./state.js";
import { host, root, ui } from "./dom.js";
import { api, cssPath, inChrome } from "./util.js";
import { highlightNew } from "./content.js";
import { renderPills } from "./chat.js";
import { clipRectsToFrame, rectsToArray, renderHighlights } from "./overlays.js";
import { ceClear, ceText, rebuildRail, anchorFlashEl, jumpTo } from "./rail.js";

var pending = null;
var selMenuOpen = false;
var hlSeq = 0;

export function getPending() { return pending; }
export function hasPendingOrMenu() { return !!(pending || selMenuOpen); }

export function annotateEl(el) {
  if (appState.ended || !el || inChrome(el)) { clearPending(); return; }
  buildElPending(el);
  openSelMenu();
}
// A click (not a drag) on a diagram node/edge. If it already carries a comment
// anchor: jump to the answer when there is one, else open the anchor's menu
// (comment again / remove). Otherwise start a fresh comment on it.
export function diagramClick(el) {
  if (appState.ended || !el || inChrome(el)) { clearPending(); return; }
  var key = diagramKeyOf(el);
  var anchor = key && findAnchorByTarget(key);
  if (anchor) {
    var ans = answerForId(anchor.id);
    if (ans) { highlightNew([ans]); clearPending(); return; }
    pending = { kind: "hl", id: anchor.id, markKind: HighlightKind.COMMENT, text: anchor.prompt || anchor.text || "", range: null, target: anchor.target };
    openSelMenu();
    return;
  }
  annotateEl(el);
}

// text range <-> stable char offsets (re-resolvable after a morph)
export function walkText(container, cb) {
  var w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  var n;
  while ((n = w.nextNode())) {
    var p = n.parentNode;
    if (!p || inChrome(p) || p.nodeName === "SCRIPT" || p.nodeName === "STYLE") continue;
    if (cb(n) === false) return;
  }
}
export function charIndexOf(container, node, offset) {
  var bnd = document.createRange();
  try { bnd.setStart(node, offset); bnd.collapse(true); } catch (e) { return 0; }
  var total = 0, res = null;
  walkText(container, function (t) {
    var len = t.nodeValue.length, cEnd;
    try { cEnd = bnd.comparePoint(t, len); } catch (e) { cEnd = -1; }
    if (cEnd <= 0) { total += len; return; }          // whole node before the boundary
    var cStart;
    try { cStart = bnd.comparePoint(t, 0); } catch (e) { cStart = 1; }
    if (cStart >= 0) { res = total; return false; }    // boundary at/before this node's start
    res = total + (node === t ? offset : 0);           // boundary falls inside this node
    return false;
  });
  return res != null ? res : total;
}
export function charRange(container, start, end) {
  var range = document.createRange();
  try { range.setStart(container, 0); } catch (e) { return null; }
  var idx = 0, started = false, ok = false;
  walkText(container, function (t) {
    var len = t.nodeValue.length;
    if (!started && idx + len >= start) { range.setStart(t, Math.max(0, Math.min(len, start - idx))); started = true; }
    if (started && idx + len >= end) { range.setEnd(t, Math.max(0, Math.min(len, end - idx))); ok = true; return false; }
    idx += len;
  });
  if (!started) return null;
  if (!ok) { try { range.setEnd(container, container.childNodes.length); } catch (e) {} }
  return range;
}
export function resolveRange(info) {
  if (!info || !info.container) return null;
  var container;
  try { container = document.querySelector(info.container); } catch (e) { container = null; }
  if (!container || inChrome(container)) return null;
  var range = charRange(container, info.start, info.end);
  if (!range) return null;
  // Guard against a stale anchor drifting onto the wrong content. The artifact can
  // change between sessions/morphs (a section replaced, e.g. by a code block), and
  // the stored selector + char offsets then resolve to *different* text. If the text
  // no longer matches what was anchored, treat the anchor as orphaned and don't
  // resolve it - so it is neither drawn on the wrong place nor wrapped there.
  if (info.text) {
    var now = String(range).replace(/\s+/g, " ").trim().slice(0, 300);
    if (now !== info.text) return null;
  }
  return range;
}
export function rangeInfo(range) {
  var common = range.commonAncestorContainer;
  var container = common.nodeType === 1 ? common : common.parentElement;
  // Anchor offsets against a stable artifact element, never one of our own note
  // <mark> wrappers (those come and go), so the range still resolves after a morph.
  var hl = container && container.closest && container.closest("mark.htmlit-hl");
  if (hl && hl.parentElement) container = hl.parentElement;
  if (!container || inChrome(container)) return null;
  var start = charIndexOf(container, range.startContainer, range.startOffset);
  var end = charIndexOf(container, range.endContainer, range.endOffset);
  if (end < start) { var tmp = start; start = end; end = tmp; }
  if (end <= start) return null;
  return { container: cssPath(container), start: start, end: end, text: String(range).replace(/\s+/g, " ").trim().slice(0, 300) };
}

// pending target (text selection, existing highlight, or diagram element)
export function inMermaid(node) {
  var el = node && (node.nodeType === 1 ? node : node.parentElement);
  return !!(el && el.closest && el.closest(".mermaid"));
}
// A stable key for a clicked diagram node/edge: the diagram's source text plus the
// element's id with the (per-render) svg-id prefix stripped, so it re-resolves even
// after Mermaid re-renders the SVG (theme switch, morph) with a fresh svg id.
export function diagramKeyOf(el) {
  var frame = el && el.closest && el.closest(".mermaid");
  if (!frame || !frame.dataset || !frame.dataset.htmlitSrc) return null;
  var svg = frame.querySelector("svg");
  var idEl = el.id ? el : (el.closest ? el.closest("[id]") : null);
  if (!svg || !idEl || (idEl.closest && !idEl.closest(".mermaid"))) return null;
  var prefix = svg.id ? svg.id + "-" : "";
  var id = idEl.id || "";
  var key = prefix && id.indexOf(prefix) === 0 ? id.slice(prefix.length) : id;
  if (!key) return null;
  return { src: frame.dataset.htmlitSrc, nodeKey: key };
}
export function resolveDiagramTarget(t) {
  if (!t || !t.src || !t.nodeKey) return null;
  var frames = document.querySelectorAll(".mermaid");
  for (var i = 0; i < frames.length; i++) {
    var f = frames[i];
    if (!f.dataset || f.dataset.htmlitSrc !== t.src) continue;
    var svg = f.querySelector("svg");
    if (!svg) return null;
    var prefix = svg.id ? svg.id + "-" : "";
    var els = svg.querySelectorAll("[id]");
    for (var j = 0; j < els.length; j++) {
      var id = els[j].id;
      var s = prefix && id.indexOf(prefix) === 0 ? id.slice(prefix.length) : id;
      if (s === t.nodeKey) return els[j];
    }
    return null;
  }
  return null;
}
export function pendingRects() {
  if (!pending) return [];
  if (pending.range) {
    var lr = resolveRange(pending.range);
    return lr ? rectsToArray(lr.getClientRects()) : [];
  }
  if (pending.target) {
    var te = resolveDiagramTarget(pending.target);
    return te ? clipRectsToFrame(te, rectsToArray(te.getClientRects())) : [];
  }
  if (pending.kind === "el" && pending.el && document.contains(pending.el)) return rectsToArray(pending.el.getClientRects());
  return [];
}
export function buildTextPending(info) {
  pending = { kind: "text", tag: "text", text: info.text, range: info };
  renderHighlights();
}
export function buildElPending(el) {
  var tag = el.tagName ? el.tagName.toLowerCase() : "el";
  var text = (el.innerText || el.textContent || tag).replace(/\s+/g, " ").trim().slice(0, 120) || tag;
  pending = { kind: "el", tag: tag, text: text, selector: cssPath(el), el: el, diagram: diagramKeyOf(el) };
  renderHighlights();
}
// Clicking an existing mark (a note highlight or a comment anchor) -> a pending
// that can be commented again or removed.
export function buildHlPending(hl) {
  var id = hl.getAttribute("data-htmlit-hl") || hl.getAttribute("data-htmlit-cm");
  var h = findHighlight(id);
  if (!h) return false;
  pending = { kind: "hl", id: h.id, markKind: h.kind || HighlightKind.NOTE, text: (h.range && h.range.text) || h.prompt || "", range: h.range || null, target: h.target || null };
  renderHighlights();
  return true;
}

/* persistent marks (local, saved with the file, not sent to the agent).
   Two kinds, both real <mark> in the artifact DOM so they appear in the HTML/PDF
   export and re-apply from stored ranges after every morph:
     - note    -> <mark class="htmlit-hl"> (solid yellow), from the Highlight action
     - comment -> <mark class="htmlit-cm"> (light accent underline), left behind on a
                  span you asked the agent about, its tooltip showing what you asked. */
export function findHighlight(id) {
  for (var i = 0; i < appState.highlights.length; i++) if (appState.highlights[i].id === id) return appState.highlights[i];
  return null;
}
export function persistHighlights() {
  api("/api/" + KEY + "/highlights", { highlights: appState.highlights.map(function (h) {
    return { id: h.id, kind: h.kind || HighlightKind.NOTE, prompt: h.prompt || "", comments: h.comments || null, range: h.range || null, target: h.target || null, text: h.text || "" };
  }) }).catch(function () {});
}
export function unwrapHighlights(root) {
  (root || document).querySelectorAll("mark.htmlit-hl, mark.htmlit-cm").forEach(function (m) {
    if (inChrome(m)) return;
    var p = m.parentNode; if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    if (p.normalize) p.normalize();
  });
}
// Wrap every text-node slice a range covers in its own <mark> (surroundContents
// only accepts a single text node, so this also handles multi-element selections).
export function wrapRange(range, id, cls, attr, title) {
  var root = range.commonAncestorContainer;
  if (root.nodeType === 3) root = root.parentNode;
  if (!root) return;
  var segs = [];
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
    segs.push({ node: range.startContainer, from: range.startOffset, to: range.endOffset });
  } else {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      if (inChrome(n.parentNode)) continue;
      var intersects;
      try { intersects = range.intersectsNode(n); } catch (e) { intersects = false; }
      if (!intersects) continue;
      var from = (n === range.startContainer) ? range.startOffset : 0;
      var to = (n === range.endContainer) ? range.endOffset : n.nodeValue.length;
      if (to > from) segs.push({ node: n, from: from, to: to });
    }
  }
  // wrap last-to-first so earlier segments' offsets stay valid as nodes split
  for (var i = segs.length - 1; i >= 0; i--) {
    var s = segs[i];
    try {
      var r = document.createRange();
      r.setStart(s.node, s.from); r.setEnd(s.node, s.to);
      var mk = document.createElement("mark");
      mk.className = cls;
      mk.setAttribute(attr, id);
      if (title) mk.setAttribute("title", title);
      r.surroundContents(mk);
    } catch (e) {}
  }
}
export function applyHighlights() {
  unwrapHighlights();
  appState.highlights.forEach(function (h) {
    var range = resolveRange(h.range);
    if (!range) return;
    if (h.kind === HighlightKind.COMMENT) {
      // If the agent has already answered this comment, mark the anchor as
      // "answered" (a stronger style) and change its tooltip to invite the jump.
      var answered = hasAnswer(h.id);
      var title = h.prompt ? "You asked: " + h.prompt : "You asked the agent about this";
      if (answered) title += "  \u2014 click to see the answer";
      wrapRange(range, h.id, answered ? "htmlit-cm htmlit-cm-answered" : "htmlit-cm", "data-htmlit-cm", title);
    } else {
      wrapRange(range, h.id, "htmlit-hl", "data-htmlit-hl", "");
    }
  });
  renderHighlights(); // also refresh diagram-element anchor boxes
}
export function hasAnswer(id) {
  if (!id) return false;
  var sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
  try { return !!document.querySelector('[data-htmlit-answer-for="' + sel + '"]'); } catch (e) { return false; }
}
export function answerForId(id) {
  if (!id) return null;
  var sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
  var el;
  try { el = document.querySelector('[data-htmlit-answer-for="' + sel + '"]'); } catch (e) { el = null; }
  return el && !inChrome(el) ? el : null;
}
export function addHighlight(range) {
  var id = "h" + Date.now().toString(36) + (hlSeq++);
  appState.highlights.push({ id: id, kind: HighlightKind.NOTE, prompt: "", range: { container: range.container, start: range.start, end: range.end, text: range.text } });
  applyHighlights();
  persistHighlights();
}
// Leave (or refresh) a "you asked here" comment anchor on a commented span or diagram
// element. One anchor per target: re-asking updates the tooltip. The anchor id is the
// same commentId sent to the agent, so its answer can link back.
export function newAnchorId() { return "c" + Date.now().toString(36) + (hlSeq++); }
export function sameTarget(a, b) { return a && b && a.src === b.src && a.nodeKey === b.nodeKey; }
export function findAnchorBySpan(range) {
  for (var i = 0; i < appState.highlights.length; i++) {
    var h = appState.highlights[i];
    if (h.kind === HighlightKind.COMMENT && h.range && h.range.container === range.container && h.range.start === range.start && h.range.end === range.end) return h;
  }
  return null;
}
export function findAnchorByTarget(target) {
  for (var i = 0; i < appState.highlights.length; i++) {
    var h = appState.highlights[i];
    if (h.kind === HighlightKind.COMMENT && sameTarget(h.target, target)) return h;
  }
  return null;
}
export function addCommentAnchor(range, prompt, id) {
  if (!range || !range.container) return;
  var existing = findAnchorBySpan(range);
  if (existing) { existing.prompt = prompt; existing.comments = (existing.comments || []).concat(prompt); return; }
  appState.highlights.push({ id: id || newAnchorId(), kind: HighlightKind.COMMENT, prompt: prompt || "", comments: [prompt || ""],
    range: { container: range.container, start: range.start, end: range.end, text: range.text } });
}
// A comment anchor on a diagram node/edge: no text range, just a stable target.
export function addCommentAnchorEl(target, text, prompt, id) {
  if (!target || !target.src) return;
  var existing = findAnchorByTarget(target);
  if (existing) { existing.prompt = prompt; existing.comments = (existing.comments || []).concat(prompt); return; }
  appState.highlights.push({ id: id || newAnchorId(), kind: HighlightKind.COMMENT, prompt: prompt || "", comments: [prompt || ""], range: null,
    target: { src: target.src, nodeKey: target.nodeKey }, text: text || "" });
}
export function removeHighlight(id) {
  var i = appState.highlights.findIndex ? appState.highlights.findIndex(function (h) { return h.id === id; }) : -1;
  if (i < 0) { for (var k = 0; k < appState.highlights.length; k++) if (appState.highlights[k].id === id) { i = k; break; } }
  if (i < 0) return;
  appState.highlights.splice(i, 1);
  for (var j = appState.queue.length - 1; j >= 0; j--) if (appState.queue[j].commentId === id) appState.queue.splice(j, 1);
  applyHighlights();
  persistHighlights();
  renderPills();
  rebuildRail(true);
}
// The agent's answer block for a comment anchor, if it has been added yet. The
// agent tags it with data-htmlit-answer-for="<commentId>" (= the anchor's id).
export function answerForMark(mark) {
  var id = mark && mark.getAttribute && mark.getAttribute("data-htmlit-cm");
  if (!id) return null;
  var sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
  var el;
  try { el = document.querySelector('[data-htmlit-answer-for="' + sel + '"]'); } catch (e) { el = null; }
  return el && !inChrome(el) ? el : null;
}

// floating select menu
export function placeSelMenu(r) {
  ui.selmenu.style.display = "flex";
  var mw = ui.selmenu.offsetWidth || 74, mh = ui.selmenu.offsetHeight || 38;
  var left = r.left + r.width / 2 - mw / 2;
  var top = r.top - mh - 8;
  if (top < 6) top = r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - PANEL_W - mw - 8));
  top = Math.max(6, Math.min(top, window.innerHeight - mh - 6));
  ui.selmenu.style.left = left + "px";
  ui.selmenu.style.top = top + "px";
  selMenuOpen = true;
}
export function openSelMenu() {
  var rects = pendingRects();
  if (!rects.length) { clearPending(); return; }
  // Which actions apply: text -> highlight+comment; existing highlight -> comment+remove;
  // an element/diagram target -> comment only (a text note doesn't apply there).
  var kind = pending ? pending.kind : "";
  ui.selMark.style.display = kind === "text" ? "" : "none";
  ui.selComment.style.display = "";
  ui.selRemove.style.display = kind === "hl" ? "" : "none";
  placeSelMenu(rects[0]);
}
export function hideSelMenu() { selMenuOpen = false; ui.selmenu.style.display = "none"; }
export function repositionSelMenu() {
  if (!selMenuOpen) return;
  var rects = pendingRects();
  if (rects.length) placeSelMenu(rects[0]);
}

// highlight (note) + comment (to agent) + remove
export function commitHighlight() {
  if (!pending || pending.kind !== "text") return;
  addHighlight(pending.range);
  clearPending();
}
export function commitRemove() {
  if (!pending || pending.kind !== "hl") return;
  removeHighlight(pending.id);
  clearPending();
}
export function openComment() {
  if (!pending) return;
  pending.asked = true; // now show the pending purple outline (see renderHighlights)
  hideSelMenu();
  ui.popLabel.textContent = (pending.kind === "text" || pending.kind === "hl") ? "Comment on the highlighted text" : "Comment on this";
  ceClear(ui.popText);
  ui.pop.style.display = "block";
  var rects = pendingRects();
  var r = rects.length ? rects[0] : { left: 120, top: 120, bottom: 140 };
  var w = 300;
  ui.pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - w - 8)) + "px";
  ui.pop.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 190)) + "px";
  renderHighlights(); // keep the pending outline visible once the selection collapses
  setTimeout(function () { ui.popText.focus(); }, 0);
}
// A comment always goes to the agent (unlike a highlight, which is a local note).
// A ranged text comment or a diagram-element comment carries a stable commentId:
// the "you asked here" anchor uses it as its id, and the agent tags the answer
// block (data-htmlit-answer-for) with it, so clicking the anchor jumps to that answer.
export function commentItemFromPending(prompt) {
  // text span (a fresh selection, or re-commenting an existing text anchor)
  if (pending.range) {
    var rng = { container: pending.range.container, start: pending.range.start, end: pending.range.end, text: pending.range.text };
    var ex = findAnchorBySpan(rng);
    return { selector: pending.range.container, tag: "text", text: pending.text, prompt: prompt, note: false, range: rng, target: null, commentId: (ex && ex.id) || newAnchorId() };
  }
  // diagram node/edge (a fresh click, or re-commenting an existing diagram anchor)
  var diag = pending.diagram || pending.target || null;
  if (diag && diag.src) {
    var exd = findAnchorByTarget(diag);
    return { selector: pending.selector || "", tag: pending.tag || "g", text: pending.text, prompt: prompt, note: false, range: null, target: { src: diag.src, nodeKey: diag.nodeKey }, commentId: (exd && exd.id) || newAnchorId() };
  }
  // a plain non-diagram element: comment reaches the agent but leaves no anchor
  return { selector: pending.selector, tag: pending.tag, text: pending.text, prompt: prompt, note: false, range: null, target: null, commentId: "" };
}
export function commitComment() {
  if (!pending) return;
  var prompt = ceText(ui.popText);
  if (!prompt) { ui.popText.focus(); return; }
  var item = commentItemFromPending(prompt);
  appState.queue.push(item);
  // Show the comment card in the rail immediately (as a draft) - before Send
  // delivers it - so queueing an ask feels like Google Docs. The anchor carries
  // the item's commentId, so Send just marks it delivered rather than re-adding.
  if (item.range && item.range.container) {
    item._appended = !!findAnchorBySpan(item.range);
    addCommentAnchor(item.range, prompt, item.commentId);
  } else if (item.target && item.target.src) {
    item._appended = !!findAnchorByTarget(item.target);
    addCommentAnchorEl(item.target, item.text, prompt, item.commentId);
  }
  clearPending();
  applyHighlights();
  persistHighlights();
  renderPills();
  rebuildRail(true);
}
export function clearPending() {
  pending = null;
  hideSelMenu();
  ui.pop.style.display = "none";
  var s = window.getSelection && window.getSelection();
  if (s) { try { s.removeAllRanges(); } catch (e) {} }
  renderHighlights();
}

// Passive, Google-Docs-style: a text selection pops the menu; a plain click on an
// existing highlight offers Comment/Remove; any other click dismisses. We never
// preventDefault, so the artifact stays fully interactive. Diagram nodes are
// handled in the SVG pointer logic (a click annotates, a drag pans/moves).
export function onArtifactMouseUp(target) {
  var el = target && (target.nodeType === 1 ? target : target.parentElement);
  // Diagram interactions are owned by the SVG pointer logic (a click opens the
  // comment bubble in endDrag, a drag pans/moves). Bail out so this handler does
  // not clear the bubble the diagram click just opened.
  if (el && el.closest && el.closest(".mermaid")) return;
  var sel = window.getSelection();
  var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (range && !range.collapsed && String(sel).trim() &&
      !inChrome(range.commonAncestorContainer) && !inMermaid(range.commonAncestorContainer)) {
    var info = rangeInfo(range);
    if (info) { buildTextPending(info); openSelMenu(); return; }
  }
  // collapsed click: on one of our marks (note or comment anchor) -> menu, unless
  // it is a comment anchor whose answer already exists, in which case clicking it
  // jumps to (and flashes) that answer instead.
  var hl = el && el.closest && el.closest("mark.htmlit-hl, mark.htmlit-cm");
  if (hl && !inChrome(hl)) {
    var ans = answerForMark(hl);
    if (ans) { highlightNew([ans]); clearPending(); return; }
    if (buildHlPending(hl)) openSelMenu();
    return;
  }
  // Symmetric to the anchor -> answer jump above: a plain click on an agent answer
  // block's "You asked:" header (the block element itself, not its body content)
  // jumps back to the spot the user asked about and flashes it. Clicks on the answer
  // body target a child element, so the answer text stays selectable and commentable.
  var ansBlock = el && el.matches && el.matches("[data-htmlit-answer]") ? el : null;
  if (ansBlock && !inChrome(ansBlock)) {
    var askId = ansBlock.getAttribute("data-htmlit-answer-for");
    var askHl = askId ? findHighlight(askId) : null;
    var askEl = askHl ? anchorFlashEl(askHl) : null;
    if (askEl) { jumpTo(askEl); clearPending(); return; }
  }
  if (pending || selMenuOpen) clearPending();
}

export function wireAnnotationEvents() {
  document.addEventListener("mouseup", function (e) {
    if (appState.ended) return;
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(host) !== -1) return; // the panel / menu / popover
    setTimeout(function () { onArtifactMouseUp(path[0]); }, 0); // let the selection finalize
  });
  // Starting a fresh press elsewhere dismisses an open menu/pending.
  document.addEventListener("mousedown", function (e) {
    if (appState.ended || !(pending || selMenuOpen)) return;
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(host) !== -1) return;
    var t = path[0];
    var el = t && (t.nodeType === 1 ? t : t.parentElement);
    if (el && el.closest && el.closest(".mermaid")) return; // the SVG handler owns diagram clicks
    if (el && el.closest && el.closest("mark.htmlit-hl, mark.htmlit-cm")) return; // let the mouseup decide (comment/remove)
    clearPending();
  });
}
