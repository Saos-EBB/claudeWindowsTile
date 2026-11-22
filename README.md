# agent-tile (Windows)

Windows-Port von `agent-tile` aus `hyperland-tiles-`. Ein einziges Fenster: links claude.ai als Webview, rechts die
Claude-Code-Terminals gestapelt, darunter das Agent-Panel. **Win+A** holt es nach vorn.

Was es kann (wie unter Linux):

- Sessions laufen im **ptyhost** und überleben Neustart oder Absturz der App.
- **Panel** mit allen laufenden, gepinnten und letzten Sessions. Fortsetzen per Klick, **Beenden**-Knopf, Subagents.
- **Worktree pro Session**, **Diff** mit **Mergen / Verwerfen**.
- **Erlaubnis-Rückfragen** direkt im Panel beantworten (Ja / Nein).
- **Windows-Meldung**, wenn eine Session fertig ist oder wartet, optional Push aufs Handy (ntfy).
- **Kontext-Füllstand** pro Session, **5-h- und Wochenlimit** in der Topbar.
- **Fenstersteuerung mit den Hyprland-Tasten**, hier mit Win statt Super.

## Was anders ist als unter Linux

| Linux | Windows |
|---|---|
| tmux-Server (`systemd-run`) | `app/ptyhost.js`: eigener Node-Prozess, Named Pipe, headless xterm pro Session |
| `systemd-run`, `setsid -f` | Start über WMI (`Win32_Process.Create`, `app/winproc.js`), sonst erbt der Prozess die Handles der App |
| `/proc/<pid>/stat` | `Process.StartTime.ToFileTimeUtc()`, genau das schreibt CC als `procStart` |
| `hypr/agents.lua` | `keys/agent-keys.pyw`: `WH_KEYBOARD_LL`-Hook (wie ktcModes) |
| `scripts/*.sh` + jq | `scripts/*.mjs` (Node); `pin.sh`/`resume.sh` stecken jetzt in `main.js` |
| Mausrad → tmux copy-mode | xterm.js scrollt selbst; im Vollbild-TUI geht das Rad an Claude |
| Hyprland-Blur | Windows-11-Acryl (`backgroundMaterial`) |
| SIGTERM, nach 5 s SIGKILL | TerminateProcess (Signale gibt es nicht), mit derselben PID-und-Startzeit-Prüfung |

## Einrichten

1. `cd app && npm install`. node-pty bringt fertige Windows-Builds mit, ein Rebuild ist nicht nötig.
2. In `~/.claude/settings.json` die Hooks und die Statusline eintragen:

   ```json
   "hooks": {
     "Stop": [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/Kevin Schaberl/dev/agent-tile/scripts/agent-hook.mjs\" Stop" }] }],
     "Notification": [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/Kevin Schaberl/dev/agent-tile/scripts/agent-hook.mjs\" Notification" }] }],
     "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/Kevin Schaberl/dev/agent-tile/scripts/agent-hook.mjs\" UserPromptSubmit" }] }]
   },
   "statusLine": { "type": "command", "command": "node \"C:/Users/Kevin Schaberl/dev/agent-tile/scripts/agent-statusline.mjs\"" }
   ```

   Gibt es eine eigene Statusline, kommt ihr Befehl hinten an `agent-statusline.mjs` dran.
3. In der Webview einmal bei claude.ai anmelden. Das Profil (`persist:claude`) bleibt erhalten.
4. Optional `~/.config/agent-tile/config.json`:
   `{"claudeArgs": ["--dangerously-skip-permissions"], "ntfy": "https://ntfy.sh/<geheimes-topic>", "claude": "C:/…/claude.exe"}`.
   `claude` braucht es nur, wenn `claude.exe` nicht von selbst gefunden wird (PATH, `~/.local/bin` oder hinter `claude.cmd` von npm).

Voraussetzungen: Node ≥ 22.18 im PATH (agentd und ptyhost), Git, Python (nur für die Win-Tasten).

## Starten, neu starten, beenden

- **Autostart**: Eine Verknüpfung in `shell:startup` startet beim Login nur den Tasten-Helfer
  (`pythonw.exe "…\keys\agent-keys.pyw"`). Die App kommt erst mit Win+A.
- **`agent-tile.cmd`** startet beides von Hand (Tasten-Helfer und Fenster). Beides läuft nur einmal.
- **Win+A**: startet die App, falls sie nicht läuft, holt sie sonst nach vorn bzw. minimiert sie, wenn sie vorne ist.
- Die App startet **agentd** und den **ptyhost** selbst (über WMI, losgelöst von der App).
- **Win+Shift+F4** oder **⏻** fragt nach:
  - **Nur Fenster schließen**: Die Sessions laufen im ptyhost weiter, Win+A holt alles zurück.
    So startet man die App auch neu, z. B. nach einem Update.
  - **Alles beenden**: alle Sessions, ptyhost, agentd und das Fenster. Der Verlauf bleibt, fortsetzen geht über „Zuletzt“.
- Tasten-Helfer beenden: `python keys\agent-keys.pyw --stop`.

## Fenstersteuerung (`app/wm.js`, `keys/agent-keys.pyw`)

Hat agent-tile den Fokus, schreibt der Tasten-Helfer den Befehl als Zeile nach `~/.cache/agent-tile/wm`, und die App
führt ihn in ihrem Master-Layout aus. Windows sieht diese Tasten dann nicht. Ohne Fokus macht Windows das Übliche.

