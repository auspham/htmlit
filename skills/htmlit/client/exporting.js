import { CFG, state as appState } from "./state.js";
import { root, shadow, ui } from "./dom.js";
import { inChrome } from "./util.js";
import { hljsLink, theme } from "./theme.js";
import { diagramRegistry } from "./diagram.js";

var lastUserQuestion = "";
export function setLastUserQuestion(text) { lastUserQuestion = text; }
// Base typography for the artifact. Every selector is fully wrapped in :where() so
// it carries zero specificity: it fills in readable defaults (sans-serif body, a
// dark-mode background, framed code) but is overridden by ANY rule the artifact
// declares for the same element, so a styled artifact is never touched. Injected
// first (see injectBaseCss) so even an equal-specificity artifact rule wins by order.
var BASE_CSS =
  ':where(body){font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#1f2328;background-color:#ffffff;}' +
  ':where(html.dark body){color:#e6edf3;background-color:#0d1117;}' +
  ':where(h1,h2,h3,h4,h5,h6){line-height:1.25;}' +
  ':where(a){color:#0969da;}' +
  ':where(html.dark a){color:#4493f8;}' +
  ':where(code,kbd,samp,pre){font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}' +
  ':where(pre){background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:12px;overflow:auto;}' +
  ':where(html.dark pre){background:#161b22;border-color:#30363d;}' +
  ':where(:not(pre)>code){background:#f6f8fa;border:1px solid #d0d7de;border-radius:5px;padding:1px 5px;}' +
  ':where(html.dark :not(pre)>code){background:#161b22;border-color:#30363d;}';
