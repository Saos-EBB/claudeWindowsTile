// agent-tile (Windows): ein Fenster mit claude.ai (Webview), Claude-Code-Terminals und Agent-Panel.
// Der Main-Prozess spricht mit dem ptyhost (hält die Sessions), beobachtet die Dateien von agentd/Hooks/Pins
// und übernimmt Dialoge, Git, Pins und Meldungen.

const { app, BrowserWindow, ipcMain, dialog, Notification, clipboard } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const PIPE = require("./pipe.js");
const { procStart, isAlive, launchDetached, findNode } = require("./winproc.js");

const HOME = os.homedir();
const ROOT = path.join(__dirname, "..");
const CACHE = path.join(HOME, ".cache", "agent-tile");
const FILES = {
  state: path.join(CACHE, "state.json"),
  events: path.join(CACHE, "events.jsonl"),
  wm: path.join(CACHE, "wm"),
  usage: path.join(CACHE, "usage"), // <session>.json von agent-statusline.mjs
  agentdPid: path.join(CACHE, "agentd.pid"),
  pins: path.join(HOME, ".config", "agent-tile", "pins.json"),
  config: path.join(HOME, ".config", "agent-tile", "config.json"),
};
const PIN_STORE = path.join(HOME, "agent-tile", "pins");
const PROJECTS = path.join(HOME, ".claude", "projects");

// Fenstertitel "agent-tile" + electron.exe erkennt der Tasten-Helfer (keys/agent-keys.pyw)
app.setName("agent-tile");
app.setAppUserModelId("agent-tile"); // ohne AUMID zeigt Windows keine Meldungen

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => showTile());

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "agent-tile",
    backgroundMaterial: "acrylic", // Glass: Windows-11-Acryl hinter den halbtransparenten Flächen
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
    },
  });
  win.on("page-title-updated", (e) => e.preventDefault()); // Titel bleibt für den Tasten-Helfer fest
  win.loadFile("index.html");
}

function showTile() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = () => readJson(FILES.config, {});

// --- ptyhost ---------------------------------------------------------------
// Jede Pane ist eine Session im ptyhost (eigener, losgelöster Prozess). Beendet man die App, laufen die
// Sessions dort weiter, und beim nächsten Start hängt sich die App wieder an.

// Wurde die App aus einer Claude-Session gestartet, hielte sich jedes claude in einer Pane sonst für deren Kind
const INHERITED_CLAUDE_VARS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra, TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const name of INHERITED_CLAUDE_VARS) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

let host = null; // { socket, pending: Map<id, {resolve, reject}>, nextId }
let hostReady = null;
const attached = new Set(); // paneIds, an die diese App angehängt ist

function connectHost() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

function useHost(socket) {
  host = { socket, pending: new Map(), nextId: 1 };
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onHostMessage(JSON.parse(line));
    }
  });
  const lost = () => {
    if (host?.socket !== socket) return;
    for (const { reject } of host.pending.values()) reject(new Error("ptyhost getrennt"));
    host = null;
    hostReady = null;
    // Ohne Host gibt es die Sessions nicht mehr (Absturz oder „Alles beenden“)
    for (const paneId of attached) win?.webContents.send("pty:exit", paneId);
    attached.clear();
  };
  socket.on("close", lost);
  socket.on("error", lost);
}

function onHostMessage(msg) {
  if (msg.ev === "data") return win?.webContents.send("pty:data", msg.paneId, msg.d);
  if (msg.ev === "exit") {
    attached.delete(msg.paneId);
    return win?.webContents.send("pty:exit", msg.paneId);
  }
  const waiting = host?.pending.get(msg.re);
  if (!waiting) return;
  host.pending.delete(msg.re);
  msg.ok ? waiting.resolve(msg.result) : waiting.reject(new Error(msg.error));
}

