@echo off
rem agent-tile starten: Tasten-Helfer (Win+A) und das Fenster. Beides laeuft nur einmal.
start "" pythonw "%~dp0keys\agent-keys.pyw"
start "" "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"
