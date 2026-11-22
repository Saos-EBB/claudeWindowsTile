# Step 0 — Checks (2026-11-10)

## Hyprland

- `hyprctl version`: **Hyprland 0.57.1** (Tag v0.57.1, commit acc1aa0).
- Config ist **Lua**: `~/.config/hypr/hyprland.lua` — es gibt keine `hyprland.conf`.
  Keybinds/Rules müssen dort in Lua-Syntax rein (`hl.bind(...)`, `hl.dsp.*`).
- Super+A ist noch frei.

### Border-Farbe pro Fenster

| Befehl | Ergebnis |
|---|---|
| `hyprctl dispatch setprop address:<addr> activebordercolor rgb(3ddc97)` | ❌ Fehler: `dispatch` erwartet in 0.57 einen Lua-Ausdruck |
| `hyprctl dispatch "hl.dsp.window.set_prop({ window = 'address:<addr>', prop = 'active_border_color', value = 'rgb(3ddc97)' })"` | ✅ `ok` |
| `hyprctl getprop address:<addr> active_border_color` | ✅ `ff3ddc97 0deg` |

Zurücksetzen: `value = 'unset'` liefert danach ein leeres `getprop` (`0deg`), es ist also unklar, ob
wieder die globale Farbe gilt. Sicher geht es, wenn man die globale Farbe explizit setzt
(`rgb(cd57ff)`, aus `general.col.active_border` in hyprland.lua). Getestet am kitty-Fenster,
danach wieder auf `rgb(cd57ff)` gesetzt.

## Browser / Userscript

- `chromium` ist nicht installiert → Entscheidung: **Brave** (`brave-browser` 157.1.99.55, Chromium-Basis).
  Web-Fenster: `brave-browser --app=https://claude.ai --class=agents-web`.
- Userscript-Manager: **ScriptCat** statt Tampermonkey/Stylus. Ist im Brave-Default-Profil installiert
  (`ndcooeababalnlpkfedmmbbbgkljhpjf`, v1.5.1).
- Ob ScriptCat auch im `--app`-Fenster injiziert, ist noch **offen**. Erweiterungen eines Profils laufen
  normalerweise auch in dessen App-Fenstern; geprüft wird das in Step 6 mit dem echten CSS-Script.

## Quickshell

- ❌ **Quickshell ist nicht installiert** (`~/.config/quickshell` fehlt auch).
  Verfügbar ist es über dnf: `quickshell 0.2.1^git20260209` (updates).

## Sonstiges

- kitty, node, npm sind da. `tsc` gibt es nicht global (würde per npm devDependency kommen).

## Nachtrag Step 1

- Brave ignoriert `--class` unter Wayland. Das App-Fenster heißt `brave-claude.ai__-Default`
  (Muster `brave-<host>__-<Profil>`) → die Windowrule matcht darauf.
- Quickshell 0.2.1 ist inzwischen installiert.
- Getestet: Web-Chat links (Master), zwei `kitty --class agents-cc-*` rechts gestapelt, alle auf `special:agents`.

## Nachtrag Step 3

- `set_prop … value = 'unset'` blendet den Rahmen aus (Pixel = Hintergrund `08070a`). Zurücksetzen
  deshalb mit den Werten aus `hyprctl getoption general:col.active_border -j` (Format `AARRGGBB`).
- Lua-Event `window.active` liefert das Fenster, `w.address` im Format `0x…`.
- Getestet: Stop-Hook aus einem kitty heraus → beide Rahmenfarben `ff3ddc97`, Event-Zeile geschrieben;
  Fokus weg und zurück → wieder `ffcd57ff` / `ff2c1536`.

## Nachtrag Step 4

- Quickshell braucht jede Komponente in der `qmldir`, sobald der Ordner eine hat.
- Prozesse aus `agents-start.sh` laufen per `setsid -f`, sonst enden sie mit der Prozessgruppe des Aufrufers.
- `pgrep -f '<muster>'` findet auch die aufrufende Shell, wenn deren Kommandozeile das Muster enthält (nur beim Testen relevant).
- Schrift **Inter ist nicht installiert** → Fallback auf Sans. Installieren: `sudo dnf install rsms-inter-fonts`.
- Getestet: Panel bei offenem `special:agents` unten rechts auf HDMI-A-1 (660×318), zeigt aktive Sessions;
  Web-Chat-Fokus per `hl.dsp.focus({ window = 'class:^brave-claude\\.ai__-Default$' })`.

