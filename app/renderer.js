// agent-tile Renderer: Webview, Terminal-Panes mit Glow, Agent-Panel.

const STATUS_LABEL = { done: "fertig", waiting: "wartet auf Input" };
const SUBAGENTS_SHOWN = 6;
const DIFF_MAX_LINES = 5000;
const RECENT_SHOWN = 5;

let paths;
let sessions = [];
let pins = [];
const sessionStatus = new Map(); // sessionId → "waiting" | "done" (letztes Hook-Event)
const panes = new Map(); // paneId → { sessionId, cwd, pid, hidden, el, term, fit }
const usage = new Map(); // sessionId → { ts, context, contextTokens, contextSize, cost, fiveHour, sevenDay }
const permissions = new Map(); // sessionId → { paneId, message }: offene Rückfrage nach einer Erlaubnis
const openTrees = new Set(); // Sessions mit aufgeklapptem Subagent-Baum
let warnSession = null; // Session, deren Karte gerade "läuft draußen" anzeigt
let warnMessage = "";
let paneCounter = 0;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const projectName = (project) => project.split(/[\\/]/).filter(Boolean).pop() || "~";
const shortPath = (dir) => (dir.startsWith(paths.home) ? "~" + dir.slice(paths.home.length) : dir);

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
}

// --- Webview -----------------------------------------------------------------

async function setupWeb() {
  const web = $("web");
  // Ohne "Electron/…" im User-Agent, sonst lehnen manche Logins eingebettete Browser ab
  web.setAttribute("useragent", navigator.userAgent.replace(/ Electron\/\S+/, "").replace(/ agent-tile\/\S+/, ""));
  const css = await (await fetch("claude.css")).text();
  web.addEventListener("dom-ready", () => web.insertCSS(css));
  web.src = "https://claude.ai";
}

// --- Terminal-Panes ----------------------------------------------------------

// existing: an eine laufende Session im ptyhost anhängen (nach Neustart der App), paneId = deren Name.
// resume: Claude-Session-ID, die fortgesetzt wird (main frischt vorher die Pin-Kopie auf).
async function openPane({ paneId = null, sessionId = null, cwd, command, args = [], existing = false, resume = null }) {
  paneId ??= `pane-${Date.now()}-${++paneCounter}`;

  const node = el("section", "pane");
  const head = el("div", "pane-head");
  const title = el("span", "pane-title", `${shortPath(cwd)} · claude`);
  const status = el("span", "pane-status");
  const usageLabel = el("span", "pane-usage");
  // × blendet nur aus: die Session läuft weiter und steht unten im Panel
  const close = el("button", "pane-close", "×");
  close.type = "button";
  close.title = "Ausblenden (läuft weiter, unten im Panel)";
  close.setAttribute("aria-label", "Session ausblenden");
  close.addEventListener("click", () => hidePane(paneId));
  const diffButton = el("button", "pane-tool pane-diff-toggle", "Diff");
  diffButton.type = "button";
  diffButton.title = "Änderungen im Projektordner anzeigen";
  diffButton.addEventListener("click", () => toggleDiff(paneId));
  const killButton = endButton("pane-tool pane-kill", () => endSession({ paneId }));
  head.append(title, status, usageLabel, diffButton, killButton, close);
  const body = el("div", "pane-body");
  const diffView = el("div", "pane-diff");
  diffView.hidden = true;
  node.append(head, body, diffView);
  $("tiles").append(node);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 12.5,
    lineHeight: 1.2,
    allowTransparency: true,
    cursorBlink: true,
    scrollback: 10000,
    theme: { background: "#00000000", foreground: "#c8cfdc", cursor: "#8fd3ff", selectionBackground: "#8fd3ff40" },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);
  term.onData((data) => window.tile.writePty(paneId, data));
  setupClipboard(paneId, term, body);
  setupDrop(node, term);
  // Selbst im Terminal geantwortet. Nur Tasten zählen: onData liefert auch Fokus- und Maus-Meldungen.
  term.onKey(() => clearPermission(panes.get(paneId)?.sessionId));
  term.textarea.addEventListener("focus", () => {
    setPaneStatus(paneId, null);
    wm.setFocused(paneId);
  });

  const pane = { sessionId, cwd, pid: null, hidden: false, el: node, term, fit };
  panes.set(paneId, pane);
  wm.add(paneId, node);
  wm.enableDrag(paneId, head);
  try {
    pane.pid = await window.tile.openPty({ paneId, cwd, command, args, sessionId, existing, resume });
  } catch (err) {
    const message = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    term.write(`\x1b[31mSession startet nicht: ${message}\x1b[0m\r\n`);
    return;
  }
  fitAll();
  wm.focus(paneId);
}