var ARTIFACT_CSS =
  '[data-htmlit-answer]{position:relative;margin:6px 0 16px;padding:12px 15px;border:1px solid rgba(120,120,135,.28);border-left:3px solid #6b5cff;border-radius:0 10px 10px 10px;background:rgba(107,92,255,.055);}' +
  '[data-htmlit-answer]::before{content:"\\21B3  You asked: " attr(data-question);display:block;margin:0 0 10px;padding:0 0 8px;font:600 12.5px/1.45 system-ui,-apple-system,sans-serif;color:#5647d6;border-bottom:1px dashed rgba(120,120,135,.32);white-space:pre-wrap;}' +
  '[data-htmlit-answer]:not([data-question])::before,[data-htmlit-answer][data-question=""]::before{content:"\\21B3  Answer";}' +
  // The "You asked:" header of an answered comment is a back-link to where the user
  // asked (a plain click on it jumps there), so give it a pointer + hover underline.
  '[data-htmlit-answer][data-htmlit-answer-for]::before{cursor:pointer;}' +
  '[data-htmlit-answer][data-htmlit-answer-for]:hover::before{text-decoration:underline;}' +
  'html.dark [data-htmlit-answer]{background:rgba(124,111,255,.1);border-color:rgba(140,140,160,.28);border-left-color:#8b7cff;}' +
  'html.dark [data-htmlit-answer]::before{color:#b7adff;border-bottom-color:rgba(150,150,170,.35);}' +
  '@keyframes htmlit-new-pulse{0%{box-shadow:0 0 0 3px rgba(107,92,255,.5);background-color:rgba(107,92,255,.14);}70%{box-shadow:0 0 0 3px rgba(107,92,255,.18);}100%{box-shadow:0 0 0 3px rgba(107,92,255,0);background-color:transparent;}}' +
  '.htmlit-new{animation:htmlit-new-pulse 2.6s ease-out 1;border-radius:8px;}' +
  '::selection{background:rgba(255,205,0,.45);}' +
  'html.dark ::selection{background:rgba(255,205,60,.4);}' +
  // A note highlight forces dark ink on a solid yellow (like Google Docs) so the
  // text stays high-contrast and readable in BOTH themes - a translucent tint over
  // light body text washes out in dark mode.
  // A note highlight looks like a highlighter-pen stroke: a translucent yellow
  // band behind the lower part of the text, keeping the text's own colour so it
  // stays readable in both themes (a full opaque fill washes out dark-mode text).
  'mark.htmlit-hl{background:linear-gradient(transparent 52%, rgba(255,214,71,.62) 52%)!important;color:inherit!important;-webkit-text-fill-color:currentColor!important;padding:0 .05em;border-radius:2px;cursor:pointer;}' +
  'html.dark mark.htmlit-hl{background:linear-gradient(transparent 52%, rgba(255,208,64,.5) 52%)!important;}' +
  // A comment anchor is a light "you asked here" marker (keeps the text readable):
  // a faint accent wash + an accent underline. Text keeps its own colour.
  'mark.htmlit-cm{background:color-mix(in srgb,#7c3aed 11%,transparent)!important;color:inherit!important;border-bottom:2px solid color-mix(in srgb,#7c3aed 55%,transparent);border-radius:2px 2px 0 0;padding:.02em .04em;cursor:pointer;-webkit-text-fill-color:currentColor;}' +
  'html.dark mark.htmlit-cm{background:color-mix(in srgb,#a371f7 16%,transparent)!important;border-bottom-color:color-mix(in srgb,#a371f7 60%,transparent);}' +
  // An answered comment anchor reads as a link to its answer: a solid underline.
  'mark.htmlit-cm-answered{border-bottom:2px solid #7c3aed;background:color-mix(in srgb,#7c3aed 14%,transparent)!important;}' +
  'html.dark mark.htmlit-cm-answered{border-bottom-color:#a371f7;background:color-mix(in srgb,#a371f7 20%,transparent)!important;}' +
  '.mermaid svg,.mermaid svg *{-webkit-user-select:none;-moz-user-select:none;user-select:none;}' +
  '.mermaid{position:relative!important;width:100%;height:clamp(260px,52vh,480px)!important;min-height:0!important;margin:14px 0;box-sizing:border-box;overflow:hidden;border:1px solid rgba(0,0,0,.13);border-radius:12px;background:#fcfcfd;}' +
  '.mermaid svg{max-width:100%!important;width:100%!important;height:100%!important;display:block;}' +
  'html.dark .mermaid{border-color:rgba(255,255,255,.13);background:#1b1c21;}' +
  '.htmlit-code{margin:14px 0;border-radius:8px;overflow:hidden;background:#fff;}' +
  'html.dark .htmlit-code{background:#0d1117;}' +
  // A diff keeps its framed box and titled header; a plain code block is borderless.
  '.htmlit-code.htmlit-diff{border:1px solid rgba(128,128,140,.28);}' +
  'html.dark .htmlit-code.htmlit-diff{border-color:rgba(140,140,160,.26);}' +
  '.htmlit-code-hd{font:600 11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;background:rgba(128,128,140,.09);padding:6px 12px;border-bottom:1px solid rgba(128,128,140,.22);}' +
  'html.dark .htmlit-code-hd{color:#8b949e;background:rgba(255,255,255,.04);border-bottom-color:rgba(140,140,160,.2);}' +
  // Plain code header: no bar, just the language on the left and Copy on the right.
  '.htmlit-code:not(.htmlit-diff)>.htmlit-code-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;background:transparent;border-bottom:0;padding:4px 6px 2px;}' +
  '.htmlit-copy{font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:none;letter-spacing:0;color:#57606a;background:rgba(128,128,140,.1);border:1px solid rgba(128,128,140,.3);border-radius:6px;padding:4px 9px;cursor:pointer;}' +
  '.htmlit-copy:hover{background:rgba(128,128,140,.2);color:#1f2328;}' +
  'html.dark .htmlit-copy{color:#9198a1;background:rgba(255,255,255,.06);border-color:rgba(140,140,160,.24);}' +
  'html.dark .htmlit-copy:hover{background:rgba(255,255,255,.11);color:#e6edf3;}' +
  '.htmlit-copy.htmlit-copied{color:#1a7f37;border-color:rgba(26,127,55,.5);}' +
  'html.dark .htmlit-copy.htmlit-copied{color:#3fb950;border-color:rgba(63,185,80,.5);}' +
  '.htmlit-code-body{display:flex;overflow-x:auto;background:#fff;}' +
  'html.dark .htmlit-code-body{background:#0d1117;}' +
  '.htmlit-linenos{position:sticky;left:0;z-index:1;flex:0 0 auto;box-sizing:border-box;text-align:right;padding:12px 12px;white-space:pre;user-select:none;color:#c2c8d0;background:inherit;border-right:1px solid rgba(128,128,140,.2);}' +
  'html.dark .htmlit-linenos{color:#4b5563;}' +
  '.htmlit-code-body>pre{margin:0!important;padding:12px 16px!important;flex:1 1 auto;min-width:0;overflow:visible!important;background:transparent!important;border:0!important;border-radius:0!important;}' +
  '.htmlit-code-body>pre>code{background:transparent!important;padding:0!important;overflow:visible!important;white-space:pre!important;display:block;}' +
  '.htmlit-code-body>pre>code,.htmlit-linenos{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace!important;font-size:13px!important;line-height:1.55!important;tab-size:2;}' +
  '.htmlit-diff .htmlit-code-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;-webkit-user-select:none;user-select:none;}' +
  '.htmlit-diff-toggle{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid rgba(128,128,140,.22);border-radius:999px;background:rgba(255,255,255,.55);}' +
  'html.dark .htmlit-diff-toggle{background:rgba(0,0,0,.2);border-color:rgba(140,140,160,.24);}' +
  '.htmlit-diff-toggle label{position:relative;cursor:pointer;}' +
  '.htmlit-diff-toggle input{position:absolute;opacity:0;pointer-events:none;}' +
  '.htmlit-diff-toggle span{display:block;padding:2px 8px;border-radius:999px;color:#6b7280;}' +
  '.htmlit-diff-toggle label:has(input:checked) span{background:#fff;color:#374151;box-shadow:0 1px 2px rgba(0,0,0,.12);}' +
  'html.dark .htmlit-diff-toggle span{color:#8b949e;}' +
  'html.dark .htmlit-diff-toggle label:has(input:checked) span{background:#1f2937;color:#d1d5db;}' +
  '.htmlit-diff-scroll{overflow-x:auto;background:#fff;}' +
  'html.dark .htmlit-diff-scroll{background:#0d1117;}' +
  '.htmlit-diff-row{display:grid;align-items:stretch;}' +
  '.htmlit-diff-unified .htmlit-diff-row{grid-template-columns:44px 44px minmax(0,1fr);}' +
  '.htmlit-diff-split .htmlit-diff-row{grid-template-columns:40px minmax(0,1fr) 40px minmax(0,1fr);}' +
  '.htmlit-diff-hunk{grid-template-columns:1fr!important;background:rgba(128,128,140,.1);color:#6b7280;}' +
  'html.dark .htmlit-diff-hunk{background:rgba(255,255,255,.055);color:#8b949e;}' +
  '.htmlit-diff-unified .htmlit-diff-add{background:rgba(46,160,67,.16);}' +
  '.htmlit-diff-unified .htmlit-diff-del{background:rgba(248,81,73,.16);}' +
  'html.dark .htmlit-diff-unified .htmlit-diff-add{background:rgba(46,160,67,.22);}' +
  'html.dark .htmlit-diff-unified .htmlit-diff-del{background:rgba(248,81,73,.2);}' +
  '.htmlit-diff-split .htmlit-diff-hunk{background:rgba(128,128,140,.1);}' +
  'html.dark .htmlit-diff-split .htmlit-diff-hunk{background:rgba(255,255,255,.055);}' +
  '.htmlit-diff-split .htmlit-diff-del .htmlit-diff-old-no,.htmlit-diff-split .htmlit-diff-del .htmlit-diff-old-text{background:rgba(248,81,73,.16);}' +
  '.htmlit-diff-split .htmlit-diff-add .htmlit-diff-new-no,.htmlit-diff-split .htmlit-diff-add .htmlit-diff-new-text{background:rgba(46,160,67,.16);}' +
  'html.dark .htmlit-diff-split .htmlit-diff-del .htmlit-diff-old-no,html.dark .htmlit-diff-split .htmlit-diff-del .htmlit-diff-old-text{background:rgba(248,81,73,.2);}' +
  'html.dark .htmlit-diff-split .htmlit-diff-add .htmlit-diff-new-no,html.dark .htmlit-diff-split .htmlit-diff-add .htmlit-diff-new-text{background:rgba(46,160,67,.22);}' +
  '.htmlit-diff-split .htmlit-diff-filler{background:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(128,128,140,.1) 3px,rgba(128,128,140,.1) 6px);}' +
  'html.dark .htmlit-diff-split .htmlit-diff-filler{background:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(255,255,255,.06) 3px,rgba(255,255,255,.06) 6px);}' +
  '.htmlit-diff-no,.htmlit-diff-text,.htmlit-diff-old-text,.htmlit-diff-new-text,.htmlit-diff-hunk-text{box-sizing:border-box;padding:0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace!important;font-size:13px!important;line-height:1.55!important;tab-size:2;white-space:pre;}' +
  '.htmlit-diff-no{position:sticky;z-index:1;text-align:right;user-select:none;color:#8c959f;background:inherit;border-right:1px solid rgba(128,128,140,.2);}' +
  'html.dark .htmlit-diff-no{color:#6e7781;}' +
  '.htmlit-diff-del .htmlit-diff-old-no{color:#cf222e;}' +
  '.htmlit-diff-add .htmlit-diff-new-no{color:#1a7f37;}' +
  'html.dark .htmlit-diff-del .htmlit-diff-old-no{color:#f85149;}' +
  'html.dark .htmlit-diff-add .htmlit-diff-new-no{color:#3fb950;}' +
  '.htmlit-diff-old-no{left:0;}' +
  '.htmlit-diff-unified .htmlit-diff-new-no{left:44px;}' +
  '.htmlit-diff-split .htmlit-diff-new-no{left:50%;border-left:1px solid rgba(128,128,140,.25);}' +
  '.htmlit-diff-text,.htmlit-diff-old-text,.htmlit-diff-new-text,.htmlit-diff-hunk-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;}' +
  '.htmlit-diff-split{display:none;}' +
  '.htmlit-diff:has(.htmlit-diff-split-radio:checked) .htmlit-diff-unified{display:none;}' +
  '.htmlit-diff:has(.htmlit-diff-split-radio:checked) .htmlit-diff-split{display:block;}' +
  '.htmlit-diagram-error{margin:14px 0;}' +
  '.htmlit-diagram-error-note{font:600 13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#cf222e;margin:0 0 6px;}' +
  'html.dark .htmlit-diagram-error-note{color:#f85149;}';