## Nachtrag Step 6

- claude.ai liefert per `curl`/headless nur die Cloudflare-Challenge → Struktur per DevTools-Konsole ausgelesen.
- **ScriptCat läuft im `--app`-Fenster** (User-Scripts erlaubt, `<all_urls>`), aber `GM_addStyle` kam nicht an →
  `@grant none` und eigenes `<style id="agent-tile-look">`.
- Theme sitzt auf `<html data-theme="claude" data-mode="dark">`: alte HSL-Tripel (`--bg-*`, `--text-*`) und
  neue Hex-Tokens (`--cds-surface-*`, `--cds-text-*`, `--cds-page-bg` …), CSS in Cascade-Layern
  (`properties, software-compositing, cds-card, theme, base, components, utilities`).
- Ein Override nur auf `:root` reicht nicht: tiefere Elemente deklarieren die Tokens neu (`.cds-root`,
  `.cds-dark-scope[data-mode="dark"]`, Utilities wie `[--cds-page-bg:var(--cds-surface-3)]`) und schlagen
  damit den geerbten Wert. Lösung: Basis-Tokens auf `html … *`, die Seitenfläche nur auf `<html>`, alles
  `!important` im ersten Layer `properties`.
- Getestet: App-Fenster Hauptfläche `rgb(11,14,20)` = `#0b0e14`, Sidebar `rgb(18,21,29)` = `#12151d`, Überschrift in Sans.
- Noch orange: der Senden-Button (eigenes Brand-Token, nicht angefasst).

## Umbau: ein Fenster (Electron)

- Wunsch: alles in **einer** Tile, keine Extra-Fenster pro Session → Brave, ScriptCat-Userscript, Quickshell-Panel,
  kitty pro Session und die Hyprland-Rahmenfarben entfallen. Ersetzt durch `app/` (Electron 45, node-pty, xterm.js).
- Electron-Fenster bekommt per `app.setDesktopName("agent-tile.desktop")` die Hyprland-Klasse `agent-tile`.
- claude.ai läuft in `<webview partition="persist:claude">`, User-Agent ohne `Electron/…`. Login in der Webview klappt.
- `fit()` liefert direkt nach dem Start 0 Spalten, solange das Fenster keine Größe hat; `resize(0, …)` wird deshalb übersprungen.
- Getestet: Pane öffnen → Stop-Hook aus der Pane → Event mit `pane`-ID → Glow grün, „fertig“; zwei Panes, Panel und Webview
  im Screenshot wie im Mockup.

## Nachtrag: Session draußen übernehmen

- CC legt pro laufendem Prozess `~/.claude/sessions/<pid>.json` an (`pid`, `sessionId`, `cwd`, `procStart`).
  `procStart` = Feld 22 aus `/proc/<pid>/stat` → schützt vor wiederverwendeten PIDs.
- Erbt ein claude `CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_CHILD_SESSION` einer anderen Session, hält es sich für deren Kind
  und legt **keine** Datei an. Die App entfernt diese Variablen deshalb für ihre PTYs.
- SIGTERM beendet claude sauber, `--resume` in der Pane hat den vollen Verlauf. Getestet mit einer Haiku-Session in kitty:
  Warnung → „Draußen beenden & hier weiter“ → kitty zu, Pane mit Verlauf offen.

## Nachtrag: Sessions überleben die App (tmux)

- Vorfall: Neustart der App (`kill` aufs Electron-Fenster) hat alle Sessions darin beendet, weil sie Kinder der App waren.
- Jetzt: tmux-Server `-L agent-tile` als systemd-Dienst (`systemd-run --user --unit agent-tile-tmux tmux … -D`).
  Startet ihn Electron selbst, erbt er offene Deskriptoren (z. B. den DevTools-Port) und hält sie für immer.
  `start-server` als Dienst geht nicht: der Client endet, systemd räumt den Dienst samt Server ab → `-D` (Vordergrund).
- Getestet: Pane öffnen, App mit SIGKILL beenden → tmux-Session und Prozess leben, neue App hängt sich an (gleiche PID, alte Ausgabe da).
- `hl.unbind(key)` + `hl.bind(key, fn)` ersetzt eine Taste ohne Doppelbelegung (`hyprctl binds -j` zeigt eine Funktion).
