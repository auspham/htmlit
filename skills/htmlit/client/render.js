import { VENDOR } from "./state.js";
import { inChrome, loadScript } from "./util.js";
import { theme } from "./theme.js";
import { enhanceMermaid } from "./diagram.js";
import { renderDiff } from "./diffview.js";
import { makeCopyButton, makeLinenos, lineCount } from "./codeblock.js";

var mermaidReady = false;
var hljsReady = false;

export function ensureMermaid() {
  if (mermaidReady || !VENDOR.mermaid) return Promise.resolve();
  return loadScript(VENDOR.mermaid).then(function () {
    mermaidReady = true;
    window.mermaid.initialize({ startOnLoad: false, theme: theme === "dark" ? "dark" : "default", securityLevel: "loose", suppressErrorRendering: true });
  }).catch(function () {});
}
export function ensureHljs() {
  if (hljsReady || !VENDOR.hljsJs) return Promise.resolve();
  return loadScript(VENDOR.hljsJs).then(function () {
    hljsReady = true;
    if (window.hljs) window.hljs.configure({ ignoreUnescapedHTML: true });
  }).catch(function () {});
}
// Reconstruct the Mermaid source from a <code> block. The artifact ships the
// source as literal HTML, so the browser has already parsed line breaks
// (<br/>) into real <br> nodes and decoded entities (&rarr; -> arrow, &gt; -> >)
// by the time we read it. code.textContent would DROP those <br> nodes and
// glue label lines together ("STEP 1<br/>read" -> "STEP 1read"); code.innerHTML
// would re-escape "-->" into "--&gt;" and break arrows. So walk the nodes:
// keep text as-is (already decoded), turn each <br> back into "<br/>", and
// unwrap any other element to its text.
export function mermaidSource(code) {
  var out = "";
  (function walk(node) {
    for (var n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.tagName.toLowerCase() === "br") out += "<br/>";
        else walk(n);
      }
    }
  })(code);
  return out;
}
export function renderMermaid(force) {
  if (!window.mermaid) return Promise.resolve();
  document.querySelectorAll("pre > code.language-mermaid").forEach(function (code) {
    if (inChrome(code)) return;
    var src = mermaidSource(code);
    var div = document.createElement("div");
    div.className = "mermaid";
    div.dataset.htmlitSrc = src;
    div.textContent = src;
    code.parentElement.replaceWith(div);
  });
  if (force) {
    document.querySelectorAll(".mermaid[data-processed]").forEach(function (m) {
      // Restore the source as *text* (not innerHTML): the diagram source can contain
      // <, >, & (labels, <br/>, <<interface>> ...) which innerHTML would mangle into
      // real nodes, making Mermaid re-parse fail with "Syntax error in text".
      if (m.dataset.htmlitSrc) { m.removeAttribute("data-processed"); m.textContent = m.dataset.htmlitSrc; }
    });
  }
  var nodes = Array.prototype.filter.call(
    document.querySelectorAll(".mermaid:not([data-processed])"),
    function (n) { return !inChrome(n); }
  );
  // Mermaid sizes a diagram from its laid-out text, so one inside a display:none tab
  // or a closed <details> renders collapsed to nothing. Render the diagrams that are
  // laid out now, and defer the hidden ones until they are revealed (revealObserver).
  var ready = [], deferred = [];
  nodes.forEach(function (n) { (revealObserver && !isRenderable(n) ? deferred : ready).push(n); });
  deferred.forEach(function (n) { revealObserver.observe(n); });
  if (!ready.length) { enhanceMermaid(); return Promise.resolve(); }
  return Promise.all(ready.map(validateMermaid)).then(function (checked) {
    var good = checked.filter(Boolean);
    if (!good.length) { enhanceMermaid(); return; }
    return window.mermaid.run({ nodes: good }).then(enhanceMermaid, enhanceMermaid);
  }).catch(enhanceMermaid);
}

// A diagram is renderable once it has layout (client rects). A display:none ancestor
// - a hidden tab or a closed <details> - yields none, so Mermaid would collapse it.
function isRenderable(node) { return node.getClientRects().length > 0; }