export function injectBaseCss() {
  if (document.getElementById("htmlit-base-css")) return;
  var s = document.createElement("style");
  s.id = "htmlit-base-css";
  s.setAttribute("data-htmlit", "");
  s.textContent = BASE_CSS;
  // First in <head> so any equal-specificity rule the artifact declares wins by order.
  document.head.insertBefore(s, document.head.firstChild);
}
export function injectArtifactCss() {
  if (document.getElementById("htmlit-artifact-css")) return;
  var s = document.createElement("style");
  s.id = "htmlit-artifact-css";
  s.setAttribute("data-htmlit", "");
  s.textContent = ARTIFACT_CSS;
  document.head.appendChild(s);
}

/* export
   Save the review as a shareable file: a self-contained HTML report (diagrams,
   highlighted code and the current theme baked in, opens offline anywhere) or
   the browser's Print -> Save as PDF. Both drop the review chrome (panel, grid,
   zoom bars) and show every diagram fitted to its full content rather than the
   pannable viewport. */
var EXPORT_CSS =
  BASE_CSS +
  ARTIFACT_CSS +
  // Un-clip diagrams so the whole thing shows in a static report / on paper.
  ".mermaid{height:auto!important;min-height:0!important;overflow:visible!important;padding:10px!important;}" +
  ".mermaid svg{height:auto!important;max-height:none!important;}" +
  ".htmlit-diff-toggle{display:none!important;}.htmlit-diff-unified{display:block!important;}.htmlit-diff-split{display:none!important;}" +
  "@media print{@page{margin:12mm;}body{margin:0;}" +
  // Honour the review's theme on paper (dark stays dark) even when the print
  // dialog's "Background graphics" is off.
  "*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}" +
  "html{background:var(--htmlit-print-bg,#fff)!important;}" +
  ".mermaid,section,.htmlit-code,[data-htmlit-answer],pre,table,figure{break-inside:avoid;}}";