// --- Kopieren, Einfügen, Mausrad ---------------------------------------------
// Markieren mit der Maus kopiert sofort. Doppelklick markiert die ganze Zeile (umbrochene Zeilen mit).
// Strg+Shift+C kopiert, Strg+Shift+V und Shift+Einfg fügen ein.

function copySelection(term) {
  const text = term.getSelection().replace(/[ \t]+$/gm, "");
  if (text) window.tile.copy(text);
}

function selectLine(term) {
  const position = term.getSelectionPosition();
  if (!position) return;
  const buffer = term.buffer.active;
  let start = position.start.y;
  let end = position.start.y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  while (buffer.getLine(end + 1)?.isWrapped) end++;
  term.selectLines(start, end);
}

function setupClipboard(paneId, term, body) {
  body.addEventListener("mouseup", () => setTimeout(() => copySelection(term)));
  // Doppelklick: xterm markiert erst das Wort, danach auf die Zeile erweitern
  body.addEventListener("dblclick", () =>
    setTimeout(() => {
      selectLine(term);
      copySelection(term);
    })
  );

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
      copySelection(term);
      return false;
    }
    if ((e.ctrlKey && e.shiftKey && e.code === "KeyV") || (e.shiftKey && e.code === "Insert")) {
      window.tile.paste().then((text) => text && term.paste(text));
      return false;
    }
    return true;
  });

  // Mausrad macht xterm.js selbst: eigener Verlauf, im Vollbild-TUI von Claude geht es als Mausmeldung an Claude.
  // Markieren, solange Claude die Maus hält: mit gedrückter Shift-Taste.
}

// --- Drag and Drop -------------------------------------------------------------
// Dateien → ihre Pfade (in Anführungszeichen, falls nötig) als Eingabe, z. B. Bilder für Claude. Text → der Text.

// Windows-Pfade enthalten nie ein ", also genügen doppelte Anführungszeichen
const shellQuote = (p) => (/^[\w@%+=:,.\\/-]+$/.test(p) ? p : `"${p}"`);

function setupDrop(node, term) {
  node.addEventListener("dragover", (e) => {
    e.preventDefault();
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove("drop-target");
  });
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    node.classList.remove("drop-target");
    const files = [...e.dataTransfer.files].map((file) => window.tile.pathForFile(file)).filter(Boolean);
    const text = files.length ? files.map(shellQuote).join(" ") + " " : e.dataTransfer.getData("text/plain");
    if (text) {
      term.paste(text);
      term.focus();
    }
  });
}

// --- Diff-Ansicht ------------------------------------------------------------

async function toggleDiff(paneId) {
  const pane = panes.get(paneId);
  const view = pane.el.querySelector(".pane-diff");
  const button = pane.el.querySelector(".pane-diff-toggle");
  if (!view.hidden) {
    view.hidden = true;
    button.textContent = "Diff";
    return pane.term.focus();
  }
  view.hidden = false;
  button.textContent = "Terminal";
  view.replaceChildren(el("div", "diff-meta", "lädt …"));
  const result = await window.tile.gitDiff(pane.cwd);
  renderDiff(view, result);
  if (result.worktree) view.prepend(worktreeBar(paneId, result.worktree));
}

