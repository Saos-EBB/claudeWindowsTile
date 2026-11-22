# Fehler

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
