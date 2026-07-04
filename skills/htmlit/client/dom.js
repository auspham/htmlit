import { CFG, PANEL_W } from "./state.js";

export var host = document.createElement("div");
host.id = "htmlit-chrome";
host.setAttribute("data-htmlit", "");
export var shadow = host.attachShadow({ mode: "open" });
document.body.appendChild(host);
// reserve space so the always-on panel never covers the artifact
document.documentElement.style.setProperty("margin-right", PANEL_W + "px");

export var root = document.createElement("div");
root.className = "root";
root.style.setProperty("--htmlit-w", PANEL_W + "px");
shadow.appendChild(root);

export var ICON_HL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
export var ICON_COMMENT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.6A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg>';
export var ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>';

root.innerHTML =
  '<div class="hls"></div>' +
  '<div class="markers"></div>' +
  '<div class="rail"></div>' +
  '<aside class="panel" aria-label="htmlit review">' +
  '  <div class="head">' +
  '    <span class="title"></span>' +
  '    <span class="presence" data-state="waiting">no agent</span>' +
  '  </div>' +
  '  <div class="controls">' +
  '    <label class="switch"><input type="checkbox" data-act="theme"><span class="track"></span><span class="lbl">Dark</span></label>' +
  '    <label class="switch"><input type="checkbox" data-act="persist"><span class="track"></span><span class="lbl">Keep</span></label>' +
  '    <button class="link" data-act="reload">Reload</button>' +
  '  </div>' +
  '  <div class="exports">' +
  '    <span class="xlead">Export</span>' +
  '    <button class="xbtn" data-act="exporthtml" title="Download a self-contained HTML report to share">HTML</button>' +
  '    <button class="xbtn" data-act="exportpdf" title="Open the print dialog to save as PDF">Print / PDF</button>' +
  '  </div>' +
  '  <div class="keephint hidden"></div>' +
  '  <div class="noagent" hidden>No agent is polling this review. Messages are queued until an agent runs <code>htmlit poll</code>.</div>' +
  '  <div class="banner hidden"></div>' +
  '  <div class="log"></div>' +
  '  <div class="pills"></div>' +
  '  <div class="composer">' +
  '    <div class="ce" contenteditable="true" role="textbox" aria-multiline="true" data-ph="Message your agent, or select text on the page to highlight or comment\u2026"></div>' +
  '    <div class="row">' +
  '      <span class="hint"></span><span class="grow"></span>' +
  '      <button class="btn ghost" data-act="sendend">Send &amp; end</button>' +
  '      <button class="btn" data-act="send">Send</button>' +
  '    </div>' +
  '  </div>' +
  '</aside>' +
  '<div class="selmenu">' +
  '  <button type="button" data-act="hlmark" title="Highlight - a local note saved with the file, not sent to the agent">' + ICON_HL + '<span class="lbl">Highlight</span></button>' +
  '  <button type="button" data-act="hlcomment" title="Ask the agent about this">' + ICON_COMMENT + '<span class="lbl">Ask agent</span></button>' +
  '  <button type="button" data-act="hlremove" title="Remove this highlight">' + ICON_TRASH + '<span class="lbl">Remove</span></button>' +
  '</div>' +
  '<div class="pop">' +
  '  <div class="poplabel">Comment on this</div>' +
  '  <div class="ce" contenteditable="true" role="textbox" aria-multiline="true" data-ph="What should change here?"></div>' +
  '  <div class="row"><span class="grow"></span>' +
  '    <button class="btn ghost" data-act="popcancel">Cancel</button>' +
  '    <button class="btn" data-act="popadd">Queue</button>' +
  '  </div>' +
  '</div>';

export var ui = {
  hls: root.querySelector(".hls"),
  markers: root.querySelector(".markers"),
  rail: root.querySelector(".rail"),
  selmenu: root.querySelector(".selmenu"),
  selMark: root.querySelector('[data-act="hlmark"]'),
  selComment: root.querySelector('[data-act="hlcomment"]'),
  selRemove: root.querySelector('[data-act="hlremove"]'),
  title: root.querySelector(".title"),
  presence: root.querySelector(".presence"),
  noagent: root.querySelector(".noagent"),
  banner: root.querySelector(".banner"),
  log: root.querySelector(".log"),
  pills: root.querySelector(".pills"),
  input: root.querySelector(".composer .ce"),
  hint: root.querySelector(".hint"),
  send: root.querySelector('[data-act="send"]'),
  sendend: root.querySelector('[data-act="sendend"]'),
  theme: root.querySelector('[data-act="theme"]'),
  persist: root.querySelector('[data-act="persist"]'),
  keephint: root.querySelector(".keephint"),
  pop: root.querySelector(".pop"),
  popLabel: root.querySelector(".pop .poplabel"),
  popText: root.querySelector(".pop .ce"),
};
ui.title.textContent = CFG.name || "artifact";
// Put the launching Copilot session's name in the browser tab title, so multiple
// htmlit pages (from different sessions) are easy to tell apart. Re-applied after a
// morph, since morphing the <head> can restore the artifact's own <title>.
export function applyDocTitle() {
  if (CFG.name) { try { document.title = CFG.name; } catch (e) {} }
}
applyDocTitle();

fetch("/htmlit-client/client.css")
  .then(function (r) { return r.text(); })
  .then(function (css) {
    var style = document.createElement("style");
    style.textContent = css;
    shadow.insertBefore(style, root);
  });