// Kopfzeile im Diff eines Worktrees: Branch → Ausgangs-Branch, Mergen oder Verwerfen
function worktreeBar(paneId, { branch, base }) {
  const pane = panes.get(paneId);
  const bar = el("div", "worktree-bar");
  const message = el("span", "worktree-message", `${branch} → ${base}`);
  const finish = async (merge) => {
    const question = merge
      ? `${branch} in ${base} mergen? Offene Änderungen werden vorher committet. Danach wird die Session beendet und der Worktree gelöscht.`
      : `${branch} verwerfen? Session, Worktree und Branch werden gelöscht, alle Änderungen sind weg.`;
    if (!confirm(question)) return;
    for (const button of bar.querySelectorAll("button")) button.disabled = true;
    message.textContent = merge ? "merget …" : "verwirft …";
    const result = await window.tile.finishWorktree({ paneId, cwd: pane.cwd, merge });
    if (!result.error) return; // Die Pane schließt sich, sobald die Session im ptyhost endet
    message.textContent = result.error;
    message.classList.add("worktree-error");
    for (const button of bar.querySelectorAll("button")) button.disabled = false;
  };
  const mergeButton = el("button", "primary", "Mergen");
  mergeButton.type = "button";
  mergeButton.addEventListener("click", () => finish(true));
  const dropButton = el("button", "", "Verwerfen");
  dropButton.type = "button";
  dropButton.addEventListener("click", () => finish(false));
  bar.append(message, mergeButton, dropButton);
  return bar;
}

function diffLineClass(line) {
  if (line.startsWith("diff --git")) return "diff-file";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "";
}

function renderDiff(view, { error, diff, untracked }) {
  if (error) return view.replaceChildren(el("div", "diff-meta", error));

  const lines = diff ? diff.replace(/\n$/, "").split("\n") : [];
  const nodes = lines.slice(0, DIFF_MAX_LINES).map((line) => el("div", diffLineClass(line), line || " "));
  if (lines.length > DIFF_MAX_LINES) nodes.push(el("div", "diff-meta", `… ${lines.length - DIFF_MAX_LINES} weitere Zeilen`));
  if (untracked.length) {
    nodes.push(el("div", "diff-file", `Neu, noch nicht im Git (${untracked.length})`));
    nodes.push(...untracked.map((file) => el("div", "diff-add", `+ ${file}`)));
  }
  view.replaceChildren(...(nodes.length ? nodes : [el("div", "diff-meta", "Keine Änderungen")]));
}

// Ausgeblendet = raus aus dem Layout, die PTY läuft weiter
function hidePane(paneId) {
  const pane = panes.get(paneId);
  pane.hidden = true;
  pane.el.hidden = true;
  wm.remove(paneId);
  renderPanel();
}

function showPane(paneId) {
  const pane = panes.get(paneId);
  if (pane.hidden) {
    pane.hidden = false;
    wm.add(paneId, pane.el);
  }
  renderPanel();
  wm.focus(paneId);
}

function setPaneStatus(paneId, status) {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (status) pane.el.dataset.status = status;
  else delete pane.el.dataset.status;
  pane.el.querySelector(".pane-status").textContent = STATUS_LABEL[status] ?? "";
}

function closePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  pane.term.dispose();
  pane.el.remove();
  panes.delete(paneId);
  wm.remove(paneId);
  renderPanel();
}

function fitAll() {
  for (const [paneId, pane] of panes) {
    if (pane.hidden || pane.el.hidden) continue;
    pane.fit.fit();
    // Solange das Fenster noch keine Größe hat, liefert fit 0 Spalten — das würde die PTY beenden
    if (pane.term.cols > 0 && pane.term.rows > 0) window.tile.resizePty(paneId, pane.term.cols, pane.term.rows);
  }
}

function paneOfSession(sessionId) {
  for (const [paneId, pane] of panes) if (pane.sessionId === sessionId) return paneId;
  return null;
}

// Läuft die Session in einem Claude-Prozess, der keiner Pane gehört?
function runsOutside(session) {
  return Boolean(session.pid) && ![...panes.values()].some((p) => p.pid === session.pid);
}

// Neue Sessions in einer Pane kennen ihre ID erst, wenn agentd die PID zuordnet
function linkPanesToSessions() {
  for (const [paneId, pane] of panes) {
    if (pane.sessionId || !pane.pid) continue;
    pane.sessionId = sessions.find((s) => s.pid === pane.pid)?.id ?? null;
    if (pane.sessionId) window.tile.tagPane(paneId, pane.sessionId);
  }
}