// Den Host NICHT als Kind der App starten (er erbte sonst ihre Handles und hinge an ihr), sondern per WMI.
// Er läuft mit dem System-Node; die Umgebung für Claude schickt die App bei jeder neuen Session mit.
function ensureHost() {
  hostReady ??= connectHost()
    .catch(async () => {
      await launchDetached(findNode(), [path.join(__dirname, "ptyhost.js")], __dirname);
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          return await connectHost();
        } catch {}
      }
      throw new Error("ptyhost startet nicht (siehe ~/.cache/agent-tile/ptyhost.log)");
    })
    .then(useHost)
    .catch((err) => {
      hostReady = null;
      throw err;
    });
  return hostReady;
}

async function request(op, args = {}) {
  await ensureHost();
  const id = host.nextId++;
  return new Promise((resolve, reject) => {
    host.pending.set(id, { resolve, reject });
    host.socket.write(JSON.stringify({ id, op, ...args }) + "\n");
  });
}

// Ohne Antwort; die Reihenfolge auf der Pipe bleibt erhalten (Tasten, Größe)
function tell(op, args) {
  if (host && !host.socket.destroyed) host.socket.write(JSON.stringify({ op, ...args }) + "\n");
}

// claude.exe direkt starten (nicht claude.cmd): dann ist die PID der Pane die von Claude,
// und agentd ordnet sie über ~/.claude/sessions/<pid>.json der Session zu.
function claudeExe() {
  const configured = config().claude;
  if (configured) return configured;
  const dirs = (process.env.PATH || "").split(";").filter(Boolean);
  for (const dir of [...dirs, path.join(HOME, ".local", "bin")]) {
    const exe = path.join(dir, "claude.exe");
    if (fs.existsSync(exe)) return exe;
  }
  for (const dir of dirs) {
    try {
      const cmd = fs.readFileSync(path.join(dir, "claude.cmd"), "utf8");
      const rel = cmd.match(/"%dp0%\\?([^"]*claude\.exe)"/i)?.[1];
      if (rel && fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
    } catch {}
  }
  return "claude.exe";
}

// Laufende Sessions beim Start: paneId, Projektordner und Claude-Session-ID
ipcMain.handle("host:list", async () => (await request("list")).map(({ paneId, cwd, sessionId }) => ({ paneId, cwd, sessionId })));

// existing = an eine laufende Session im Host anhängen, sonst neue starten.
// resume = Claude-Session-ID, die fortgesetzt wird (vorher Pin-Kopie auffrischen bzw. zurücklegen).
ipcMain.handle("pty:open", async (_event, { paneId, cwd, command, args = [], sessionId, existing, resume }) => {
  if (!existing) {
    if (resume) restorePin(resume);
    const isClaude = command === "claude";
    await request("new", {
      paneId,
      cwd,
      file: isClaude ? claudeExe() : command,
      args: isClaude ? [...(config().claudeArgs ?? []), ...args] : args,
      env: cleanEnv({ AGENT_TILE_PANE: paneId }),
      cols: 80,
      rows: 24,
    });
    if (sessionId) await request("tag", { paneId, sessionId });
  }
  const { snapshot, pid } = await request("attach", { paneId });
  attached.add(paneId);
  // Bildschirm samt Verlauf zuerst, danach laufen die Daten der Session über dieselbe Pipe hinterher
  if (snapshot) win?.webContents.send("pty:data", paneId, snapshot);
  return pid;
});

// Claude-Session-ID merken, sobald sie bekannt ist (neue Sessions), damit sie den Neustart überlebt
ipcMain.on("host:tag", (_event, paneId, sessionId) => tell("tag", { paneId, sessionId }));
ipcMain.on("pty:write", (_event, paneId, d) => tell("write", { paneId, d }));
ipcMain.on("pty:resize", (_event, paneId, cols, rows) => tell("resize", { paneId, cols, rows }));
ipcMain.on("pty:close", (_event, paneId) => tell("kill", { paneId }));

ipcMain.on("clipboard:write", (_event, text) => clipboard.writeText(text));
ipcMain.handle("clipboard:read", () => clipboard.readText());

// --- agentd ----------------------------------------------------------------
// Läuft mit dem System-Node (≥ 22.18, Type-Stripping). Schreibt state.json alle 2 s;
// ist die Datei frisch, läuft er schon.

