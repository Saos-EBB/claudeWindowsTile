# Fehler

## 2026-11-22 — Ständig neue Terminal-Fenster „[Fehler 2147942632 (0x800700e8) beim Start von `tasklist …']“
**Symptom:** Mehrere Windows-Terminal-Fenster pro Sekunde, jeweils mit dieser Meldung.
**Ursache:** Wahrscheinlich Claude Code selbst, das per `tasklist` die PID eines verlorenen Hintergrund-Tasks abfragte.
Nicht abschließend bestätigt: Beim Messen war die Schleife schon vorbei. Sicher ist: Windows Terminal war (ohne eigene
Einstellung) Standard-Terminal und übernimmt dann auch versteckt gestartete Konsolenprogramme → sichtbares Fenster,
das an der schon geschlossenen Pipe scheitert.
**Fix:** Standard-Terminal = Windows-Konsolenhost (`HKCU\Console\%%Startup`, `DelegationConsole` und
`DelegationTerminal` = `{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}`). Versteckte Konsolen bleiben dann versteckt, auch die
von agent-tile (PowerShell, git aus dem Main-Prozess).

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