// Offene Session → einblenden; läuft sie draußen → erst warnen; sonst neue Pane mit claude --resume
function resume(session) {
  const open = paneOfSession(session.id);
  if (open) return showPane(open);
  if (runsOutside(session)) {
    warnSession = session.id;
    warnMessage = "";
    return renderPanel();
  }
  openResumePane(session);
}

function openResumePane(session) {
  openPane({
    sessionId: session.id,
    cwd: session.project,
    command: "claude",
    args: ["--resume", session.id],
    resume: session.id,
  });
}

async function takeOver(session, button) {
  button.disabled = true;
  button.textContent = "beendet …";
  const killed = await window.tile.killSession(session.pid, session.id);
  if (!killed) {
    warnMessage = "Prozess ließ sich nicht sicher zuordnen — draußen bitte selbst beenden.";
    return renderPanel();
  }
  warnSession = null;
  openResumePane(session);
  renderPanel();
}

function warning(session) {
  const box = el("div", "warn");
  box.addEventListener("click", (e) => e.stopPropagation());
  box.append(el("span", "", warnMessage || "Läuft in einem anderen Terminal. Zwei Instanzen würden dasselbe Transcript beschreiben."));
  const buttons = el("div", "warn-buttons");
  const take = el("button", "primary", "Draußen beenden & hier weiter");
  take.type = "button";
  take.addEventListener("click", () => takeOver(session, take));
  const cancel = el("button", "", "Abbrechen");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    warnSession = null;
    renderPanel();
  });
  buttons.append(take, cancel);
  box.append(buttons);
  return box;
}

// --- Web-Chat ein-/ausklappen (Zustand bleibt über Neustarts) ----------------

function setWebCollapsed(collapsed) {
  wm.setCollapsed("web", collapsed);
  const button = $("btn-web-toggle");
  button.textContent = collapsed ? "›" : "‹";
  button.title = collapsed ? "Aufklappen" : "Einklappen";
  button.setAttribute("aria-label", collapsed ? "Web-Chat aufklappen" : "Web-Chat einklappen");
  try {
    localStorage.setItem("webCollapsed", collapsed ? "1" : "");
  } catch {}
}

// --- Hook-Events: {ts, type, session, cwd, pane} -----------------------------

function onHookEvent(event) {
  const paneId = event.pane && panes.has(event.pane) ? event.pane : paneOfSession(event.session);
  if (paneId && !panes.get(paneId).sessionId) {
    panes.get(paneId).sessionId = event.session;
    window.tile.tagPane(paneId, event.session);
  }

  // Erlaubnis-Rückfrage in einer Pane → auf der Karte beantwortbar; jedes andere Event erledigt sie
  if (event.type === "waiting" && event.kind === "permission_prompt" && paneId) {
    permissions.set(event.session, { paneId, message: event.message || "Claude fragt nach einer Erlaubnis" });
  } else if (event.kind !== "idle_prompt") {
    permissions.delete(event.session);
  }

  if (event.type === "input") {
    sessionStatus.delete(event.session);
    if (paneId) setPaneStatus(paneId, null);
  } else {
    sessionStatus.set(event.session, event.type);
    if (paneId) setPaneStatus(paneId, event.type);
  }
  renderPanel();
}

// --- Erlaubnis aus dem Panel beantworten --------------------------------------
// Ja = Enter (erste Option "Yes" ist vorausgewählt), Nein = Esc. Gesendet wird nur, wenn der Dialog
// wirklich noch im Terminal steht — sonst landete Enter als Eingabe im Prompt.