function startAgentd() {
  try {
    if (Date.now() - fs.statSync(FILES.state).mtimeMs < 6000) return;
  } catch {}
  launchDetached(findNode(), ["agentd.ts"], path.join(ROOT, "agentd")).catch((err) =>
    dialog.showErrorBox("agentd startet nicht", err.message)
  );
}

function stopAgentd() {
  const pid = Number(readJson(FILES.agentdPid, null)?.pid);
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
  }
}

// --- Dateien beobachten ----------------------------------------------------

// Verbrauch der letzten Tage genügt (Limits laufen nach 5 h bzw. 7 Tagen ab)
function readUsage() {
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  fs.mkdirSync(FILES.usage, { recursive: true });
  return fs
    .readdirSync(FILES.usage)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(FILES.usage, name), null))
    .filter((entry) => entry && entry.ts > since);
}

ipcMain.handle("data:initial", () => ({
  state: readJson(FILES.state, { sessions: [] }),
  pins: readJson(FILES.pins, []),
  usage: readUsage(),
}));

// Verzeichnis statt Datei beobachten: agentd ersetzt state.json per rename
function watchFile(file, onChange) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.watch(path.dirname(file), (_type, name) => {
    if (name === path.basename(file)) onChange();
  });
}

// Angehängte Zeilen einer Datei mitlesen (Hook-Events, Fensterbefehle vom Tasten-Helfer).
// Startet am aktuellen Ende: alte Zeilen zählen nicht.
function tail(file, onLine) {
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {}

  watchFile(file, () => {
    let text;
    try {
      const fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (size < offset) offset = 0;
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);
      offset = size;
      text = buffer.toString("utf8");
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) if (line) onLine(line);
  });
}

function startWatching() {
  watchFile(FILES.state, () => win?.webContents.send("data:state", readJson(FILES.state, { sessions: [] })));
  watchFile(FILES.pins, () => win?.webContents.send("data:pins", readJson(FILES.pins, [])));
  fs.mkdirSync(FILES.usage, { recursive: true });
  fs.watch(FILES.usage, (_type, name) => {
    if (!name?.endsWith(".json")) return;
    const entry = readJson(path.join(FILES.usage, name), null);
    if (entry) win?.webContents.send("data:usage", entry);
  });
  tail(FILES.events, (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    win?.webContents.send("data:event", event);
    notify(event);
  });
  // Eine Zeile pro Taste, z. B. "focus left" (keys/agent-keys.pyw)
  tail(FILES.wm, (line) => win?.webContents.send("wm", line));
}

// --- Benachrichtigungen ----------------------------------------------------
// Wartet eine Session oder ist fertig und die Tile hat gerade nicht den Fokus: Windows-Meldung,
// optional zusätzlich Push aufs Handy über ntfy (~/.config/agent-tile/config.json: {"ntfy": "<Topic-URL>"}).
// idle_prompt kommt ~60 s nach "fertig" und sagt nichts Neues → keine zweite Meldung.

function notify(event) {
  if (win?.isFocused() || (event.type !== "done" && event.type !== "waiting") || event.kind === "idle_prompt") return;

  const session = readJson(FILES.state, { sessions: [] }).sessions.find((s) => s.id === event.session);
  const title = path.basename(event.cwd || "") || "Claude";
  const body = event.type === "done" ? `fertig: ${session?.title ?? ""}` : event.message || "wartet auf Input";

  const note = new Notification({ title, body });
  note.on("click", () => {
    showTile();
    win?.webContents.send("focus-session", event.pane, event.session);
  });
  note.show();

  const ntfy = config().ntfy;
  if (ntfy) fetch(ntfy, { method: "POST", headers: { Title: title }, body }).catch(() => {});
}

// --- Beenden ---------------------------------------------------------------
// Win+Shift+F4 oder ⏻: nur das Fenster (Sessions laufen im ptyhost weiter) oder alles.

