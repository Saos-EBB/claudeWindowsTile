// Prozess-Infos unter Windows (Ersatz für /proc/<pid>/stat)
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Startzeit als FILETIME-Text, genau wie CC sie in ~/.claude/sessions/<pid>.json als procStart schreibt; sonst null
function procStart(pid) {
  const script = `try { [Diagnostics.Process]::GetProcessById(${Number(pid)}).StartTime.ToFileTimeUtc() } catch {}`;
  return new Promise((resolve) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    )
  );
}

// Signal 0 prüft unter Windows, ob der Prozess noch läuft (OpenProcess + Exit-Code)
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Prozess völlig losgelöst starten (Ersatz für systemd-run): über WMI legt der WMI-Dienst den Prozess an.
// Ein normales spawn() aus Electron vererbt alle vererbbaren Handles der App (z. B. offene Sockets, die dann
// für immer belegt bleiben) und hängt den Prozess an die App. Ohne Fenster (ShowWindow = SW_HIDE).
// Die Umgebung ist die frische des Benutzers, nicht die der App.
function launchDetached(file, args, cwd) {
  const commandLine = [file, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ");
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const script =
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; " +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(commandLine)}; ` +
    `CurrentDirectory = ${q(cwd)}; ProcessStartupInformation = $si }; "$($r.ReturnValue) $($r.ProcessId)"`;
  return new Promise((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (err, stdout) => {
      const [code, pid] = stdout.trim().split(" ").map(Number);
      if (err || code !== 0) reject(new Error(`Start von ${file} fehlgeschlagen (WMI ${code ?? "?"}): ${err?.message ?? ""}`));
      else resolve(pid);
    })
  );
}

// node.exe aus dem PATH (der Host läuft mit dem System-Node; node-pty ist N-API und lädt dort wie in Electron)
function findNode() {
  for (const dir of (process.env.PATH || "").split(";").filter(Boolean)) {
    const exe = path.join(dir, "node.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return "node.exe";
}

module.exports = { procStart, isAlive, launchDetached, findNode };