function screenText(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let i = buffer.baseY; i < buffer.baseY + term.rows; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

function clearPermission(sessionId) {
  if (sessionId && permissions.delete(sessionId)) renderPanel();
}

function answerPermission(sessionId, yes) {
  const { paneId } = permissions.get(sessionId);
  const pane = panes.get(paneId);
  permissions.delete(sessionId);
  if (pane && /Do you want to/.test(screenText(pane.term))) {
    window.tile.writePty(paneId, yes ? "\r" : "\x1b");
    setPaneStatus(paneId, null);
    sessionStatus.delete(sessionId);
  }
  renderPanel();
}

function permissionBox(sessionId) {
  const box = el("div", "warn permission");
  box.addEventListener("click", (e) => e.stopPropagation());
  box.append(el("span", "", permissions.get(sessionId).message));
  const buttons = el("div", "warn-buttons");
  const yes = el("button", "primary", "Ja");
  yes.type = "button";
  yes.addEventListener("click", () => answerPermission(sessionId, true));
  const no = el("button", "", "Nein");
  no.type = "button";
  no.addEventListener("click", () => answerPermission(sessionId, false));
  const look = el("button", "", "Ansehen");
  look.type = "button";
  look.addEventListener("click", () => showPane(permissions.get(sessionId).paneId));
  buttons.append(yes, no, look);
  box.append(buttons);
  return box;
}

// --- Farbe aus /color: nur der Text der Pane-Kopfzeile -------------------------

const SESSION_COLORS = {
  red: "#ff6b6b",
  blue: "#6ea8ff",
  green: "#3ddc97",
  yellow: "#f5d547",
  purple: "#a78bfa",
  orange: "#ff9f43",
  pink: "#ff7ac6",
  cyan: "#5ee7f0",
};

function renderPaneColors() {
  for (const pane of panes.values()) {
    const color = SESSION_COLORS[sessions.find((s) => s.id === pane.sessionId)?.color] ?? "";
    pane.el.querySelector(".pane-title").style.color = color;
  }
}

// --- Verbrauch (agent-statusline.sh) ------------------------------------------

const percent = (value) => `${Math.round(value)} %`;

function contextLabel(sessionId) {
  const entry = usage.get(sessionId);
  return entry?.context == null ? "" : `Kontext ${percent(entry.context)}`;
}

function contextTitle(sessionId) {
  const entry = usage.get(sessionId);
  if (!entry) return "";
  const tokens = entry.contextTokens ? `${Math.round(entry.contextTokens / 1000)}k von ${Math.round(entry.contextSize / 1000)}k Tokens` : "";
  const cost = entry.cost ? ` · ${entry.cost.toFixed(2)} $ (API-Preis)` : "";
  return tokens + cost;
}

// resets_at kommt als Unix-Sekunden oder ISO-Text
const resetDate = (resetsAt) => new Date(typeof resetsAt === "number" ? resetsAt * 1000 : resetsAt);

function resetTime(resetsAt) {
  const date = resetDate(resetsAt);
  return isNaN(date) ? "" : date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

// Limits gelten fürs ganze Konto, aber jede Session kennt nur den Stand ihrer letzten Anfrage.
// Im neuesten Fenster (spätestes resets_at) wächst der Wert nur → der höchste ist der aktuellste.
function currentLimit(key) {
  const limits = [...usage.values()].map((e) => e[key]).filter((l) => l?.used_percentage != null);
  const newest = Math.max(...limits.map((l) => +resetDate(l.resets_at)));
  return limits
    .filter((l) => +resetDate(l.resets_at) === newest)
    .sort((a, b) => b.used_percentage - a.used_percentage)[0];
}

function renderLimits() {
  const fiveHour = currentLimit("fiveHour");
  const sevenDay = currentLimit("sevenDay");
  const parts = [];
  if (fiveHour) {
    const reset = resetTime(fiveHour.resets_at);
    parts.push(`5 h: ${percent(fiveHour.used_percentage)}${reset ? ` bis ${reset}` : ""}`);
  }
  if (sevenDay) parts.push(`Woche: ${percent(sevenDay.used_percentage)}`);
  $("limits").textContent = parts.join(" · ");
  $("limits").hidden = !parts.length;
}

function renderUsage() {
  for (const pane of panes.values()) {
    const label = pane.el.querySelector(".pane-usage");
    label.textContent = contextLabel(pane.sessionId);
    label.title = contextTitle(pane.sessionId);
    label.classList.toggle("full", (usage.get(pane.sessionId)?.context ?? 0) >= 80);
  }
  renderLimits();
}

function onUsage(entry) {
  usage.set(entry.session, entry);
  renderUsage();
}

// --- Session beenden ---------------------------------------------------------
// In einer Pane: Session im ptyhost schließen, Claude endet, die Pane geht mit zu.
// Draußen: Claude-Prozess beenden, aber nur nach Prüfung von PID und Startzeit (kill-session in main.js).
// Der Verlauf bleibt in beiden Fällen, die Session steht danach unter „Zuletzt“.

async function endSession({ paneId = null, session = null }) {
  const pane = paneId && panes.get(paneId);
  const name = projectName(pane ? pane.cwd : session.project);
  const title = session?.title ?? sessions.find((s) => s.id === pane?.sessionId)?.title ?? "";
  if (!confirm(`Session „${name}${title ? ` · ${title}` : ""}“ beenden?\n\nDer Verlauf bleibt, fortsetzen geht unter „Zuletzt“.`)) return;

  if (pane) return window.tile.closePty(paneId);
  if (!(await window.tile.killSession(session.pid, session.id))) {
    alert("Der Prozess ließ sich nicht sicher dieser Session zuordnen. Bitte im Terminal selbst beenden.");
  }
}

function endButton(className, onClick) {
  const button = el("button", className, "Beenden");
  button.type = "button";
  button.title = "Session beenden (Verlauf bleibt)";
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

// --- Panel -------------------------------------------------------------------

function sessionCard(session, now) {
  const waiting = sessionStatus.get(session.id) === "waiting";
  const outside = runsOutside(session);
  const card = el("div", `card${waiting ? " waiting" : ""}${outside ? " outside" : ""}`);
  card.tabIndex = 0;
  card.title = `Klick: fortsetzen · Rechtsklick: ${isPinned(session.id) ? "lösen" : "pinnen"}`;
  card.addEventListener("click", () => resume(session));
  card.addEventListener("keydown", (e) => e.key === "Enter" && resume(session));
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    togglePin(session);
  });

  const row = el("div", "card-row");
  const dot = el("span", waiting ? "dot dot-waiting" : "dot dot-done pulse");
  const meta = el("span", "card-meta", waiting ? "wartet" : outside ? "läuft draußen" : ago(now - session.mtime));
  row.append(dot, el("span", "card-name", projectName(session.project)));
  if (isPinned(session.id)) row.append(el("span", "card-meta", "gepinnt"));
  row.append(meta);
  if (usage.has(session.id)) row.append(el("span", "card-context", contextLabel(session.id)));

  if (session.subagents.length) {
    const open = openTrees.has(session.id);
    const toggle = el("button", "card-toggle", `${open ? "▾" : "▸"} ${session.subagents.length}`);
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Subagents anzeigen");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      open ? openTrees.delete(session.id) : openTrees.add(session.id);
      renderPanel();
    });
    row.append(toggle);
  }
  const paneId = paneOfSession(session.id);
  if (paneId || session.pid) row.append(endButton("card-kill", () => endSession({ paneId, session })));
  card.append(row, el("div", "card-title", session.title));
  if (permissions.has(session.id)) card.append(permissionBox(session.id));
  if (warnSession === session.id) card.append(warning(session));

  if (openTrees.has(session.id) && session.subagents.length) {
    const tree = el("div", "tree");
    for (const sub of session.subagents.slice(0, SUBAGENTS_SHOWN)) {
      const line = el("span", sub.active ? "sub-active" : "sub-done");
      const glyph = el("span", sub.active ? "glyph breathe" : "glyph", sub.active ? "◆" : "◇");
      line.append(glyph, ` ${sub.type || "agent"} · ${sub.description}${sub.active ? "" : " · fertig"}`);
      tree.append(line);
    }
    const rest = session.subagents.length - SUBAGENTS_SHOWN;
    if (rest > 0) tree.append(el("span", "sub-done", `+ ${rest} weitere`));
    card.append(tree);
  }
  return card;
}

