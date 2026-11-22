// ptyhost: hält die Claude-Sessions, damit sie Neustart oder Absturz von agent-tile überleben (Ersatz für tmux).
// Läuft losgelöst von der App als eigener Prozess (electron.exe mit ELECTRON_RUN_AS_NODE=1, gestartet von main.js)
// und spricht NDJSON über eine Named Pipe. Pro Session ein headless xterm, damit eine neu angehängte App den
// aktuellen Bildschirm samt Verlauf bekommt (serialize), statt rohe Ausgabe ab irgendwo nachzuspielen.
//
// App → Host: {id, op, ...}   Host → App: {re: id, ok, result | error}  oder Events {ev: "data"|"exit", paneId, d}
//   list                                   → [{paneId, cwd, sessionId, pid}]
//   new {paneId, cwd, file, args, env, cols, rows}
//   attach {paneId}                        → {snapshot, pid}; danach kommen die Daten dieser Session als Events
//   write {paneId, d} · resize {paneId, cols, rows} · tag {paneId, sessionId} · kill {paneId}
//   shutdown                               → alle Sessions beenden, Host endet

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const PIPE = require("./pipe.js");
const LOG = path.join(os.homedir(), ".cache", "agent-tile", "ptyhost.log");
const SCROLLBACK = 10000;

fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = (text) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`);

const sessions = new Map(); // paneId → { cwd, sessionId, pty, term, serialize, clients: Set<socket> }

function send(socket, message) {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
}

function create({ paneId, cwd, file, args, env, cols, rows }) {
  if (sessions.has(paneId)) throw new Error(`Session ${paneId} gibt es schon`);
  const proc = pty.spawn(file, args, { name: "xterm-256color", cwd, env, cols, rows });
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  const session = { cwd, sessionId: null, pty: proc, term, serialize, clients: new Set() };
  sessions.set(paneId, session);

  proc.onData((d) => {
    term.write(d);
    for (const client of session.clients) send(client, { ev: "data", paneId, d });
  });
  proc.onExit(({ exitCode }) => {
    log(`${paneId} beendet (${exitCode})`);
    sessions.delete(paneId);
    for (const client of session.clients) send(client, { ev: "exit", paneId });
    term.dispose();
  });
  log(`${paneId} gestartet: ${file} ${args.join(" ")} in ${cwd} (pid ${proc.pid})`);
  return proc.pid;
}

function get(paneId) {
  const session = sessions.get(paneId);
  if (!session) throw new Error(`Keine Session ${paneId}`);
  return session;
}

const ops = {
  list: () => [...sessions].map(([paneId, s]) => ({ paneId, cwd: s.cwd, sessionId: s.sessionId, pid: s.pty.pid })),
  new: (msg) => create(msg),
  attach: ({ paneId }, socket) => {
    const session = get(paneId);
    session.clients.add(socket);
    return { snapshot: session.serialize.serialize(), pid: session.pty.pid };
  },
  write: ({ paneId, d }) => get(paneId).pty.write(d),
  resize: ({ paneId, cols, rows }) => {
    const session = get(paneId);
    if (cols < 1 || rows < 1) return;
    session.pty.resize(cols, rows);
    session.term.resize(cols, rows);
  },
  tag: ({ paneId, sessionId }) => {
    get(paneId).sessionId = sessionId;
  },
  kill: ({ paneId }) => get(paneId).pty.kill(),
  shutdown: () => {
    log("shutdown");
    for (const session of sessions.values()) session.pty.kill();
    setTimeout(() => process.exit(0), 500);
  },
};

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        const result = ops[msg.op]?.(msg, socket);
        if (msg.id !== undefined) send(socket, { re: msg.id, ok: true, result });
      } catch (err) {
        if (msg.id !== undefined) send(socket, { re: msg.id, ok: false, error: err.message });
      }
    }
  });
  const detach = () => {
    for (const session of sessions.values()) session.clients.delete(socket);
  };
  socket.on("close", detach);
  socket.on("error", detach);
});

// Läuft schon ein Host, ist die Pipe belegt → dieser endet still
server.on("error", (err) => {
  log(`Pipe nicht verfügbar: ${err.message}`);
  process.exit(0);
});
server.listen(PIPE, () => log(`bereit auf ${PIPE} (pid ${process.pid})`));
process.on("uncaughtException", (err) => log(`Fehler: ${err.stack || err}`));
