# Build-Log

## 2026-11-22 — feat(main): Pipe-Name per AGENT_TILE_PIPE
**Was:** Eine zweite Instanz (für die README-Screenshots) braucht einen eigenen ptyhost, sonst hängt sie sich an die echten Sessions.
**Nicht gebaut:** kein Demo-Modus in der App; die Demo-Daten kommen von außen.

## 2026-11-22 — docs(readme): Maus-Resize, Autostart, Logs
**Was:** README nennt jetzt Autostart, Größe per Maus und wo Logs und Fehlerdoku liegen.
**Nicht gebaut:** keine Screenshots, keine englische Fassung.

## 2026-11-22 — chore(autostart): Tasten-Helfer beim Login
**Was:** Verknüpfung `shell:startup\agent-tile Tasten.lnk` → `pythonw keys\agent-keys.pyw`. Die App selbst startet erst
per Win+A, nicht beim Login.
**Nicht gebaut:** kein Skript, das die Verknüpfung anlegt (einmalig, steht in der README).

## 2026-11-22 — feat(wm): Tile-Größe per Maus
**Was:** Lücke zwischen zwei Tiles ziehen: Master/Stapel-Grenze → mfact, sonst Platz nur zwischen den zwei Nachbarn.
Schwebende Fenster: Griff unten rechts. Tastatur (Win+Strg+Richtung) gab es schon.
**Nicht gebaut:** kein Win+Maus-Ziehen wie in Hyprland (bräuchte Maus-Hook), keine Ränder an gekachelten Tiles.

## 2026-11-22 — fix(main): sauber beenden ohne Fehlerdialog
**Was:** Nach dem Schließen blieb die App mit Fehlerdialog hängen und blockierte Win+A (siehe errors.md).
**Nicht gebaut:** kein Crash-Reporter, kein Neustart — Fehler landen nur in `main.log`.

## 2026-11-22 — feat: Windows-Port
**Was:** tmux → ptyhost, systemd-run → WMI, /proc → FILETIME, agents.lua → Tastatur-Hook, Bash → Node.
**Nicht gebaut:** kein Installer/Paketieren, kein Tray-Icon.
