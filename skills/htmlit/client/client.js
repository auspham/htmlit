/* htmlit client - injected before </body> in the served artifact.
   Builds an always-visible shadow-DOM panel (annotation + chat + theme), streams events over SSE, and morphs the live DOM on file change. Its nodes carry data-htmlit or live in a shadow root so morphing never disturbs them and artifact CSS never reaches the client. */

import { CFG, state } from "./state.js";
import { root, ui } from "./dom.js";
import { applyTheme, theme } from "./theme.js";
import { injectBaseCss, injectArtifactCss, exportHtml, printPdf, decorateAnswers, wirePrintEvents } from "./exporting.js";
import { detectNewContent, initContent } from "./content.js";
import { setPresence, refreshEmpty } from "./chat.js";
import { rebuildRail, scheduleRailPos } from "./rail.js";
import { send } from "./send.js";
import { applyHighlights, clearPending, commitComment, commitHighlight, commitRemove, openComment, hasPendingOrMenu, wireAnnotationEvents } from "./annotate.js";
import { wireOverlayEvents } from "./overlays.js";
import { connect, markEnded, reload, renderKeepHint, setPersist } from "./morph.js";

ui.theme.addEventListener("change", function () { applyTheme(ui.theme.checked ? "dark" : "light"); });
if (ui.persist) ui.persist.addEventListener("change", function () { setPersist(ui.persist.checked); });
root.querySelector('[data-act="reload"]').addEventListener("click", reload);
var exHtmlBtn = root.querySelector('[data-act="exporthtml"]');
var exPdfBtn = root.querySelector('[data-act="exportpdf"]');
if (exHtmlBtn) exHtmlBtn.addEventListener("click", function () { exportHtml(exHtmlBtn); });
if (exPdfBtn) exPdfBtn.addEventListener("click", printPdf);
ui.send.addEventListener("click", function () { send(false); });
ui.sendend.addEventListener("click", function () { send(true); });
ui.selmenu.querySelector('[data-act="hlmark"]').addEventListener("click", commitHighlight);
ui.selmenu.querySelector('[data-act="hlcomment"]').addEventListener("click", openComment);
ui.selmenu.querySelector('[data-act="hlremove"]').addEventListener("click", commitRemove);
root.querySelector('[data-act="popadd"]').addEventListener("click", commitComment);
root.querySelector('[data-act="popcancel"]').addEventListener("click", clearPending);
ui.input.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); }
});
ui.popText.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitComment(); }
  if (e.key === "Escape") clearPending();
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && hasPendingOrMenu()) clearPending(); });
root.addEventListener("input", function (e) {
  var t = e.target;
  if (!t || !t.classList || !t.classList.contains("ce")) return;
  if (!t.textContent) t.innerHTML = "";
  if (t.closest && t.closest(".rail")) scheduleRailPos();
});

wirePrintEvents();
wireAnnotationEvents();
wireOverlayEvents();
injectBaseCss();
injectArtifactCss();
applyTheme(theme);
setPresence(state.presence);
if (ui.persist) ui.persist.checked = state.persist;
renderKeepHint("live");
refreshEmpty();
decorateAnswers();
detectNewContent(true);
initContent();
applyHighlights();
rebuildRail(true);
connect();
if (state.ended || CFG.ended) markEnded();