// The page background of the current theme (for print, so dark prints dark).
export function pageBg() {
  var b = getComputedStyle(document.body).backgroundColor;
  if (!b || b === "rgba(0, 0, 0, 0)" || b === "transparent") b = getComputedStyle(document.documentElement).backgroundColor;
  return (!b || b === "rgba(0, 0, 0, 0)" || b === "transparent") ? "#ffffff" : b;
}

// Fit every live diagram to its content; returns a fn that restores the views.
export function fitAllDiagrams() {
  var undos = [];
  diagramRegistry.forEach(function (d) {
    if (d && d.svg && d.svg.isConnected) { try { undos.push(d.fit()); } catch (e) {} }
  });
  return function () { undos.forEach(function (u) { try { u(); } catch (e) {} }); };
}

// Build a fully self-contained HTML string of the artifact (chrome stripped,
// diagrams fitted, hljs theme + framing CSS inlined). Async: fetches the hljs css.
export function buildReportHtml() {
  var restore = fitAllDiagrams();
  var clone = document.documentElement.cloneNode(true);
  restore(); // clone captured the fitted state; put the live views back at once
  clone.querySelectorAll("#htmlit-chrome,[data-htmlit],[data-htmlit-grid],[data-htmlit-tools]")
    .forEach(function (n) { n.remove(); });
  // Comment anchors are a live-review marker ("you asked here"), not shareable
  // content - unwrap them so the exported report keeps only the note highlights.
  clone.querySelectorAll("mark.htmlit-cm").forEach(function (m) {
    var p = m.parentNode; if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  });
  clone.style.removeProperty("margin-right");
  clone.style.setProperty("--htmlit-print-bg", pageBg()); // so the report prints in-theme
  var head = clone.querySelector("head");
  if (!head) { head = document.createElement("head"); clone.insertBefore(head, clone.firstChild); }
  return fetch(hljsLink.href).then(function (r) { return r.text(); }).catch(function () { return ""; })
    .then(function (hljsCss) {
      var meta = document.createElement("meta"); meta.setAttribute("charset", "utf-8");
      var title = document.createElement("title");
      title.textContent = (CFG.name || "report").replace(/\.[^.]+$/, "");
      var style = document.createElement("style");
      style.textContent = EXPORT_CSS + "\n" + (hljsCss || "");
      head.insertBefore(title, head.firstChild);
      head.insertBefore(meta, head.firstChild);
      head.appendChild(style);
      return "<!doctype html>\n" + clone.outerHTML;
    });
}

