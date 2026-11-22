// StatusLine für Claude Code: node agent-statusline.mjs [eigentliche-statusline …]
// Merkt pro Session Kontext-Füllstand, Kosten und Nutzungslimits für agent-tile
// (~/.cache/agent-tile/usage/<session>.json) und reicht die Eingabe dann an die eigentliche Statusline weiter.
// Ohne eigentliche Statusline gibt es nichts aus.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const input = readFileSync(0, "utf8");

try {
  const data = JSON.parse(input);
  if (data.session_id) {
    const dir = join(homedir(), ".cache", "agent-tile", "usage");
    mkdirSync(dir, { recursive: true });
    const entry = {
      ts: Date.now(),
      session: data.session_id,
      context: data.context_window?.used_percentage ?? null,
      contextTokens: data.context_window?.total_input_tokens ?? null,
      contextSize: data.context_window?.context_window_size ?? null,
      cost: data.cost?.total_cost_usd ?? null,
      fiveHour: data.rate_limits?.five_hour ?? null,
      sevenDay: data.rate_limits?.seven_day ?? null,
    };
    const file = join(dir, `${data.session_id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(entry));
    renameSync(`${file}.tmp`, file);
  }
} catch {}

const [command, ...args] = process.argv.slice(2);
if (command) {
  const result = spawnSync(command, args, { input, stdio: ["pipe", "inherit", "inherit"], shell: true });
  process.exit(result.status ?? 0);
}