// Ausgeblendete Pane: läuft weiter, Klick holt sie zurück
function backgroundCard(paneId, pane) {
  const session = sessions.find((s) => s.id === pane.sessionId);
  const waiting = sessionStatus.get(pane.sessionId) === "waiting";
  const card = el("div", waiting ? "card waiting" : "card backgrounded");
  card.tabIndex = 0;
  card.title = "Klick: wieder einblenden";
  card.addEventListener("click", () => showPane(paneId));
  card.addEventListener("keydown", (e) => e.key === "Enter" && showPane(paneId));

  const row = el("div", "card-row");
  row.append(
    el("span", waiting ? "dot dot-waiting" : "dot dot-done"),
    el("span", "card-name", projectName(pane.cwd)),
    el("span", "card-meta", waiting ? "wartet · ausgeblendet" : "ausgeblendet"),
    endButton("card-kill", () => endSession({ paneId }))
  );
  card.append(row, el("div", "card-title", session?.title ?? "neue Session"));
  if (permissions.has(pane.sessionId)) card.append(permissionBox(pane.sessionId));
  return card;
}

function recentRow(session, now) {
  const row = el("button", "pin");
  row.type = "button";
  row.title = `Klick: fortsetzen · Rechtsklick: ${isPinned(session.id) ? "lösen" : "pinnen"}`;
  row.append(
    el("span", "pin-name", `${projectName(session.project)} · ${session.title}`),
    el("span", "pin-action", ago(now - session.mtime))
  );
  row.addEventListener("click", () => resume(session));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    togglePin(session);
  });
  return row;
}

