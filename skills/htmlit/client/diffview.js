var diffId = 0;

/**
 * @typedef {"hunk" | "ctx" | "add" | "del"} DiffLineType
 * @typedef {{type: DiffLineType, text: string, oldNo: number | null, newNo: number | null}} DiffLine
 */

/**
 * Parse unified diff text into line records with old and new line numbers.
 *
 * @param {string} source unified diff source
 * @returns {DiffLine[]} parsed diff lines
 */
export function parseDiff(source) {
  var oldNo = 1;
  var newNo = 1;
  return source.replace(/\n+$/, "").split("\n").map(function (line) {
    var hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      return { type: "hunk", text: line, oldNo: null, newNo: null };
    }
    if (/^(@@|diff |index |--- |\+\+\+ |\\ )/.test(line)) {
      return { type: "hunk", text: line, oldNo: null, newNo: null };
    }
    if (line.charAt(0) === "-") {
      var delNo = oldNo;
      oldNo += 1;
      return { type: "del", text: line.slice(1), oldNo: delNo, newNo: null };
    }
    if (line.charAt(0) === "+") {
      var addNo = newNo;
      newNo += 1;
      return { type: "add", text: line.slice(1), oldNo: null, newNo: addNo };
    }
    var ctxOldNo = oldNo;
    var ctxNewNo = newNo;
    oldNo += 1;
    newNo += 1;
    return { type: "ctx", text: line.charAt(0) === " " ? line.slice(1) : line, oldNo: ctxOldNo, newNo: ctxNewNo };
  });
}

/**
 * Replace a diff code block with the native htmlit diff renderer.
 *
 * @param {HTMLElement} code code.language-diff element inside a pre
 * @returns {HTMLDivElement} rendered diff figure
 */
export function renderDiff(code) {
  var pre = code.parentElement;
  var source = code.textContent;
  var lines = parseDiff(source);
  var fig = document.createElement("div");
  var name = "htmlit-diff-" + (++diffId);
  fig.className = "htmlit-code htmlit-diff";
  fig.appendChild(header(name));
  fig.appendChild(unifiedView(lines));
  fig.appendChild(splitView(lines));
  pre.replaceWith(fig);
  return fig;
}

/**
 * Build the diff header with a CSS-only view toggle.
 *
 * @param {string} name unique radio group name
 * @returns {HTMLDivElement} header element
 */
function header(name) {
  var hd = document.createElement("div");
  hd.className = "htmlit-code-hd";
  var title = document.createElement("span");
  title.textContent = "diff";
  var toggle = document.createElement("span");
  toggle.className = "htmlit-diff-toggle";
  toggle.setAttribute("aria-label", "Diff view");
  toggle.appendChild(toggleOption(name, "unified", "Unified", true));
  toggle.appendChild(toggleOption(name, "split", "Split", false));
  hd.appendChild(title);
  hd.appendChild(toggle);
  return hd;
}

/**
 * Build one radio-backed toggle option.
 *
 * @param {string} name radio group name
 * @param {string} value option value
 * @param {string} label option label
 * @param {boolean} checked whether this option starts selected
 * @returns {HTMLLabelElement} label element
 */
function toggleOption(name, value, label, checked) {
  var wrap = document.createElement("label");
  var input = document.createElement("input");
  var text = document.createElement("span");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.className = "htmlit-diff-" + value + "-radio";
  input.checked = checked;
  text.textContent = label;
  wrap.appendChild(input);
  wrap.appendChild(text);
  return wrap;
}

/**
 * Render the unified diff view.
 *
 * @param {DiffLine[]} lines parsed diff lines
 * @returns {HTMLDivElement} scrollable unified view
 */
function unifiedView(lines) {
  var view = diffScroll("htmlit-diff-unified");
  lines.forEach(function (line) {
    if (line.type === "hunk") view.appendChild(hunkRow("unified", line.text));
    else {
      var row = rowEl("htmlit-diff-row htmlit-diff-" + line.type);
      row.appendChild(noCell("htmlit-diff-old-no", line.oldNo));
      row.appendChild(noCell("htmlit-diff-new-no", line.newNo));
      row.appendChild(textCell("htmlit-diff-text", line.text));
      view.appendChild(row);
    }
  });
  return view;
}

