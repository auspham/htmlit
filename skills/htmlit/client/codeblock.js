import { copyText } from "./util.js";

// A lightweight highlight.js grammar for Mermaid source, registered on first use, so
// the diagram "Code" view reads like code (diagram-type keywords, directions, quoted
// labels, edge-label pipes, arrows/links and %% comments). highlight.js ships no
// Mermaid language of its own, and the raw diagram block is turned into an SVG rather
// than highlighted, so this only styles the toggled source view.
function mermaidGrammar(hljs) {
  var TYPE = "graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 " +
    "erDiagram journey gantt pie gitGraph mindmap timeline quadrantChart requirementDiagram " +
    "sankey-beta xychart-beta block-beta";
  var KW = "subgraph end participant actor note over loop alt opt par and rect activate " +
    "deactivate direction click class style classDef linkStyle state as call href section " +
    "title autonumber";
  return {
    name: "mermaid",
    case_insensitive: true,
    keywords: { keyword: TYPE + " " + KW, literal: "LR RL TB TD BT true false" },
    contains: [
      hljs.COMMENT("%%", "$"),
      hljs.QUOTE_STRING_MODE,
      hljs.APOS_STRING_MODE,
      { className: "string", begin: /\|/, end: /\|/ },
      { className: "operator", begin: /<?[ox]?(?:-{2,}|-\.-+|={2,}|~{2,})[->ox]*/ },
      { className: "number", begin: /\b\d+(?:\.\d+)?\b/ },
    ],
  };
}

var mermaidRegistered = false;
// Syntax-highlight a <code> element holding Mermaid source, in place. No-op when
// highlight.js is unavailable (offline with no vendored copy) - the plain source
// still shows.
export function highlightMermaidSource(codeEl) {
  var hljs = window.hljs;
  if (!codeEl || !hljs || !hljs.registerLanguage) return;
  if (!mermaidRegistered) {
    try { hljs.registerLanguage("mermaid", mermaidGrammar); mermaidRegistered = true; } catch (e) { return; }
  }
  codeEl.className = "language-mermaid";
  codeEl.removeAttribute("data-highlighted");
  try { hljs.highlightElement(codeEl); } catch (e) {}
}

// A "Copy" button that copies getText() to the clipboard, with brief feedback.
export function makeCopyButton(getText) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "htmlit-copy";
  btn.textContent = "Copy";
  btn.title = "Copy to clipboard";
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    Promise.resolve(copyText(getText())).catch(function () {});
    btn.textContent = "Copied";
    btn.classList.add("htmlit-copied");
    clearTimeout(btn._copyReset);
    btn._copyReset = setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("htmlit-copied"); }, 1400);
  });
  return btn;
}

// Line count of a source string (trailing blank lines trimmed), at least 1.
export function lineCount(src) {
  src = (src || "").replace(/\n+$/, "");
  return src.length ? src.split("\n").length : 1;
}

// A right-aligned, non-selectable line-number gutter for a code-block body.
export function makeLinenos(count) {
  var gutter = document.createElement("span");
  gutter.className = "htmlit-linenos";
  gutter.setAttribute("aria-hidden", "true");
  var nums = [];
  for (var i = 1; i <= count; i++) nums.push(i);
  gutter.textContent = nums.join("\n");
  return gutter;
}