ipcMain.handle("quit", async () => {
  const running = (await request("list").catch(() => [])).length;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title: "agent-tile beenden",
    message: "agent-tile beenden",
    detail:
      `Nur Fenster schließen: die ${running} Session(s) laufen weiter, Win+A holt alles zurück.\n` +
      `Alles beenden: auch alle ${running} Session(s) und agentd. Der Verlauf bleibt, fortsetzen über „Zuletzt“.`,
    buttons: ["Nur Fenster schließen", "Alles beenden", "Abbrechen"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 2) return;
  if (response === 1) {
    await request("shutdown").catch(() => {});
    stopAgentd();
  }
  app.quit();
});

// --- Aktionen aus dem Panel ------------------------------------------------

// Ordner wählen; ist er ein Git-Repo, auf Wunsch einen eigenen Worktree anlegen.
// Liefert den Ordner, in dem die Session startet, oder null.
ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Neue Session",
    defaultPath: path.join(HOME, "dev"),
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  const dir = result.filePaths[0];

  const top = await git(dir, ["rev-parse", "--show-toplevel"]).then((out) => path.resolve(out.trim()), () => null);
  if (!top) return dir;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title: "Neue Session",
    message: `${path.basename(top)} ist ein Git-Repo.`,
    detail: "Ein eigener Worktree bekommt einen eigenen Branch und Ordner. So stören sich mehrere Agents am selben Repo nicht.",
    buttons: ["Eigener Worktree", "Direkt im Ordner", "Abbrechen"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 2) return null;
  if (response === 1) return dir;
  try {
    return await createWorktree(top);
  } catch (err) {
    dialog.showErrorBox("Worktree ging nicht", err.message);
    return null;
  }
});

// --- Pins ------------------------------------------------------------------
// Gepinnt wird in ~/.config/agent-tile/pins.json ({source, id, project, title, transcript}), dazu eine Kopie
// des Transcripts in ~/agent-tile/pins/<id>.jsonl, weil CC Transcripts nach cleanupPeriodDays löscht.
// Beim Lösen bleibt die Kopie liegen.

function writePins(pins) {
  fs.mkdirSync(path.dirname(FILES.pins), { recursive: true });
  fs.writeFileSync(`${FILES.pins}.tmp`, JSON.stringify(pins, null, 2));
  fs.renameSync(`${FILES.pins}.tmp`, FILES.pins);
}

function findTranscript(id) {
  for (const dir of fs.readdirSync(PROJECTS)) {
    const file = path.join(PROJECTS, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

ipcMain.on("pin", (_event, args) => {
  try {
    const pins = readJson(FILES.pins, []);
    if (args[0] === "--remove") return writePins(pins.filter((p) => p.id !== args[1]));
    const [id, project, title] = args;
    const transcript = findTranscript(id);
    if (!transcript) return;
    fs.mkdirSync(PIN_STORE, { recursive: true });
    fs.copyFileSync(transcript, path.join(PIN_STORE, `${id}.jsonl`));
    writePins([...pins.filter((p) => p.id !== id), { source: "claude", id, project, title, transcript }]);
  } catch (err) {
    dialog.showErrorBox("Pinnen ging nicht", err.message);
  }
});

// Vor dem Fortsetzen: gepinnt → Kopie auffrischen, oder das Transcript aus der Kopie zurücklegen, falls CC es gelöscht hat
function restorePin(id) {
  const pin = readJson(FILES.pins, []).find((p) => p.id === id);
  if (!pin?.transcript) return;
  const copy = path.join(PIN_STORE, `${id}.jsonl`);
  try {
    if (fs.existsSync(pin.transcript)) fs.copyFileSync(pin.transcript, copy);
    else if (fs.existsSync(copy)) {
      fs.mkdirSync(path.dirname(pin.transcript), { recursive: true });
      fs.copyFileSync(copy, pin.transcript);
    }
  } catch {}
}

// --- Git -------------------------------------------------------------------

function git(cwd, args) {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)
    )
  );
}

// --- Worktrees -------------------------------------------------------------
// Ordner ~/agent-tile/worktrees/<repo>@<zeit>, Branch agent/<zeit>.
// Der Ausgangs-Branch steht in der Git-Config des Repos (branch.<branch>.agentTileBase).

const WORKTREES = path.join(HOME, "agent-tile", "worktrees");