/**
 * Render the split diff view.
 *
 * @param {DiffLine[]} lines parsed diff lines
 * @returns {HTMLDivElement} scrollable split view
 */
function splitView(lines) {
  var view = diffScroll("htmlit-diff-split");
  splitRows(lines).forEach(function (pair) {
    if (pair.hunk) view.appendChild(hunkRow("split", pair.hunk));
    else {
      var row = rowEl("htmlit-diff-row" + (pair.left ? " htmlit-diff-" + pair.left.type : "") + (pair.right ? " htmlit-diff-" + pair.right.type : ""));
      var leftFill = pair.left ? "" : " htmlit-diff-filler";
      var rightFill = pair.right ? "" : " htmlit-diff-filler";
      row.appendChild(noCell("htmlit-diff-old-no" + leftFill, pair.left ? pair.left.oldNo : null));
      row.appendChild(textCell("htmlit-diff-old-text" + leftFill, pair.left ? pair.left.text : ""));
      row.appendChild(noCell("htmlit-diff-new-no" + rightFill, pair.right ? pair.right.newNo : null));
      row.appendChild(textCell("htmlit-diff-new-text" + rightFill, pair.right ? pair.right.text : ""));
      view.appendChild(row);
    }
  });
  return view;
}

/**
 * Group split rows so adjacent deletion and addition runs share physical rows.
 *
 * @param {DiffLine[]} lines parsed diff lines
 * @returns {{hunk?: string, left?: DiffLine | null, right?: DiffLine | null}[]} split row records
 */
function splitRows(lines) {
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.type === "hunk") rows.push({ hunk: line.text });
    else if (line.type === "ctx") rows.push({ left: line, right: line });
    else if (line.type === "del") {
      var dels = [];
      var adds = [];
      while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
      i -= 1;
      pushPairs(rows, dels, adds);
    } else if (line.type === "add") {
      var loneAdds = [];
      while (i < lines.length && lines[i].type === "add") loneAdds.push(lines[i++]);
      i -= 1;
      pushPairs(rows, [], loneAdds);
    }
  }
  return rows;
}

/**
 * Append paired split rows.
 *
 * @param {{left?: DiffLine | null, right?: DiffLine | null}[]} rows output rows
 * @param {DiffLine[]} left left-side lines
 * @param {DiffLine[]} right right-side lines
 * @returns {void}
 */
function pushPairs(rows, left, right) {
  var count = Math.max(left.length, right.length);
  for (var i = 0; i < count; i++) rows.push({ left: left[i] || null, right: right[i] || null });
}

/**
 * Build a scrollable view container.
 *
 * @param {string} className view class
 * @returns {HTMLDivElement} container
 */
function diffScroll(className) {
  var div = document.createElement("div");
  div.className = "htmlit-diff-scroll " + className;
  return div;
}

/**
 * Build a row element.
 *
 * @param {string} className row class
 * @returns {HTMLDivElement} row element
 */
function rowEl(className) {
  var row = document.createElement("div");
  row.className = className;
  return row;
}

/**
 * Build a hunk row.
 *
 * @param {"unified" | "split"} mode diff view mode
 * @param {string} text hunk text
 * @returns {HTMLDivElement} row element
 */
function hunkRow(mode, text) {
  var row = rowEl("htmlit-diff-row htmlit-diff-hunk");
  row.appendChild(textCell("htmlit-diff-hunk-text", text));
  row.dataset.mode = mode;
  return row;
}

/**
 * Build a line-number cell.
 *
 * @param {string} className cell class
 * @param {number | null} no line number
 * @returns {HTMLSpanElement} cell element
 */
function noCell(className, no) {
  var span = document.createElement("span");
  span.className = "htmlit-diff-no " + className;
  span.setAttribute("aria-hidden", "true");
  span.textContent = no == null ? "" : String(no);
  return span;
}

/**
 * Build a text cell using textContent so diff content cannot inject HTML.
 *
 * @param {string} className cell class
 * @param {string} text cell text
 * @returns {HTMLSpanElement} cell element
 */
function textCell(className, text) {
  var span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
