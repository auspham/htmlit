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
// a CSS selector for the element - sent to the agent, never shown to the user
export function cssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return "#" + CSS.escape(el.id);
  var parts = [];
  var node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
    var sel = node.nodeName.toLowerCase();
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
    var parent = node.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === node.nodeName; });
      if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(sel);
    node = node.parentElement;
  }
  return parts.join(" > ");
}
