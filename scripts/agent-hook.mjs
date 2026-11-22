// Claude-Code-Hook: node agent-hook.mjs <Stop|Notification|UserPromptSubmit>, Payload auf stdin.
// Schreibt {ts, type, session, cwd, pane, message, kind} nach ~/.cache/agent-tile/events.jsonl.
// pane = AGENT_TILE_PANE, das agent-tile jeder Terminal-Pane mitgibt; die App färbt danach den Glow.
// message/kind nur bei Notification (z. B. kind "permission_prompt" = Rückfrage nach einer Erlaubnis).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TYPES = { Stop: "done", Notification: "waiting", UserPromptSubmit: "input" };

const type = TYPES[process.argv[2]];
if (!type) process.exit(0);

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {}

const dir = join(homedir(), ".cache", "agent-tile");
mkdirSync(dir, { recursive: true });
const event = {
  ts: Date.now(),
  type,
  session: payload.session_id ?? null,
  cwd: payload.cwd ?? null,
  pane: process.env.AGENT_TILE_PANE ?? "",
  message: payload.message ?? null,
  kind: payload.notification_type ?? null,
};
appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
