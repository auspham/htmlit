import { state as appState } from "./state.js";
import { inChrome } from "./util.js";
import { root, shadow, ui } from "./dom.js";
import { theme } from "./theme.js";
import { renderHighlights, scheduleReposition } from "./overlays.js";
import { positionRail } from "./rail.js";
import { makeCopyButton, makeLinenos, lineCount, highlightMermaidSource } from "./codeblock.js";
import { clearPending, diagramClick } from "./annotate.js";

export const diagramLayouts = {}; // diagram source text -> saved arrangement
export const diagramRegistry = []; // { svg, fit } per live diagram, for export/print

/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {{left: number, top: number, right: number, bottom: number}} Rect
 * @typedef {{rect: (function(): Rect), center: (function(): Point),
 *            border: (function(Point): Point)}} DiagramNode
 */

/**
 * Read an element's `translate(x, y)`, defaulting to the origin.
 * @param {Element} el
 * @returns {Point}
 */
export function mTranslate(el) {
  var t = el && el.getAttribute && el.getAttribute("transform");
  var m = t && /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)/.exec(t);
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}
export function mSetTranslate(el, x, y) { el.setAttribute("transform", "translate(" + x + "," + y + ")"); }
export function mEndpoints(d) {
  var n = (d || "").match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!n || n.length < 4) return null;
  return {
    start: { x: parseFloat(n[0]), y: parseFloat(n[1]) },
    end: { x: parseFloat(n[n.length - 2]), y: parseFloat(n[n.length - 1]) },
  };
}
// Parse an SVG path into its coordinate pairs plus a replay sequence, so the path
// can be re-emitted with new coordinates but the SAME commands - which is how we
// preserve an edge's original curve while moving its endpoints. Every command we
// support (M/L/C/Q/S/T) takes coordinate pairs, so points map one-to-one onto the
// numbers. Relative commands, H/V (single coordinate) and arcs (A, mixed params)
// are unsupported: return null so the caller falls back to a straight rebuild.
export function mParsePath(d) {
  if (!d) return null;
  var toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!toks) return null;
  var pts = [], seq = [], i = 0;
  while (i < toks.length) {
    var t = toks[i];
    if (/[a-zA-Z]/.test(t)) {
      if ("MLCQST".indexOf(t) === -1) return null; // relative / H / V / A / Z: bail
      seq.push({ c: t }); i++;
    } else {
      if (i + 1 >= toks.length) return null;
      pts.push({ x: parseFloat(toks[i]), y: parseFloat(toks[i + 1]) });
      seq.push({ p: pts.length - 1 }); i += 2;
    }
  }
  return pts.length >= 2 ? { pts: pts, seq: seq } : null;
}
// Re-emit a parsed path (from mParsePath) with a fresh set of points, shifting into
// the element's own frame by subtracting its frame offset (ox, oy).
export function mPathFromSeq(seq, pts, ox, oy) {
  var out = "";
  for (var i = 0; i < seq.length; i++) {
    if (seq[i].c != null) out += seq[i].c;
    else { var p = pts[seq[i].p]; out += (p.x - ox) + "," + (p.y - oy) + " "; }
  }
  return out;
}
// The similarity transform (translate + rotate + uniform scale) that maps the segment
// p0->p1 onto aS->aT. Applied to every point of a path it rigidly carries the whole
// shape - its curvature and, for parallel edges, their separation - onto the moved
// endpoints, so nothing collapses to a straight line. Null when p0==p1 (degenerate).
export function mFitTransform(p0, p1, aS, aT) {
  var d0x = p1.x - p0.x, d0y = p1.y - p0.y, l2 = d0x * d0x + d0y * d0y;
  if (l2 < 1e-6) return null;
  var d1x = aT.x - aS.x, d1y = aT.y - aS.y;
  var a = (d1x * d0x + d1y * d0y) / l2, b = (d1y * d0x - d1x * d0y) / l2;
  return function (p) {
    var vx = p.x - p0.x, vy = p.y - p0.y;
    return { x: aS.x + a * vx - b * vy, y: aS.y + b * vx + a * vy };
  };
}
export function mRectDist(pt, r) {
  // 0 when pt is inside the box; otherwise the straight-line gap to its border.
  var dx = Math.max(r.left - pt.x, 0, pt.x - r.right);
  var dy = Math.max(r.top - pt.y, 0, pt.y - r.bottom);
  return Math.hypot(dx, dy);
}
// How close (in diagram user units) an edge endpoint must sit to a shape's bounding
// box to count as "attached" to it. This absorbs the small gap Mermaid leaves for
// the arrow marker. An endpoint farther than this from every node is an inter-
// subgraph connection that attaches to a cluster border, not an inner node.
export const ANCHOR_SLACK = 12;
/**
 * The node an edge endpoint belongs to. An endpoint sits on its node's shape
 * border, so rank by distance to the bounding box (0 if inside), not to the
 * center: a diamond attaches its edges at a far tip that can be closer to a
 * neighbor's center than its own. Center distance only breaks near-ties.
 * @param {Point} pt
 * @param {DiagramNode[]} nodes
 * @returns {DiagramNode|null}
 */
export function mNearest(pt, nodes) {
  var best = null, bestRd = Infinity, bestCd = Infinity;
  for (var i = 0; i < nodes.length; i++) {
    var rd = mRectDist(pt, nodes[i].rect());
    var c = nodes[i].center(), dx = c.x - pt.x, dy = c.y - pt.y, cd = dx * dx + dy * dy;
    var better = rd < bestRd - 1 || (rd <= bestRd + 1 && cd < bestCd);
    if (better) { best = nodes[i]; bestRd = rd; bestCd = cd; }
  }
  return best;
}
/**
 * Where the segment center->toward exits the bounding rect (the edge anchor).
 * @param {Point} center
 * @param {Point} toward
 * @param {Rect} rect
 * @returns {Point}
 */