async function createWorktree(top) {
  const base = (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (base === "HEAD") throw new Error("Das Repo steht auf keinem Branch (detached HEAD).");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13); // 20261111-0312
  const branch = `agent/${stamp}`;
  const dir = path.join(WORKTREES, `${path.basename(top)}@${stamp}`);
  await git(top, ["worktree", "add", "-b", branch, dir]);
  await git(top, ["config", `branch.${branch}.agentTileBase`, base]);
  return dir;
}

// Worktree von agent-tile? → { branch, base, repo (Hauptordner) }, sonst null
async function worktreeInfo(cwd) {
  try {
    const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const base = (await git(cwd, ["config", `branch.${branch}.agentTileBase`])).trim();
    const common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return { branch, base, repo: path.dirname(path.resolve(common)) };
  } catch {
    return null;
  }
}

ipcMain.handle("git-diff", async (_event, cwd) => {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { error: "Kein Git-Repo" };
  }
  // Worktree: alles seit der Abzweigung (Commits des Agents + Arbeitsbaum), sonst gegenüber HEAD.
  // Repo ohne Commit hat kein HEAD → dann nur den Arbeitsbaum zeigen.
  const worktree = await worktreeInfo(cwd);
  const from = worktree ? (await git(cwd, ["merge-base", worktree.base, "HEAD"])).trim() : "HEAD";
  const diff = await git(cwd, ["diff", from, "--no-color"]).catch(() => git(cwd, ["diff", "--no-color"]));
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  return { diff, untracked, worktree };
});

// Mergen: offene Änderungen committen, Branch per --no-ff in den Ausgangs-Branch des Hauptordners.
// Danach (und beim Verwerfen) Session beenden, Worktree und Branch löschen.
ipcMain.handle("worktree:finish", async (_event, { paneId, cwd, merge }) => {
  const info = await worktreeInfo(cwd);
  if (!info) return { error: "Kein Worktree von agent-tile" };
  try {
    if (merge) {
      const current = (await git(info.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (current !== info.base) return { error: `Der Hauptordner steht auf ${current}, nicht auf ${info.base}.` };
      await git(cwd, ["add", "-A"]);
      const dirty = await git(cwd, ["diff", "--cached", "--quiet"]).then(() => false, () => true);
      if (dirty) await git(cwd, ["commit", "-m", `agent-tile: ${info.branch}`]);
      try {
        await git(info.repo, ["merge", "--no-ff", "--no-edit", info.branch]);
      } catch (err) {
        await git(info.repo, ["merge", "--abort"]).catch(() => {});
        return { error: `Merge abgebrochen: ${err.message}` };
      }
    }
    // Erst Claude beenden: Windows löscht keinen Ordner, in dem noch ein Prozess steht
    await request("kill", { paneId }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await git(info.repo, ["worktree", "remove", "--force", cwd]);
    await git(info.repo, ["branch", "-D", info.branch]);
    await git(info.repo, ["config", "--remove-section", `branch.${info.branch}`]).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("paths", () => ({ home: HOME }));

// Claude-Prozess einer Session außerhalb der App beenden (TerminateProcess; Signale gibt es unter Windows nicht).
// Vorher prüfen, dass die PID laut ~/.claude/sessions/<pid>.json wirklich diese Session ist
// und nicht wiederverwendet wurde (procStart = FILETIME der Prozess-Startzeit) — sonst nichts anfassen.
ipcMain.handle("kill-session", async (_event, pid, sessionId) => {
  const info = readJson(path.join(HOME, ".claude", "sessions", `${pid}.json`), null);
  if (!info || info.sessionId !== sessionId || (await procStart(pid)) !== info.procStart) return false;

  try {
    process.kill(pid);
  } catch {
    return false;
  }
  for (let waited = 0; waited < 5000; waited += 100) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
});

app.whenReady().then(() => {
  startAgentd();
  createWindow();
  startWatching();
});

app.on("window-all-closed", () => app.quit());

// Beim Beenden nur von der Pipe lösen — die Sessions laufen im ptyhost weiter.
app.on("will-quit", () => host?.socket.end());