const isPinned = (sessionId) => pins.some((p) => p.id === sessionId);

// Rechtsklick schaltet um: pinnen bzw. wieder lösen
function togglePin(session) {
  window.tile.pin(isPinned(session.id) ? ["--remove", session.id] : [session.id, session.project, session.title]);
}

function pinRow(pin) {
  const row = el("button", "pin");
  row.type = "button";
  row.title = "Klick: fortsetzen · Rechtsklick: lösen";
  row.append(el("span", "pin-name", `${projectName(pin.project)} · ${pin.title}`), el("span", "pin-action", "resume"));
  row.addEventListener("click", () => resume(pin));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.tile.pin(["--remove", pin.id]);
  });
  return row;
}

// Das Panel wird ständig neu gebaut (jede Sekunde, bei jeder Änderung). Passiert das zwischen Drücken und
// Loslassen der Maus, ist der Knopf weg und der Klick verpufft → solange gedrückt ist, nicht neu bauen.
let panelPressed = false;
let panelStale = false;

function renderPanel() {
  if (panelPressed) {
    panelStale = true;
    return;
  }
  const now = Date.now();
  const backgrounded = [...panes].filter(([, p]) => p.hidden);
  const backgroundIds = new Set(backgrounded.map(([, p]) => p.sessionId));
  // Aktiv = ein Claude-Prozess läuft (auch wenn er gerade nichts tut). Nur "kürzlich geändert" reicht nicht:
  // eine gerade beendete Session stünde sonst noch 2 min als aktiv da.
  const active = sessions.filter((s) => s.pid && !backgroundIds.has(s.id));
  const shown = new Set([...active.map((s) => s.id), ...backgroundIds, ...pins.map((p) => p.id)]);
  const recent = sessions.filter((s) => !shown.has(s.id)).slice(0, RECENT_SHOWN);
  const waitingCount = active.filter((s) => sessionStatus.get(s.id) === "waiting").length;

  const cards = [...backgrounded.map(([id, p]) => backgroundCard(id, p)), ...active.map((s) => sessionCard(s, now))];
  $("active").replaceChildren(...(cards.length ? cards : [el("p", "empty", "Gerade läuft nichts")]));
  $("pinned").replaceChildren(...(pins.length ? pins.map(pinRow) : [el("p", "empty", "Noch nichts gepinnt")]));
  $("recent").replaceChildren(...recent.map((s) => recentRow(s, now)));
  $("count-active").textContent = `${active.length - waitingCount} aktiv`;
  $("count-waiting").textContent = `${waitingCount} wartet`;
}

function tick() {
  $("clock").textContent = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  renderPanel();
  renderUsage();
  renderPaneColors();
}

// --- Start -------------------------------------------------------------------