export function mBorder(center, toward, rect) {
  var dx = toward.x - center.x, dy = toward.y - center.y;
  if (!dx && !dy) return { x: center.x, y: center.y };
  var tx = dx > 0 ? (rect.right - center.x) / dx : dx < 0 ? (rect.left - center.x) / dx : Infinity;
  var ty = dy > 0 ? (rect.bottom - center.y) / dy : dy < 0 ? (rect.top - center.y) / dy : Infinity;
  var t = Math.max(0, Math.min(tx, ty));
  return { x: center.x + dx * t, y: center.y + dy * t };
}
// Parse a node's real outline once so edges anchor on the actual shape, not its
// bounding box: a diamond/hexagon/parallelogram (drawn as <polygon>), a circle
// or an ellipse. Points are kept in the node's local frame (relative to its
// translate) so they ride along as the node is dragged; everything else falls
// back to the bounding rect (mBorder), which is already right for rectangles.
export function mShapeOf(el) {
  var poly = el.querySelector("polygon");
  if (poly) {
    var nums = (poly.getAttribute("points") || "").match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    var off = mTranslate(poly), pts = [];
    for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: parseFloat(nums[i]) + off.x, y: parseFloat(nums[i + 1]) + off.y });
    if (pts.length >= 3) return { type: "poly", pts: pts };
  }
  var cir = el.querySelector("circle");
  if (cir) return { type: "conic", cx: parseFloat(cir.getAttribute("cx")) || 0, cy: parseFloat(cir.getAttribute("cy")) || 0, rx: parseFloat(cir.getAttribute("r")) || 0, ry: parseFloat(cir.getAttribute("r")) || 0 };
  var ell = el.querySelector("ellipse");
  if (ell) return { type: "conic", cx: parseFloat(ell.getAttribute("cx")) || 0, cy: parseFloat(ell.getAttribute("cy")) || 0, rx: parseFloat(ell.getAttribute("rx")) || 0, ry: parseFloat(ell.getAttribute("ry")) || 0 };
  return { type: "rect" };
}
// Farthest crossing of the ray center->toward with the (user-space) polygon.
// Farthest so a double-outline subroutine anchors on its OUTER edge; a convex
// shape has just the single forward crossing anyway.
export function mPolyExit(c, toward, verts) {
  var dx = toward.x - c.x, dy = toward.y - c.y, best = -1;
  for (var i = 0; i < verts.length; i++) {
    var A = verts[i], B = verts[(i + 1) % verts.length];
    var ex = B.x - A.x, ey = B.y - A.y, det = ex * dy - ey * dx;
    if (Math.abs(det) < 1e-9) continue;
    var ax = A.x - c.x, ay = A.y - c.y;
    var t = (ex * ay - ey * ax) / det, s = (dx * ay - dy * ax) / det;
    if (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6 && t > best) best = t;
  }
  return best < 0 ? null : { x: c.x + dx * best, y: c.y + dy * best };
}
// Exit of the ray center->toward through a circle/ellipse centered at (cx,cy).
export function mConicExit(c, toward, cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return null;
  var dx = (toward.x - c.x) / rx, dy = (toward.y - c.y) / ry;
  var fx = (c.x - cx) / rx, fy = (c.y - cy) / ry;
  var a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), k = fx * fx + fy * fy - 1;
  var disc = b * b - 4 * a * k;
  if (a === 0 || disc < 0) return null;
  var t = (-b + Math.sqrt(disc)) / (2 * a);
  if (t <= 0) return null;
  return { x: c.x + (toward.x - c.x) * t, y: c.y + (toward.y - c.y) * t };
}

export function enhanceMermaid() {
  // A live morph can strand a diagram's zoom bar onto a non-mermaid element
  // (the bar is data-htmlit, so the morph won't delete it and relocates it
  // instead). Drop any bar that is no longer parented by a .mermaid frame
  // before (re)building - this also cleans up any already-stranded bar.
  document.querySelectorAll("[data-htmlit-tools],[data-htmlit-codebtn],[data-htmlit-code],[data-htmlit-codecopy]").forEach(function (barEl) {
    var pp = barEl.parentElement;
    if (!pp || !pp.classList || !pp.classList.contains("mermaid")) barEl.remove();
  });
  document.querySelectorAll(".mermaid > svg").forEach(function (svg) {
    if (inChrome(svg) || svg.__htmlitDrag) return;
    try { setupDiagram(svg); } catch (e) {}
  });
  // The diagram SVG is now in the DOM, so any "you asked here" boxes on its
  // nodes/edges can be (re)resolved and drawn.
  if (typeof renderHighlights === "function") renderHighlights();
  if (typeof positionRail === "function") positionRail();
}

