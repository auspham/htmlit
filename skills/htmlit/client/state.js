/**
 * @typedef {"waiting"|"listening"|"working"} PresenceState
 * @typedef {"note"|"comment"} HighlightMarkKind
 * @typedef {{container: string, start: number, end: number, text: string}} TextRange
 * @typedef {{src: string, nodeKey: string}} DiagramTarget
 * @typedef {{id: string, kind: HighlightMarkKind, prompt: string, comments: (string[]|null), text: string, range: (TextRange|null), target: (DiagramTarget|null)}} Highlight
 * @typedef {{selector: string, tag: string, text: string, prompt: string, range: (TextRange|null), commentId: string}} Prompt
 */

export const Presence = Object.freeze({ WAITING: "waiting", LISTENING: "listening", WORKING: "working" });
export const SseEvent = Object.freeze({
  RELOAD: "reload", CHAT_SYNC: "chat-sync",
  AGENT_PRESENCE: "agent-presence", PERSIST: "persist", ENDED: "ended",
});
export const HighlightKind = Object.freeze({ NOTE: "note", COMMENT: "comment" });

export const CFG = window.__HTMLIT__ || {};
export const KEY = CFG.key || "";
export const VENDOR = CFG.vendor || {};
export const PANEL_W = 360;
export const RAIL_W = 300;

export const state = {
  queue: [],
  ended: false,
  persist: !!CFG.persist,
  presence: CFG.presence || Presence.WAITING,
  highlights: (CFG.highlights || []).slice(),
};