async function main() {
  paths = await window.tile.paths();
  const initial = await window.tile.initial();
  pins = initial.pins;
  sessions = initial.state.sessions;

  window.tile.onState((state) => {
    sessions = state.sessions;
    linkPanesToSessions();
    renderPanel();
  });
  window.tile.onPins((next) => { pins = next; renderPanel(); });
  window.tile.onEvent(onHookEvent);
  // Neben eine Pane gezogene Dateien würde Electron sonst als Seite öffnen
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());
  for (const entry of initial.usage) usage.set(entry.session, entry);
  window.tile.onUsage(onUsage);
  // Klick auf eine Desktop-Meldung: die Pane der Session zeigen
  window.tile.onFocusSession((paneId, sessionId) => {
    const target = panes.has(paneId) ? paneId : paneOfSession(sessionId);
    if (target) showPane(target);
  });
  window.tile.onPtyData((paneId, data) => panes.get(paneId)?.term.write(data));
  window.tile.onPtyExit(closePane);

  // Fensterverwaltung: Web-Chat ist das erste Fenster (Master), Terminals kommen in den Stapel
  wm.init({
    root: $("tiles"),
    placeholder: $("no-panes"),
    onFocus: (id) => {
      if (id === "web") $("web").focus();
      else if (id === "panel") $("panel").focus();
      else panes.get(id)?.term.focus();
    },
    // nach der Positions-Animation (0,2 s) die Terminals neu einpassen
    onLayout: () => {
      requestAnimationFrame(fitAll);
      setTimeout(fitAll, 220);
    },
  });
  // Win+F4: Terminal ausblenden, Web-Chat einklappen, das Panel bleibt
  wm.onClose = (id) => {
    if (id === "web") setWebCollapsed(true);
    else if (id !== "panel") hidePane(id);
  };
  wm.add("web", $("web-window"));
  wm.add("panel", $("panel"), { fixed: 318 }); // Höhe wie im Mockup, per Win+Strg änderbar
  wm.enableDrag("web", document.querySelector("#web-window .section-head"));
  wm.enableDrag("panel", document.querySelector("#panel .panel-head"));
  $("panel").tabIndex = -1;
  $("panel").addEventListener("pointerdown", () => (panelPressed = true));
  // erst nach dem click-Event wieder freigeben (click kommt direkt nach pointerup)
  const release = () =>
    setTimeout(() => {
      panelPressed = false;
      if (panelStale) {
        panelStale = false;
        renderPanel();
      }
    });
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", release); // losgelassen außerhalb des Fensters
  $("panel").addEventListener("focusin", () => wm.setFocused("panel"));
  $("web").addEventListener("focus", () => wm.setFocused("web"));
  // "quit" (Win+Shift+F4) gehört nicht zum Layout, sondern fragt, was beendet werden soll
  window.tile.onWm((line) => (line === "quit" ? window.tile.quit() : wm.command(line)));
  $("btn-quit").addEventListener("click", () => window.tile.quit());

  const webCollapsed = () => wm.collapsed === "web";
  $("btn-web").addEventListener("click", () => {
    setWebCollapsed(false);
    wm.focus("web");
  });
  $("btn-web-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    setWebCollapsed(!webCollapsed());
  });
  // Im eingeklappten Zustand klappt ein Klick irgendwo auf den Streifen auf
  $("web-window").addEventListener("click", () => {
    if (webCollapsed()) setWebCollapsed(false);
  });
  let startCollapsed = false;
  try {
    startCollapsed = localStorage.getItem("webCollapsed") === "1";
  } catch {}
  setWebCollapsed(startCollapsed);
  $("btn-teleport").addEventListener("click", () =>
    openPane({ cwd: paths.home, command: "claude", args: ["--teleport"] })
  );
  $("btn-new").addEventListener("click", async () => {
    const dir = await window.tile.pickFolder();
    if (dir) openPane({ cwd: dir, command: "claude", args: [] });
  });

  // Sessions, die einen Neustart der App überlebt haben (ptyhost), wieder anhängen
  for (const running of await window.tile.hostList().catch(() => [])) openPane({ ...running, existing: true });

  setupWeb();
  tick();
  setInterval(tick, 1000);
}

main();
