# Fehler

## 2026-11-22 — Ständig neue Terminal-Fenster „[Fehler 2147942632 (0x800700e8) beim Start von `tasklist …']“
**Symptom:** Mehrere Konsolenfenster pro Sekunde, jeweils mit dieser Meldung (bzw. leer, seit conhost Standard ist).
**Ursache:** Nicht agent-tile und nicht Claude Code, sondern LocalAI: `C:\LocalAI\system\runtime.py` `process_info()`
ruft `tasklist` per `subprocess.run` ohne `CREATE_NO_WINDOW` auf; `_wait_gone()` pollt das alle 0,2 s (z. B. bei
`lai.cmd stop-model`, gestartet aus einer Claude-Session). Ein Python ohne eigene Konsole bekommt dann pro Aufruf ein
neues, sichtbares Konsolenfenster. Nachgestellt mit pythonw: 15 Aufrufe → 15 Fenster.
Erste Vermutung (Claude Code pollt eine verlorene PID) war falsch.
**Fix:** In LocalAI `creationflags=CREATE_NO_WINDOW` für tasklist, taskkill und netstat → 0 Fenster.
Die Umstellung des Standard-Terminals auf conhost war dafür nicht nötig (schadet aber nicht).

## 2026-11-22 — App bleibt nach dem Schließen fensterlos hängen, „Uncaught JS error“
**Symptom:** Fenster zu (X, WM_CLOSE), electron.exe läuft weiter. Win+A startet danach nichts mehr, weil die
hängende Instanz die Single-Instance-Sperre hält.
**Ursache:** Beim Beenden endet die Pipe zum ptyhost, `lost()` schickt `pty:exit` an das schon zerstörte Fenster →
„Object has been destroyed“. Electrons modaler Fehlerdialog hält den Prozess offen.
**Fix:** Alle Sends über `toRenderer()` (prüft `isDestroyed()`), Watcher in `will-quit` schließen,
`uncaughtException` → `~/.cache/agent-tile/main.log`, und nach `quit` spätestens 1,5 s später `process.exit`.

## 2026-11-22 — Port bleibt belegt, nachdem die App weg ist
**Symptom:** `--remote-debugging-port` der beendeten App ist weiter belegt.
**Ursache:** ptyhost und agentd per `spawn()` aus Electron gestartet → erben alle vererbbaren Handles der App.
**Fix:** Start über WMI (`launchDetached` in `app/winproc.js`).