export function setupDiagram(svg) {
  svg.__htmlitDrag = true;
  var box = svg.parentNode;
  var sourceKey = (box && box.dataset && box.dataset.htmlitSrc) || svg.id || "";
  var space = svg.querySelector("g.root") || svg;
// Guarantee the frame is the bar's containing block AND clips it, as inline
// styles - so the zoom bar can never escape the frame if the injected
// stylesheet hasn't applied yet during a live morph (a reload used to "fix" it).
if (box && box.classList && box.classList.contains("mermaid")) {
  box.style.position = "relative";
  box.style.overflow = "hidden";
}
  var prefix = svg.id ? svg.id + "-" : "";
  function strip(id) { return prefix && id && id.indexOf(prefix) === 0 ? id.slice(prefix.length) : (id || ""); }

  var vb = (svg.getAttribute("viewBox") || "").split(/[ ,]+/).map(parseFloat);
  if (vb.length !== 4 || vb.some(isNaN)) { var bb = svg.getBBox(); vb = [bb.x, bb.y, bb.width, bb.height]; }
  // pad the base view a touch so the diagram doesn't touch the frame edges
  var pad = Math.max(8, Math.min(vb[2], vb[3]) * 0.06);
  var base = { x: vb[0] - pad, y: vb[1] - pad, w: vb[2] + pad * 2, h: vb[3] + pad * 2 };
  var state = { x: base.x, y: base.y, w: base.w, h: base.h };
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  var gridRect = null, onZoom = null, sizeGridRects = function () {};
  function applyViewBox() {
    svg.setAttribute("viewBox", state.x + " " + state.y + " " + state.w + " " + state.h);
    if (gridRect) {
      var r = svg.getBoundingClientRect();
      sizeGridRects(r);
      updateGrid(r.width || state.w);
    }
    if (onZoom) onZoom();
  }

  // A square graph-paper grid behind the diagram, in user space, so it pans with
  // the content. Two layers (coarse + a 5x finer one) crossfade with zoom so it
  // behaves like an infinite map grid: zoomed out you see a big square with 5
  // smaller ones inside; zoom in and finer squares smoothly "open up" (fade in),
  // zoom out and the finest lines fade away so it never turns to clutter.
  var SVGNS = "http://www.w3.org/2000/svg";
  var gFine = theme === "dark" ? "rgba(200,205,225,.16)" : "rgba(24,26,42,.13)";
  var gCoarse = theme === "dark" ? "rgba(200,205,225,.16)" : "rgba(24,26,42,.13)";
  var defs = svg.querySelector("defs");
  if (!defs) { defs = document.createElementNS(SVGNS, "defs"); svg.insertBefore(defs, svg.firstChild); }
  var gridId = "htmlit-grid-" + (svg.id || Math.random().toString(36).slice(2));
  function makeLayer(idSuffix, color) {
    var pat = document.createElementNS(SVGNS, "pattern");
    pat.setAttribute("id", gridId + idSuffix);
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("stroke", color); path.setAttribute("stroke-width", "1");
    path.setAttribute("fill", "none"); path.setAttribute("vector-effect", "non-scaling-stroke");
    pat.appendChild(path); defs.appendChild(pat);
    var rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("data-htmlit-grid", "");
    rect.setAttribute("fill", "url(#" + gridId + idSuffix + ")");
    rect.setAttribute("pointer-events", "none");
    return { pat: pat, path: path, rect: rect, cell: 0 };
  }
  var layerCoarse = makeLayer("-c", gCoarse);
  var layerFine = makeLayer("-f", gFine);
  gridRect = layerCoarse.rect;
  // fine drawn first (behind), coarse on top so shared lines read as "major"
  space.insertBefore(layerCoarse.rect, space.firstChild);
  space.insertBefore(layerFine.rect, space.firstChild);
  sizeGridRects = function (r) {
    r = r || svg.getBoundingClientRect();
    var scale = Math.min((r.width || state.w) / state.w, (r.height || state.h) / state.h) || 1;
    var visW = (r.width || state.w) / scale, visH = (r.height || state.h) / scale;
    var cx = state.x + state.w / 2, cy = state.y + state.h / 2;
    [layerCoarse.rect, layerFine.rect].forEach(function (rc) {
      rc.setAttribute("x", cx - visW); rc.setAttribute("y", cy - visH);
      rc.setAttribute("width", visW * 2); rc.setAttribute("height", visH * 2);
    });
  };
  function setLayerCell(layer, cell) {
    if (layer.cell === cell || !isFinite(cell) || cell <= 0) return;
    layer.cell = cell;
    layer.pat.setAttribute("width", cell); layer.pat.setAttribute("height", cell);
    layer.path.setAttribute("d", "M" + cell + " 0L0 0L0 " + cell);
  }
  function smoothstep(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  function updateGrid(frameW) {
    if (!frameW) return;
    var wpp = state.w / frameW;              // world units per screen pixel
    var target = 46;                          // the dominant square ~ this many px
    var t = Math.log(target * wpp) / Math.log(5);
    if (!isFinite(t)) return;
    var li = Math.floor(t), f = t - li;       // f in [0,1): position within the band
    // Two levels 5x apart crossfade complementarily so it is seamless (pop-free):
    // the finer level fades in as you zoom in; the coarser fades in as you zoom out.
    // Where their lines coincide (every 5th) they sum into natural "major" lines.
    setLayerCell(layerFine, Math.pow(5, li));
    setLayerCell(layerCoarse, Math.pow(5, li + 1));
    layerFine.rect.setAttribute("opacity", String(smoothstep(1 - f)));
    layerCoarse.rect.setAttribute("opacity", String(smoothstep(f)));
  }
  applyViewBox();

  // A subgraph nests its nodes inside a translated container group, so a node's
  // own transform is only its offset WITHIN that subgraph. frameOffset sums every
  // ancestor translate between `el` and `space` so all geometry (node rects, edge
  // endpoints, rebuilt paths) can be compared and written in one common frame.
  // Mermaid uses pure translates for these containers - any diagram-wide scale sits
  // above `space` and cancels out - so summing translates is exact.
  function frameOffset(el) {
    var x = 0, y = 0, e = el && el.parentElement;
    while (e && e !== space) { var t = mTranslate(e); x += t.x; y += t.y; e = e.parentElement; }
    return { x: x, y: y };
  }

  var nodes = [];
  svg.querySelectorAll("g.node").forEach(function (el) {
    var bbox;
    try { bbox = el.getBBox(); } catch (e) { bbox = { x: -10, y: -10, width: 20, height: 20 }; }
    nodes.push({
      el: el, id: strip(el.id), origT: el.getAttribute("transform") || "", origTr: mTranslate(el),
      shape: mShapeOf(el),
      center: function () { var o = frameOffset(el), t = mTranslate(el); return { x: o.x + t.x + bbox.x + bbox.width / 2, y: o.y + t.y + bbox.y + bbox.height / 2 }; },
      rect: function () { var o = frameOffset(el), t = mTranslate(el); return { left: o.x + t.x + bbox.x, top: o.y + t.y + bbox.y, right: o.x + t.x + bbox.x + bbox.width, bottom: o.y + t.y + bbox.y + bbox.height }; },
      delta: function () { var t = mTranslate(el); return { x: t.x - this.origTr.x, y: t.y - this.origTr.y }; },
      // Anchor point on the node's real outline, heading toward `toward`.
      border: function (toward) {
        var c = this.center(), o = frameOffset(el), t = mTranslate(el), ax = o.x + t.x, ay = o.y + t.y, sh = this.shape, hit = null;
        if (sh.type === "poly") hit = mPolyExit(c, toward, sh.pts.map(function (p) { return { x: p.x + ax, y: p.y + ay }; }));
        else if (sh.type === "conic") hit = mConicExit(c, toward, ax + sh.cx, ay + sh.cy, sh.rx, sh.ry);
        return hit || mBorder(c, toward, this.rect());
      },
    });
  });

  // Subgraphs render as g.cluster rectangles. They are not draggable, but inter-
  // subgraph arrows attach to their borders, so they take part in endpoint binding:
  // an arrow anchored on a cluster then stays put while inner nodes are dragged,
  // instead of being mis-bound to (and yanked around by) an arbitrary inner node.
  var clusters = [];
  svg.querySelectorAll("g.cluster").forEach(function (el) {
    var bbox;
    try { bbox = el.getBBox(); } catch (e) { return; }
    clusters.push({
      el: el, id: strip(el.id), shape: { type: "rect" },
      center: function () { var o = frameOffset(el), t = mTranslate(el); return { x: o.x + t.x + bbox.x + bbox.width / 2, y: o.y + t.y + bbox.y + bbox.height / 2 }; },
      rect: function () { var o = frameOffset(el), t = mTranslate(el); return { left: o.x + t.x + bbox.x, top: o.y + t.y + bbox.y, right: o.x + t.x + bbox.x + bbox.width, bottom: o.y + t.y + bbox.y + bbox.height }; },
      border: function (toward) { return mBorder(this.center(), toward, this.rect()); },
    });
  });

  // Bind an edge endpoint to what it actually touches: prefer the node under it, and
  // only fall back to an enclosing cluster when the endpoint is clearly off every
  // node (a subgraph-boundary connection). Clusters are never dragged, so their
  // arrows hold still while inner nodes move.
  function bindEndpoint(pt) {
    var n = mNearest(pt, nodes);
    if (n && mRectDist(pt, n.rect()) <= ANCHOR_SLACK) return n;
    var c = clusters.length ? mNearest(pt, clusters) : null;
    if (c && mRectDist(pt, c.rect()) <= ANCHOR_SLACK) return c;
    return n;
  }

  // Pair each edge path with its label by geometry, not DOM order: Mermaid emits
  // g.edgeLabels in a different order than g.edgePaths when self-loops are present,
  // and (in the mermaid.run path) the inner label ids are blank. So match every
  // non-empty label to the edge whose midpoint it sits closest to.
  // Sample points along a path, lifted into the common `space` frame. Mermaid places
  // an edge label ON its edge, so a label's MINIMUM distance to the right path is near
  // zero - far more reliable for matching than distance to the arc-midpoint, which on
  // a curved edge sits nowhere near where the label was placed (up by the hub node).
  function pathSamples(el) {
    var o = frameOffset(el), pts = [];
    try {
      var L = el.getTotalLength();
      if (L) { for (var i = 0; i <= 24; i++) { var q = el.getPointAtLength((L * i) / 24); pts.push({ x: q.x + o.x, y: q.y + o.y }); } }
    } catch (e) {}
    if (!pts.length) { var ep = mEndpoints(el.getAttribute("d")); if (ep) { pts.push({ x: ep.start.x + o.x, y: ep.start.y + o.y }, { x: ep.end.x + o.x, y: ep.end.y + o.y }); } }
    return pts;
  }
  var pathEls = Array.prototype.slice.call(svg.querySelectorAll("g.edgePaths > path"));
  var pathPts = pathEls.map(pathSamples);
  var labelEls = Array.prototype.filter.call(svg.querySelectorAll("g.edgeLabels > g.edgeLabel"), function (g) {
    return (g.textContent || "").trim() && /translate/.test(g.getAttribute("transform") || "");
  });
  var labelPos = labelEls.map(function (g) { var o = frameOffset(g), t = mTranslate(g); return { x: t.x + o.x, y: t.y + o.y }; });
  // Pair labels to paths by GLOBALLY nearest first, not greedily in DOM order: rank
  // every (label, path) pair by the label's minimum distance to that path, then lock in
  // each closest pair whose label and path are both still free. Greedy-by-DOM-order (or
  // matching on the arc-midpoint) mis-bound a label to the wrong edge, so a node drag
  // then flung that label across the diagram onto an unrelated arrow.
  var labelForPath = new Map();
  var pairs = [];
  labelPos.forEach(function (lp, li) {
    pathPts.forEach(function (pts, pi) {
      var best = Infinity;
      for (var k = 0; k < pts.length; k++) { var dx = pts[k].x - lp.x, dy = pts[k].y - lp.y, d = dx * dx + dy * dy; if (d < best) best = d; }
      if (best < Infinity) pairs.push({ li: li, pi: pi, d: best });
    });
  });
  pairs.sort(function (a, b) { return a.d - b.d; });
  var labelUsed = [], pathUsed = [];
  pairs.forEach(function (pr) {
    if (labelUsed[pr.li] || pathUsed[pr.pi]) return;
    labelUsed[pr.li] = pathUsed[pr.pi] = true;
    labelForPath.set(pathEls[pr.pi], labelEls[pr.li]);
  });

  var edges = [];
  var nodeEdges = nodes.map(function () { return []; });
  pathEls.forEach(function (el) {
    var lg = labelForPath.get(el) || null;
    // eo/lo lift this path's (and its label's) local coordinates into the common
    // `space` frame, so endpoints compare against node/cluster rects there and
    // rebuilt geometry can be written back in the element's own frame.
    var eo = frameOffset(el), lo = lg ? frameOffset(lg) : { x: 0, y: 0 };
    var ep = mEndpoints(el.getAttribute("d"));
    var src = ep ? bindEndpoint({ x: ep.start.x + eo.x, y: ep.start.y + eo.y }) : null;
    var tgt = ep ? bindEndpoint({ x: ep.end.x + eo.x, y: ep.end.y + eo.y }) : null;
    // Keep the original path (lifted into the common `space` frame) so a rebuild can
    // carry its real shape onto the moved endpoints instead of straightening it.
    var parsed = mParsePath(el.getAttribute("d"));
    var origPts = parsed ? parsed.pts.map(function (p) { return { x: p.x + eo.x, y: p.y + eo.y }; }) : null;
    var origLabelTr = lg ? mTranslate(lg) : { x: 0, y: 0 };
    var edge = {
      el: el, id: strip(el.id), src: src, tgt: tgt, label: lg, selfLoop: !!(src && src === tgt),
      origD: el.getAttribute("d") || "", origLabelT: lg ? (lg.getAttribute("transform") || "") : "",
      origLabelTr: origLabelTr,
      origSeq: parsed ? parsed.seq : null, origPts: origPts,
      origStart: origPts ? origPts[0] : null, origEnd: origPts ? origPts[origPts.length - 1] : null,
      origLabelAnchor: lg ? { x: origLabelTr.x + lo.x, y: origLabelTr.y + lo.y } : null,
      eo: eo, lo: lo, bend: null,
    };
    edges.push(edge);
    // Register the edge to any draggable node it touches so a drag rebuilds it. An
    // endpoint bound to a (non-draggable) cluster is skipped, so inter-subgraph
    // arrows are left untouched when inner nodes move.
    var si = src ? nodes.indexOf(src) : -1;
    if (si >= 0) nodeEdges[si].push(edge);
    var ti = tgt && tgt !== src ? nodes.indexOf(tgt) : -1;
    if (ti >= 0) nodeEdges[ti].push(edge);
  });

  // Each edge endpoint is pinned to its node's original attach point and moved by how
  // far that node has been dragged (its delta), so parallel edges keep their fanned-out
  // starts and arrowheads instead of every one snapping to the single toward-centre
  // border point. Falls back to that border point only when the path was unparseable.
  function edgeEnds(e) {
    var dS = e.src.delta(), dT = e.tgt.delta();
    return {
      s: e.origStart ? { x: e.origStart.x + dS.x, y: e.origStart.y + dS.y } : e.src.border(e.tgt.center()),
      t: e.origEnd ? { x: e.origEnd.x + dT.x, y: e.origEnd.y + dT.y } : e.tgt.border(e.src.center()),
    };
  }
  function rebuildEdge(e) {
    if (!e.src || !e.tgt) return;
    if (e.selfLoop) {
      // The loop's shape never changes; just shift it (and its label) by how far
      // the node has moved from its original position.
      var d = e.src.delta();
      if (d.x || d.y) e.el.setAttribute("transform", "translate(" + d.x + "," + d.y + ")");
      else e.el.removeAttribute("transform");
      if (e.label) mSetTranslate(e.label, e.origLabelTr.x + d.x, e.origLabelTr.y + d.y);
      return;
    }
    var ends = edgeEnds(e), aS = ends.s, aT = ends.t;
    // Endpoints are in the common `space` frame; write the path in its own frame
    // (subtract eo) and the label in its frame (subtract lo).
    var eo = e.eo, lo = e.lo, lp;
    if (e.bend) {
      // Bow the edge toward the drag point, but keep its pinned endpoints so the
      // arrowhead stays on its own fanned spot rather than snapping to the centre.
      var mx = (aS.x + aT.x) / 2, my = (aS.y + aT.y) / 2;
      var vx = aT.x - aS.x, vy = aT.y - aS.y, len = Math.hypot(vx, vy) || 1;
      var ux = vx / len, uy = vy / len;
      var cx = mx + ux * e.bend.along - uy * e.bend.perp, cy = my + uy * e.bend.along + ux * e.bend.perp;
      e.el.setAttribute("d", "M" + (aS.x - eo.x) + "," + (aS.y - eo.y) + "Q" + (cx - eo.x) + "," + (cy - eo.y) + " " + (aT.x - eo.x) + "," + (aT.y - eo.y));
      lp = { x: 0.25 * aS.x + 0.5 * cx + 0.25 * aT.x, y: 0.25 * aS.y + 0.5 * cy + 0.25 * aT.y };
    } else {
      // No manual bend: rubber-band the recorded path between the pinned endpoints,
      // preserving its curve (and parallel-edge separation).
      var fit = (e.origSeq && e.origStart && e.origEnd) ? mFitTransform(e.origStart, e.origEnd, aS, aT) : null;
      if (fit) {
        e.el.setAttribute("d", mPathFromSeq(e.origSeq, e.origPts.map(fit), eo.x, eo.y));
        lp = e.origLabelAnchor ? fit(e.origLabelAnchor) : { x: (aS.x + aT.x) / 2, y: (aS.y + aT.y) / 2 };
      } else {
        e.el.setAttribute("d", "M" + (aS.x - eo.x) + "," + (aS.y - eo.y) + "L" + (aT.x - eo.x) + "," + (aT.y - eo.y));
        lp = { x: (aS.x + aT.x) / 2, y: (aS.y + aT.y) / 2 };
      }
    }
    if (e.label) mSetTranslate(e.label, lp.x - lo.x, lp.y - lo.y);
  }
  function rebuildNode(node) { var i = nodes.indexOf(node); if (i >= 0) nodeEdges[i].forEach(rebuildEdge); }

  // On a fresh render, pull every edge label onto the point of its own edge nearest to
  // where Mermaid dropped it. Mermaid sometimes places a label a little off a curved
  // edge (e.g. two edges into the same node), and htmlit otherwise only snaps a label
  // onto its line when that edge is dragged - so a label could sit off its arrow until
  // touched. This lands them on their lines from the start and updates the label's
  // recorded origin so later drags stay consistent.
  function snapLabelsToEdges() {
    edges.forEach(function (e) {
      if (!e.label || !e.origLabelAnchor || e.selfLoop) return;
      var pts = pathSamples(e.el);
      if (!pts.length) return;
      var c = e.origLabelAnchor, best = null, bd = Infinity;
      for (var k = 0; k < pts.length; k++) { var dx = pts[k].x - c.x, dy = pts[k].y - c.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = pts[k]; } }
      if (!best) return;
      var tx = best.x - e.lo.x, ty = best.y - e.lo.y;
      e.origLabelAnchor = { x: best.x, y: best.y };
      e.origLabelTr = { x: tx, y: ty };
      e.origLabelT = "translate(" + tx + "," + ty + ")";
      mSetTranslate(e.label, tx, ty);
    });
  }

  function save() {
    var snap = { vb: [state.x, state.y, state.w, state.h], nodes: {}, edges: {}, edgeT: {}, labels: {}, bends: {} };
    nodes.forEach(function (n) { snap.nodes[n.id] = n.el.getAttribute("transform") || ""; });
    edges.forEach(function (e) {
      snap.edges[e.id] = e.el.getAttribute("d") || "";
      var et = e.el.getAttribute("transform"); if (et) snap.edgeT[e.id] = et;
      if (e.label) snap.labels[e.id] = e.label.getAttribute("transform") || "";
      if (e.bend) snap.bends[e.id] = e.bend;
    });
    diagramLayouts[sourceKey] = snap;
  }
  function applySnap(s) {
    if (!s) return;
    nodes.forEach(function (n) { if (s.nodes[n.id] != null) n.el.setAttribute("transform", s.nodes[n.id]); });
    edges.forEach(function (e) {
      if (s.bends && s.bends[e.id]) e.bend = s.bends[e.id];
      if (s.edges[e.id] != null) e.el.setAttribute("d", s.edges[e.id]);
      if (s.edgeT && s.edgeT[e.id] != null) e.el.setAttribute("transform", s.edgeT[e.id]);
      if (e.label && s.labels && s.labels[e.id] != null) e.label.setAttribute("transform", s.labels[e.id]);
    });
    if (s.vb) { state.x = s.vb[0]; state.y = s.vb[1]; state.w = s.vb[2]; state.h = s.vb[3]; applyViewBox(); }
  }
  function reset() {
    state.x = base.x; state.y = base.y; state.w = base.w; state.h = base.h; applyViewBox();
    nodes.forEach(function (n) { n.el.setAttribute("transform", n.origT); });
    edges.forEach(function (e) {
      e.bend = null;
      e.el.setAttribute("d", e.origD);
      e.el.removeAttribute("transform");
      if (e.label) e.label.setAttribute("transform", e.origLabelT);
    });
    delete diagramLayouts[sourceKey];
  }

  function toUser(cx, cy) {
    var m = space.getScreenCTM();
    if (!m) return { x: cx, y: cy };
    var p = svg.createSVGPoint(); p.x = cx; p.y = cy;
    var u = p.matrixTransform(m.inverse());
    return { x: u.x, y: u.y };
  }
  function nodeByEl(el) { for (var i = 0; i < nodes.length; i++) if (nodes[i].el === el) return nodes[i]; return null; }
  function edgeByPath(el) { for (var i = 0; i < edges.length; i++) if (edges[i].el === el) return edges[i]; return null; }
  function edgeByLabel(el) { for (var i = 0; i < edges.length; i++) if (edges[i].label === el) return edges[i]; return null; }

  var drag = null;
  svg.style.touchAction = "none";
  // Rest state uses the normal arrow cursor; we switch to "grabbing" only once a
  // drag actually starts (in pointermove), then back to the arrow on release.
  svg.style.cursor = "default";
  // never let a drag select the diagram's text (labels live in <foreignObject>)
  svg.style.userSelect = "none";
  svg.style.webkitUserSelect = "none";

  svg.addEventListener("pointerdown", function (e) {
    if (appState.ended || e.button !== 0) return;
    var t = e.target, closest = t.closest ? t.closest.bind(t) : function () { return null; };
    var u = toUser(e.clientX, e.clientY);
    var nodeEl = closest("g.node"), labelEl = closest("g.edgeLabels g.edgeLabel"), pathEl = closest("g.edgePaths path");
    var node = nodeEl && nodeByEl(nodeEl);
    // A label is not independently movable - grabbing it bends its edge, so the
    // label always stays attached to the line.
    var edge = (pathEl && edgeByPath(pathEl)) || (labelEl && edgeByLabel(labelEl)) || null;
    if (node) drag = { type: "node", node: node, hit: nodeEl, start: u, t0: mTranslate(nodeEl) };
    // For a comment, target what was clicked: an edge label is a compact box, so
    // prefer it over the edge path (whose bounding box spans both nodes and would
    // "highlight the whole square"). Fall back to the path when there is no label.
    else if (edge && edge.src && edge.tgt && edge.src !== edge.tgt) drag = { type: "edge", edge: edge, hit: labelEl || edge.label || pathEl || edge.el };
    else drag = { type: "pan", sx: e.clientX, sy: e.clientY };
    drag.moved = false; drag.cx0 = e.clientX; drag.cy0 = e.clientY;
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  });
  svg.addEventListener("pointermove", function (e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.cx0, e.clientY - drag.cy0) < 3) return;
      drag.moved = true; svg.style.cursor = "grabbing";
    }
    e.preventDefault();
    if (drag.type === "pan") {
      var r = svg.getBoundingClientRect();
      state.x -= (e.clientX - drag.sx) * state.w / (r.width || 1);
      state.y -= (e.clientY - drag.sy) * state.h / (r.height || 1);
      drag.sx = e.clientX; drag.sy = e.clientY; applyViewBox();
      scheduleReposition();
      return;
    }
    var u = toUser(e.clientX, e.clientY);
    if (drag.type === "node") {
      mSetTranslate(drag.node.el, drag.t0.x + (u.x - drag.start.x), drag.t0.y + (u.y - drag.start.y));
      rebuildNode(drag.node);
    } else if (drag.type === "edge" && drag.edge.src && drag.edge.tgt && drag.edge.src !== drag.edge.tgt) {
      // Bend relative to the same pinned endpoints rebuildEdge draws between, so the
      // grabbed label/edge tracks the cursor and its arrowhead never jumps to centre.
      var e2 = drag.edge, ends2 = edgeEnds(e2), s2 = ends2.s, t2 = ends2.t;
      var mx = (s2.x + t2.x) / 2, my = (s2.y + t2.y) / 2;
      var vx = t2.x - s2.x, vy = t2.y - s2.y, len = Math.hypot(vx, vy) || 1;
      var ux = vx / len, uy = vy / len;
      e2.bend = { along: (u.x - mx) * ux + (u.y - my) * uy, perp: (u.x - mx) * -uy + (u.y - my) * ux };
      rebuildEdge(e2);
    }
    // keep any htmlit annotation pins / highlight glued to the moved elements
    scheduleReposition();
  });
  function endDrag(e) {
    if (!drag) return;
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    var d = drag; drag = null; svg.style.cursor = "default";
    if (d.moved) { save(); return; }
    // A click (no drag) acts on the pressed node/edge - text isn't selectable in a
    // diagram. diagramClick() routes it: jump to an answered anchor, open an
    // existing anchor's menu, or start a fresh comment. A background click dismisses.
    if (d.type === "node" || d.type === "edge") diagramClick(d.hit || (d.node && d.node.el) || (d.edge && d.edge.el));
    else clearPending();
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  // Zoom around a focal point given in [0..1] fractions of the frame. f<1 zooms in.
  function zoomAt(mx, my, f) {
    var px = state.x + mx * state.w, py = state.y + my * state.h;
    var nw = Math.min(base.w * 4, Math.max(base.w * 0.15, state.w * f));
    var nh = Math.min(base.h * 4, Math.max(base.h * 0.15, state.h * f));
    state.x = px - mx * nw; state.y = py - my * nh; state.w = nw; state.h = nh; applyViewBox();
    scheduleReposition();
    clearTimeout(svg.__saveT); svg.__saveT = setTimeout(save, 250);
  }
  svg.addEventListener("wheel", function (e) {
    if (appState.ended) return;
    e.preventDefault();
    var r = svg.getBoundingClientRect();
    zoomAt((e.clientX - r.left) / (r.width || 1), (e.clientY - r.top) / (r.height || 1), e.deltaY < 0 ? 1 / 1.12 : 1.12);
  }, { passive: false });

  // Minimal Excalidraw-style zoom control: [ - ][ NN% ][ + ], bottom-left.
  // The percentage is relative to the fitted view (100% = whole diagram in frame);
  // clicking it resets to fit.
  if (box && box.classList && box.classList.contains("mermaid") && !box.querySelector("[data-htmlit-tools]")) {
    var dark = theme === "dark";
    var bar = document.createElement("div");
    bar.setAttribute("data-htmlit", "");
    bar.setAttribute("data-htmlit-tools", "");
    bar.style.cssText = "position:absolute;left:10px;bottom:10px;display:inline-flex;align-items:stretch;z-index:5;font:500 12px/1 system-ui,-apple-system,sans-serif;border-radius:9px;overflow:hidden;" +
      "background:" + (dark ? "rgba(36,38,45,.92)" : "rgba(255,255,255,.94)") + ";border:1px solid " + (dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.12)") + ";box-shadow:0 2px 8px rgba(0,0,0,.16);color:" + (dark ? "#e8e8ea" : "#222") + ";";
    var btn = "background:none;border:0;color:inherit;cursor:pointer;padding:0 11px;height:28px;font:inherit;display:flex;align-items:center;justify-content:center;";
    bar.innerHTML =
      '<button type="button" data-htmlit-zout title="Zoom out" style="' + btn + 'font-size:16px;">\u2212</button>' +
      '<button type="button" data-htmlit-zpct title="Reset to fit" style="' + btn + 'min-width:46px;border-left:1px solid ' + (dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.09)") + ';border-right:1px solid ' + (dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.09)") + ';">100%</button>' +
      '<button type="button" data-htmlit-zin title="Zoom in" style="' + btn + 'font-size:16px;">+</button>';
    box.appendChild(bar);
    var pctEl = bar.querySelector("[data-htmlit-zpct]");
    onZoom = function () { pctEl.textContent = Math.round(base.w / state.w * 100) + "%"; };
    onZoom();
    function stop(ev) { ev.stopPropagation(); ev.preventDefault(); }
    bar.querySelector("[data-htmlit-zout]").addEventListener("click", function (ev) { stop(ev); zoomAt(0.5, 0.5, 1.2); });
    bar.querySelector("[data-htmlit-zin]").addEventListener("click", function (ev) { stop(ev); zoomAt(0.5, 0.5, 1 / 1.2); });
    pctEl.addEventListener("click", function (ev) { stop(ev); reset(); });
    bar.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
  }

  // "Code" toggle (top-right): reveal the diagram's Mermaid source in place - as a
  // real code block (line numbers + a Copy button) - so a reader can inspect or copy
  // the syntax without leaving the page. Added once and cleaned up on morph alongside
  // the zoom bar.
  if (box && box.classList && box.classList.contains("mermaid") && box.dataset.htmlitSrc && !box.querySelector("[data-htmlit-codebtn]")) {
    var cdark = theme === "dark";
    var mSrc = box.dataset.htmlitSrc;

    // The source view mirrors a normal enhanced code block: a titled header
    // ("MERMAID" + Copy) over a line-numbered, syntax-highlighted body, reusing the
    // same classes so it shares the chrome and background. It overlays the diagram
    // and is opened by the floating "Code" button; the header's "Diagram" button
    // (and Escape) closes it again.
    var codeView = document.createElement("div");
    codeView.className = "htmlit-code";
    codeView.setAttribute("data-htmlit", "");
    codeView.setAttribute("data-htmlit-code", "");
    codeView.style.cssText = "position:absolute;inset:0;margin:0;display:none;z-index:6;overflow:auto;box-sizing:border-box;border-radius:inherit;";

    var codeHd = document.createElement("div");
    codeHd.className = "htmlit-code-hd";
    var codeLang = document.createElement("span");
    codeLang.className = "htmlit-code-lang";
    codeLang.textContent = "mermaid";
    var codeActions = document.createElement("span");
    codeActions.className = "htmlit-code-actions";
    var copyBtn = makeCopyButton(function () { return mSrc; });
    copyBtn.setAttribute("data-htmlit", "");
    copyBtn.setAttribute("data-htmlit-codecopy", "");
    copyBtn.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "htmlit-copy";
    backBtn.setAttribute("data-htmlit", "");
    backBtn.textContent = "Diagram";
    backBtn.title = "Show the diagram";
    backBtn.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
    codeActions.appendChild(copyBtn);
    codeActions.appendChild(backBtn);
    codeHd.appendChild(codeLang);
    codeHd.appendChild(codeActions);
    codeView.appendChild(codeHd);

    var codeBody = document.createElement("div");
    codeBody.className = "htmlit-code-body";
    codeBody.appendChild(makeLinenos(lineCount(mSrc)));
    var codePre = document.createElement("pre");
    var codeEl = document.createElement("code");
    codeEl.textContent = mSrc;
    codePre.appendChild(codeEl);
    highlightMermaidSource(codeEl);
    codeBody.appendChild(codePre);
    codeView.appendChild(codeBody);
    codeView.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
    box.appendChild(codeView);

    var codeBtn = document.createElement("button");
    codeBtn.type = "button";
    codeBtn.setAttribute("data-htmlit", "");
    codeBtn.setAttribute("data-htmlit-codebtn", "");
    codeBtn.textContent = "Code";
    codeBtn.title = "Show the Mermaid source";
    codeBtn.style.cssText = "position:absolute;right:10px;top:10px;z-index:7;height:28px;padding:0 12px;cursor:pointer;" +
      "font:500 12px/1 system-ui,-apple-system,sans-serif;border-radius:9px;" +
      "background:" + (cdark ? "rgba(36,38,45,.92)" : "rgba(255,255,255,.94)") + ";color:" + (cdark ? "#e8e8ea" : "#222") +
      ";border:1px solid " + (cdark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.12)") + ";box-shadow:0 2px 8px rgba(0,0,0,.16);";
    codeBtn.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });

    function showCode(opening) {
      codeView.style.display = opening ? "block" : "none";
      codeBtn.style.display = opening ? "none" : "";
      var svgEl = box.querySelector("svg");
      if (svgEl) svgEl.style.display = opening ? "none" : "";
      var zbar = box.querySelector("[data-htmlit-tools]");
      if (zbar) zbar.style.display = opening ? "none" : "inline-flex";
    }
    codeBtn.addEventListener("click", function (ev) { ev.stopPropagation(); ev.preventDefault(); showCode(true); });
    backBtn.addEventListener("click", function (ev) { ev.stopPropagation(); ev.preventDefault(); showCode(false); });
    box.appendChild(codeBtn);
  }

  // Frame the whole diagram (fitted), for a static export/print, instead of the
  // current panned/zoomed viewport. Grids are hidden while measuring so they do
  // not inflate the content box. Returns a fn that restores the live view.
  function fitForExport() {
    var saved = { x: state.x, y: state.y, w: state.w, h: state.h,
      wAttr: svg.getAttribute("width"), hAttr: svg.getAttribute("height") };
    var gc = layerCoarse.rect.style.display, gf = layerFine.rect.style.display;
    layerCoarse.rect.style.display = "none";
    layerFine.rect.style.display = "none";
    var bb = null; try { bb = space.getBBox(); } catch (e) {}
    layerCoarse.rect.style.display = gc;
    layerFine.rect.style.display = gf;
    if (bb && bb.width && bb.height) {
      var p = Math.max(8, Math.min(bb.width, bb.height) * 0.05);
      state.x = bb.x - p; state.y = bb.y - p; state.w = bb.width + p * 2; state.h = bb.height + p * 2;
      applyViewBox();
    }
    // A concrete intrinsic size (px) so the SVG paints in print / static files;
    // width:100% + height:auto renders blank in Chrome's print path.
    svg.setAttribute("width", Math.round(state.w));
    svg.setAttribute("height", Math.round(state.h));
    return function () {
      state.x = saved.x; state.y = saved.y; state.w = saved.w; state.h = saved.h; applyViewBox();
      if (saved.wAttr == null) svg.removeAttribute("width"); else svg.setAttribute("width", saved.wAttr);
      if (saved.hAttr == null) svg.removeAttribute("height"); else svg.setAttribute("height", saved.hAttr);
    };
  }
  diagramRegistry.push({ svg: svg, fit: fitForExport });

  if (diagramLayouts[sourceKey]) applySnap(diagramLayouts[sourceKey]);
  else snapLabelsToEdges();
}