export function downloadFile(name, text, type) {
  var blob = new Blob([text], { type: type || "text/html;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.setAttribute("data-htmlit", "");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

export function flashBtn(btn, msg) {
  if (!btn) return;
  var prev = btn.textContent; btn.disabled = true; btn.textContent = msg;
  setTimeout(function () { btn.textContent = prev; btn.disabled = false; }, 1600);
}

export function exportHtml(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Saving\u2026"; }
  buildReportHtml().then(function (html) {
    var base = (CFG.name || "report").replace(/\.html?$/i, "");
    downloadFile(base + ".report.html", html, "text/html;charset=utf-8");
    flashBtn(btn, "Saved \u2713");
  }).catch(function () { flashBtn(btn, "Failed"); });
}

// The panel lives in a shadow root, so its @media print rules can't reach the
// artifact; add a print stylesheet to the main document once.
export function ensurePrintCss() {
  if (document.getElementById("htmlit-print-css")) return;
  var s = document.createElement("style");
  s.id = "htmlit-print-css";
  s.setAttribute("data-htmlit", "");
  s.setAttribute("media", "print");
  s.textContent =
    "@page{margin:12mm;}" +
    // Force the theme's colours/backgrounds onto paper so a dark review prints
    // dark even with the dialog's "Background graphics" unchecked.
    "*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}" +
    "html{margin-right:0!important;background:var(--htmlit-print-bg,#fff)!important;}" +
    "#htmlit-chrome{display:none!important;}" +
    "[data-htmlit-grid],[data-htmlit-tools]{display:none!important;}" +
    // Comment anchors are a live-review marker, not for print - flatten them.
    "mark.htmlit-cm{background:none!important;border-bottom:none!important;padding:0!important;}" +
    ".mermaid{height:auto!important;min-height:0!important;overflow:visible!important;break-inside:avoid;text-align:center;}" +
    ".mermaid svg{width:auto!important;height:auto!important;max-width:100%!important;max-height:240mm!important;display:inline-block!important;}" +
    ".htmlit-diff-toggle{display:none!important;}.htmlit-diff-unified{display:block!important;}.htmlit-diff-split{display:none!important;}" +
    "section,.htmlit-code,[data-htmlit-answer],pre,table,figure{break-inside:avoid;}";
  document.head.appendChild(s);
}

// Prepare/tear-down shared by the Export->Print button and a direct Ctrl+P
// (via beforeprint/afterprint): inject the print stylesheet, paint the page in
// the current theme, and fit every diagram; restore the live views afterwards.
var printFit = null;
export function preparePrint() {
  ensurePrintCss();
  document.documentElement.style.setProperty("--htmlit-print-bg", pageBg());
  if (!printFit) printFit = fitAllDiagrams();
}
export function endPrint() { if (printFit) { printFit(); printFit = null; } }

export function printPdf() {
  preparePrint();
  setTimeout(function () { window.print(); }, 60); // let the fitted view paint first
  setTimeout(endPrint, 60000); // safety net if afterprint never fires
}

// Fill in "You asked: ..." for answer blocks that did not carry their own question.
export function decorateAnswers() {
  var q = lastUserQuestion || "your last question";
  document.querySelectorAll("[data-htmlit-answer]").forEach(function (el) {
    if (inChrome(el)) return;
    var dq = el.getAttribute("data-question");
    if (dq == null || dq === "") el.setAttribute("data-question", q);
  });
}
// Detect content added on a morph by diffing a content signature of body's direct
// children (robust: Idiomorph reuses/replaces nodes, so node identity is unreliable).

export function wirePrintEvents() {
  window.addEventListener("beforeprint", preparePrint);
  window.addEventListener("afterprint", endPrint);
}
