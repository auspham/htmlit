export function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
export function api(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}
export function inChrome(node) {
  return !!(node && node.closest && node.closest("#htmlit-chrome, [data-htmlit]"));
}
export function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement("script");
    s.src = src;
    s.setAttribute("data-htmlit", "");
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
}
// A CSS selector that re-resolves to this exact element - sent to the agent and
// used to re-anchor a selection after a morph. It must be rooted (at an ancestor
// id, otherwise <body>): an unrooted path such as "div:nth-of-type(1) > ul > li"
// floats, so document.querySelector can match a deeper, earlier subtree with the
// same tag/nth-of-type skeleton and resolve to the wrong element.
export function cssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return "#" + CSS.escape(el.id);
  var parts = [];
  var node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); return parts.join(" > "); }
    var sel = node.nodeName.toLowerCase();
    var parent = node.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === node.nodeName; });
      if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(sel);
    node = node.parentElement;
  }
  parts.unshift("body");
  return parts.join(" > ");
}
// Copy text to the clipboard, falling back to a hidden textarea + execCommand.
export function copyText(t) {
  try { if (navigator.clipboard) return navigator.clipboard.writeText(t); } catch (e) {}
  try {
    var ta = document.createElement("textarea"); ta.value = t; ta.setAttribute("data-htmlit", "");
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  } catch (e) {}
}