// Render a deferred (hidden) diagram the moment it gains size, i.e. is revealed. A
// ResizeObserver fires on the display:none -> shown transition regardless of scroll
// position, so a tab or accordion diagram renders exactly when the user opens it.
var revealObserver = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(function (entries) {
  entries.forEach(function (e) {
    var n = e.target;
    if (!n.hasAttribute("data-processed") && !n.__htmlitRendering && isRenderable(n)) renderDeferred(n);
  });
}) : null;
function renderDeferred(node) {
  node.__htmlitRendering = true;
  revealObserver.unobserve(node);
  Promise.resolve(validateMermaid(node)).then(function (valid) {
    if (!valid) return; // invalid: the source fallback is already shown
    return window.mermaid.run({ nodes: [valid] }).then(enhanceMermaid, enhanceMermaid);
  }).catch(enhanceMermaid).then(function () { node.__htmlitRendering = false; });
}

// Validate one diagram before running it. Mermaid injects a large "Syntax error"
// graphic for invalid input, so we parse first and, on failure, swap the block for
// its source (see mermaidFallback) instead of that graphic.
function validateMermaid(node) {
  var src = node.dataset.htmlitSrc || node.textContent;
  if (!window.mermaid || typeof window.mermaid.parse !== "function") return Promise.resolve(node);
  return Promise.resolve(window.mermaid.parse(src, { suppressErrors: true }))
    .then(function (ok) { if (ok) return node; mermaidFallback(node, src); return null; })
    .catch(function () { mermaidFallback(node, src); return null; });
}

// Replace an unrenderable diagram with its source, so a bad diagram degrades to
// readable text rather than Mermaid's error graphic.
function mermaidFallback(node, src) {
  if (!node.parentElement) return;
  var box = document.createElement("div");
  box.className = "htmlit-diagram-error";
  var note = document.createElement("div");
  note.className = "htmlit-diagram-error-note";
  note.textContent = "Diagram could not be rendered - showing the source.";
  var pre = document.createElement("pre");
  var code = document.createElement("code");
  code.textContent = src;
  pre.appendChild(code);
  box.appendChild(note);
  box.appendChild(pre);
  node.replaceWith(box);
}

export function highlight() {
  if (!window.hljs) return;
  document.querySelectorAll("pre code").forEach(function (code) {
    if (inChrome(code) || code.dataset.highlighted === "yes") return;
    if (/\blanguage-mermaid\b/.test(code.className)) return;
    if (/\blanguage-diff\b/.test(code.className)) return;
    try { window.hljs.highlightElement(code); } catch (e) {}
  });
}
// Wrap each code block with a language header + a line-number gutter. Re-applied
// on every render (like the mermaid handling): a live morph replaces the wrapper
// with the raw <pre> from the artifact, then this rebuilds it, so edits still
// update. The wrapper is not data-htmlit, so morph reconciliation stays clean.
export function enhanceCode() {
  document.querySelectorAll("pre > code").forEach(function (code) {
    if (inChrome(code) || /\blanguage-mermaid\b/.test(code.className)) return;
    var pre = code.parentElement, parent = pre.parentElement;
    if (!parent || parent.classList.contains("htmlit-code-body")) return; // already wrapped
    if (/\blanguage-diff\b/.test(code.className)) { renderDiff(code); return; }
    var m = /language-([\w-]+)/.exec(code.className);
    var lang = m ? m[1] : "code";
    var src = code.textContent.replace(/\n+$/, "");
    var fig = document.createElement("div");
    fig.className = "htmlit-code";
    var hd = document.createElement("div");
    hd.className = "htmlit-code-hd";
    var langEl = document.createElement("span");
    langEl.className = "htmlit-code-lang";
    langEl.textContent = lang;
    hd.appendChild(langEl);
    hd.appendChild(makeCopyButton(function () { return src; }));
    var body = document.createElement("div");
    body.className = "htmlit-code-body";
    body.appendChild(makeLinenos(lineCount(src)));
    parent.insertBefore(fig, pre);
    fig.appendChild(hd);
    body.appendChild(pre);
    fig.appendChild(body);
  });
}
