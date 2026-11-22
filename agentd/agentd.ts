// agentd: scannt ~/.claude/projects und schreibt alle 2 s ~/.cache/agent-tile/state.json.
// Läuft direkt mit Node >= 22.18 (Type-Stripping), kein Build-Schritt.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const RUNNING_DIR = join(homedir(), ".claude", "sessions"); // CC: <pid>.json pro laufendem Prozess
const CACHE_DIR = join(homedir(), ".cache", "agent-tile");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PID_FILE = join(CACHE_DIR, "agentd.pid");
const INTERVAL_MS = 2000;
const ACTIVE_MS = 120_000;
const TITLE_LEN = 60;

type Subagent = {
  id: string;
  type: string;
  description: string;
  mtime: number;
  active: boolean;
};

type Session = {
  source: "claude";
  id: string;
  project: string; // echter cwd aus dem Transcript
  title: string;
  mtime: number;
  active: boolean;
  pid: number | null; // laufender Claude-Prozess dieser Session, sonst null
  color: string | null; // Farbe aus /color (red, blue, green, yellow, purple, orange, pink, cyan), sonst null
  subagents: Subagent[];
};

type Head = { mtime: number; project: string; title: string };

// Titel und cwd ändern sich nicht mehr, sobald gefunden → pro Datei merken.
// Ohne Titel erst wieder lesen, wenn sich die Datei geändert hat.
const headCache = new Map<string, Head>();

function readHead(file: string, mtime: number): Head {
  const cached = headCache.get(file);
  if (cached && (cached.title || cached.mtime === mtime)) return cached;

  let project = "";
  let title = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!project && entry.cwd) project = entry.cwd;
    if (!title && entry.type === "user" && !entry.isMeta && !entry.isSidechain) {
      title = promptText(entry.message?.content);
    }
    if (project && title) break;
  }

  const head = { mtime, project, title };
  headCache.set(file, head);
  return head;
}

// /color schreibt {"type":"agent-color","agentColor":"pink"} ins Transcript, der letzte Eintrag gilt.
// Die Farbe kann sich jederzeit ändern → pro Datei nur den neu angehängten Teil lesen.
const colorCache = new Map<string, { size: number; color: string | null }>();

function readColor(file: string, size: number): string | null {
  const cached = colorCache.get(file) ?? { size: 0, color: null };
  if (cached.size === size) return cached.color;
  const from = size < cached.size ? 0 : cached.size; // kleiner geworden → neu geschrieben
  let color = from === 0 ? null : cached.color;

  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(size - from);
  readSync(fd, buffer, 0, buffer.length, from);
  closeSync(fd);
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.includes('"agent-color"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "agent-color") color = entry.agentColor && entry.agentColor !== "default" ? entry.agentColor : null;
    } catch {}
  }

  // Unvollständige letzte Zeile beim nächsten Mal nochmal lesen
  const lastNewline = buffer.lastIndexOf(10);
  colorCache.set(file, { size: lastNewline === -1 ? from : from + lastNewline + 1, color });
  return color;
}

// Tool-Ergebnisse (tool_result) und Slash-Commands (/clear …) zählen nicht als Prompt
function promptText(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.find((b) => b?.type === "text")?.text ?? "";
  if (/<(command-name|local-command-)/.test(text)) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_LEN);
}

function readSubagents(sessionDir: string, now: number): Subagent[] {
  const dir = join(sessionDir, "subagents");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const id = basename(name, ".jsonl").replace(/^agent-/, "");
      const mtime = statSync(join(dir, name)).mtimeMs;
      let meta: any = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8"));
      } catch {}
      return {
        id,
        type: meta.agentType ?? "",
        description: meta.description ?? "",
        mtime,
        active: now - mtime < ACTIVE_MS,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Läuft der Prozess noch? Signal 0 = OpenProcess + Exit-Code, billig genug für jeden Scan
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

// Startzeit als FILETIME (so schreibt CC procStart unter Windows), um wiederverwendete PIDs zu erkennen.
// Kostet einen PowerShell-Start (~0,3 s) → nur für neue PIDs und alle VERIFY_MS einmal, in einem Aufruf für alle.
const VERIFY_MS = 30_000;
const verified = new Map<string, number>(); // "<pid>:<procStart>" → Zeitpunkt der letzten Prüfung

function procStarts(pids: number[]): Map<number, string> {
  const starts = new Map<number, string>();
  if (!pids.length) return starts;
  const script =
    `foreach ($p in @(${pids.join(",")})) { try { "$p " + [Diagnostics.Process]::GetProcessById($p).StartTime.ToFileTimeUtc() } catch {} }`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    for (const line of out.split(/\r?\n/)) {
      const [pid, start] = line.trim().split(" ");
      if (pid && start) starts.set(Number(pid), start);
    }
  } catch {}
  return starts;
}

// sessionId → pid für alle laufenden Claude-Prozesse
function runningSessions(): Map<string, number> {
  const running = new Map<string, number>();
  if (!existsSync(RUNNING_DIR)) return running;
  const now = Date.now();
  const candidates: { sessionId: string; pid: number; key: string }[] = [];
  for (const name of readdirSync(RUNNING_DIR)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const info = JSON.parse(readFileSync(join(RUNNING_DIR, name), "utf8"));
      if (info.sessionId && isAlive(info.pid)) {
        candidates.push({ sessionId: info.sessionId, pid: info.pid, key: `${info.pid}:${info.procStart}` });
      }
    } catch {}
  }

  const stale = candidates.filter((c) => !(now - (verified.get(c.key) ?? 0) < VERIFY_MS));
  const starts = procStarts(stale.map((c) => c.pid));
  for (const c of stale) {
    if (`${c.pid}:${starts.get(c.pid)}` === c.key) verified.set(c.key, now);
    else verified.delete(c.key);
  }
  for (const c of candidates) if (verified.has(c.key)) running.set(c.sessionId, c.pid);
  return running;
}

function scan(): Session[] {
  const now = Date.now();
  const running = runningSessions();
  const sessions: Session[] = [];

  for (const projectDir of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, projectDir);
    if (!statSync(dir).isDirectory()) continue;

    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      const id = basename(name, ".jsonl");
      const { mtimeMs: mtime, size } = statSync(file);
      const { project, title } = readHead(file, mtime);
      if (!title) continue; // Session ohne Prompt, z. B. sofort wieder geschlossen
      if (project && !existsSync(project)) continue; // Ordner weg (z. B. Worktree gelöscht) → nicht fortsetzbar
      sessions.push({
        source: "claude",
        id,
        project,
        title,
        mtime,
        active: now - mtime < ACTIVE_MS,
        pid: running.get(id) ?? null,
        // Nur laufende Sessions haben eine Pane mit Kopfzeile; alle 1,6 GB Transcripts zu lesen dauerte Sekunden
        color: running.has(id) ? readColor(file, size) : null,
        subagents: readSubagents(join(dir, id), now),
      });
    }
  }

  return sessions.sort((a, b) => b.mtime - a.mtime);
}

function writeState() {
  const state = { updated: Date.now(), sessions: scan() };
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

// Nur eine Instanz: läuft der Prozess aus agentd.pid noch, endet dieser hier
mkdirSync(CACHE_DIR, { recursive: true });
try {
  const other = JSON.parse(readFileSync(PID_FILE, "utf8")).pid;
  if (other !== process.pid && isAlive(other)) process.exit(0);
} catch {}
writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid }));

function tick() {
  try {
    writeState();
  } catch (err) {
    console.error(err); // z. B. state.json gerade vom Virenscanner gesperrt → nächster Scan
  }
}
tick();
setInterval(tick, INTERVAL_MS);
