# Build-Log

## 2026-11-22 — fix(main): sauber beenden ohne Fehlerdialog
**Was:** Nach dem Schließen blieb die App mit Fehlerdialog hängen und blockierte Win+A (siehe errors.md).
**Nicht gebaut:** kein Crash-Reporter, kein Neustart — Fehler landen nur in `main.log`.

## 2026-11-22 — feat: Windows-Port
**Was:** tmux → ptyhost, systemd-run → WMI, /proc → FILETIME, agents.lua → Tastatur-Hook, Bash → Node.
**Nicht gebaut:** kein Installer/Paketieren, kein Tray-Icon.