| Taste | in der Tile |
|---|---|
| Win+←↓↑→ / H J K | Fokus zwischen Web-Chat, Panel und Terminals |
| Win+Shift+Richtung | Fenster tauschen (schwebend: verschieben) |
| Win+Strg+Richtung | Master-Breite bzw. Höhe im Stapel |
| Win+Strg+Return / Win+. | mit Master tauschen / nächstes Fenster |
| Win+I / D / R | mehr / weniger Master / Layout drehen |
| Win+T / M | Master-Layout / Monocle |
| Win+F / Win+Strg+F | schweben (Kopfzeile ziehen) / Vollbild |
| Win+F4 | Terminal ausblenden bzw. Web-Chat einklappen |
| Win+Shift+F4 | agent-tile beenden (siehe oben) |

**Per Maus**:

- Die **Lücke zwischen zwei Tiles** ziehen. Zwischen Master und Stapel verschiebt sie die Master-Breite, zwischen
  zwei Fenstern derselben Spalte tauscht sie nur zwischen diesen beiden Platz. Über der Lücke wird der Mauszeiger
  zum Doppelpfeil.
- **Schwebende Fenster**: an der Kopfzeile verschieben, am Griff unten rechts in der Größe ändern.
- Gilt im Master-Layout, nicht in Monocle. Die Einstellungen bleiben über Neustarts erhalten.

- **Win+L** sperrt immer den Rechner (das lässt Windows keinen Hook abfangen). Fokus rechts geht deshalb nur per →.
- Nach einer geschluckten Kombination schickt der Helfer eine unbelegte Taste (VK 0xE8), damit beim Loslassen
  von Win nicht das Startmenü aufgeht.
- Log: `~/.cache/agent-tile/keys.log`.

## Terminals

- **Kopieren**: Markieren mit der Maus kopiert sofort. **Doppelklick** markiert die ganze Zeile.
  **Strg+Shift+C** kopiert, **Strg+Shift+V** / **Shift+Einfg** fügt ein.
- Claude läuft im **Vollbild-TUI** (`"tui": "fullscreen"`) und hält dabei die Maus: Mausrad und Klicks gehen an
  Claude. Zum Markieren **Shift** gedrückt halten.
- **Drag and Drop**: Dateien kommen als Pfade an (mit `"…"`, falls nötig), Text als Text.
- **Kopfzeile**, **Glow**, **×** (ausblenden) und **Beenden** wie unter Linux.

## Panel, Diff, Worktrees, Verbrauch, Meldungen

Unverändert gegenüber Linux:

- **Panel**: Aktiv, Läuft draußen (mit „Draußen beenden & hier weiter“), Erlaubnis-Karten mit Ja / Nein / Ansehen,
  Gepinnt, Zuletzt.
- **Worktrees** liegen unter `~/agent-tile/worktrees/<repo>@<zeit>`, Branch `agent/<zeit>`.
  Vor dem Löschen des Worktrees beendet die App die Session, weil Windows keinen Ordner löscht, in dem noch
  ein Prozess steht.
- **Pins**: `~/.config/agent-tile/pins.json`, Kopie der Transcripts in `~/agent-tile/pins/`.
  Beim Fortsetzen frischt die App die Kopie auf oder legt das Transcript zurück, falls CC es gelöscht hat.
- **Meldungen** kommen nur, wenn agent-tile nicht den Fokus hat. Ein Klick holt die Pane der Session nach vorn.

## Technik

Verlauf und Gründe: [`docs/build-log.md`](docs/build-log.md), bekannte Fehler und ihre Ursachen:
[`docs/errors.md`](docs/errors.md). Logs liegen in `~/.cache/agent-tile/` (`main.log`, `ptyhost.log`, `keys.log`).

### ptyhost (`app/ptyhost.js`)

- Ein Node-Prozess pro Benutzer, Pipe `\\.\pipe\agent-tile-<user>`, NDJSON in beide Richtungen
  (`list`, `new`, `attach`, `write`, `resize`, `tag`, `kill`, `shutdown`, Events `data`/`exit`).
- Jede Session hat ein **headless xterm** (`@xterm/headless`) mitlaufen. Beim Anhängen bekommt die App den
  serialisierten Bildschirm samt Verlauf (`@xterm/addon-serialize`). Danach laufen die Daten über dieselbe Pipe.
- Claude startet als `claude.exe` direkt (nicht `claude.cmd`), mit `AGENT_TILE_PANE=<paneId>` in der Umgebung.
  Dann ist die PID der Pane die von Claude, und agentd ordnet sie zu.
- Log: `~/.cache/agent-tile/ptyhost.log`.

### agentd (`agentd/agentd.ts`)

Wie unter Linux: Er scannt alle 2 s `~/.claude/projects` und schreibt `~/.cache/agent-tile/state.json`.
Die PID gilt nur, wenn der Prozess läuft und seine Startzeit zu `procStart` aus `~/.claude/sessions/<pid>.json` passt.
Die Startzeit holt agentd per PowerShell, aber nur für neue PIDs und alle 30 s, alle in einem Aufruf.
`~/.cache/agent-tile/agentd.pid` sorgt für eine einzige Instanz.

### Hooks und Statusline

`scripts/agent-hook.mjs <Event>` schreibt `{ts, type, session, cwd, pane, message, kind}` nach
`~/.cache/agent-tile/events.jsonl`. `scripts/agent-statusline.mjs` legt pro Session
`~/.cache/agent-tile/usage/<session>.json` ab und reicht die Eingabe an eine eigene Statusline weiter, falls angegeben.
