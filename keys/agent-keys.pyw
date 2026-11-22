"""agent-keys: Win-Tasten fuer agent-tile (Ersatz fuer hypr/agents.lua).

Win+A (ueberall): agent-tile starten, nach vorn holen oder minimieren.
Hat agent-tile den Fokus, gehen die Fenstertasten aus Hyprland als Zeile nach
~/.cache/agent-tile/wm (app/wm.js fuehrt sie aus) und Windows sieht sie nicht:

  Win+Pfeile / H J K          Fokus          Win+Shift+Richtung   tauschen
  Win+Strg+Richtung           Groesse        Win+Strg+Return      mit Master tauschen
  Win+.                       naechstes      Win+I / D / R        Master + / - / drehen
  Win+T / M                   Master/Monocle Win+F / Win+Strg+F   schweben / Vollbild
  Win+F4                      ausblenden     Win+Shift+F4         beenden (fragt)

Win+L sperrt immer den Rechner (das laesst Windows keinen Hook abfangen), also
geht Fokus rechts nur per Pfeil.

Wie bei ktcModes ein WH_KEYBOARD_LL-Hook statt RegisterHotKey: Win+A und die
meisten Win-Kombinationen haelt die Shell selbst. Anders als dort werden die
Tasten hier geschluckt, sonst taete Windows zusaetzlich das Seine (Win+D zeigt
den Desktop, Win+. die Emoji-Leiste ...). Damit beim Loslassen von Win nicht das
Startmenue aufgeht, kommt nach dem Schlucken eine unbelegte Taste (VK 0xE8)
hinterher, wie es AutoHotkey macht.

Aufruf: pythonw agent-keys.pyw   |   python agent-keys.pyw --stop
"""

import ctypes
import ctypes.wintypes as wt
import os
import queue
import subprocess
import sys
import threading
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

HIER = os.path.dirname(os.path.abspath(__file__))
APP = os.path.normpath(os.path.join(HIER, "..", "app"))
ELECTRON = os.path.join(APP, "node_modules", "electron", "dist", "electron.exe")
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "agent-tile")
WM_DATEI = os.path.join(CACHE, "wm")
LOG = os.path.join(CACHE, "keys.log")
PIDFILE = os.path.join(CACHE, "keys.pid")
TITEL = "agent-tile"


def protokoll(text):
    os.makedirs(CACHE, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")


# ------------------------------------------------------------ Fenster finden

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
user32.GetForegroundWindow.restype = wt.HWND
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def exe_von(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = wt.DWORD(len(buf))
        if not kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return ""
        return buf.value
    finally:
        kernel32.CloseHandle(h)


_ist_tile = {}  # hwnd -> bool; Titel kann sich nicht aendern (main.js haelt ihn fest)


def ist_tile(hwnd):
    """Fenster mit Titel "agent-tile" aus electron.exe (ein Explorer-Ordner gleichen Namens zaehlt nicht)."""
    if not hwnd:
        return False
    buf = ctypes.create_unicode_buffer(64)
    user32.GetWindowTextW(hwnd, buf, 64)
    if buf.value != TITEL:
        return False
    if hwnd not in _ist_tile:
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        _ist_tile[hwnd] = os.path.basename(exe_von(pid.value)).lower() == "electron.exe"
    return _ist_tile[hwnd]


def tile_finden():
    gefunden = []

    def proc(hwnd, _):
        if ist_tile(hwnd):
            gefunden.append(hwnd)
            return False
        return True

    user32.EnumWindows(WNDENUMPROC(proc), 0)
    return gefunden[0] if gefunden else None


# ------------------------------------------------------------ Aktionen

SW_MINIMIZE, SW_RESTORE = 6, 9
AUFTRAEGE = queue.Queue()
zuletzt_gestartet = [0.0]


def starten():
    if time.time() - zuletzt_gestartet[0] < 15:  # Electron braucht ein paar Sekunden bis zum Fenster
        return
    zuletzt_gestartet[0] = time.time()
    if not os.path.exists(ELECTRON):
        protokoll(f"Electron fehlt: {ELECTRON} (npm install in app/)")
        return
    env = {k: v for k, v in os.environ.items()
           if k not in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDECODE",
                        "ELECTRON_RUN_AS_NODE")}
    subprocess.Popen([ELECTRON, "."], cwd=APP, env=env, close_fds=True,
                     creationflags=0x00000008 | 0x00000200)  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    protokoll("agent-tile gestartet")


def nach_vorn(hwnd):
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    if user32.SetForegroundWindow(hwnd):
        return
    # Windows verweigert den Fokuswechsel manchmal; an den Eingabe-Thread des Vordergrunds haengen hilft
    vorn = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    selbst = kernel32.GetCurrentThreadId()
    user32.AttachThreadInput(selbst, vorn, True)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.AttachThreadInput(selbst, vorn, False)


def umschalten():
    hwnd = tile_finden()
    if not hwnd:
        starten()
    elif user32.GetForegroundWindow() == hwnd:
        user32.ShowWindow(hwnd, SW_MINIMIZE)
    else:
        nach_vorn(hwnd)


def an_tile(befehl):
    os.makedirs(CACHE, exist_ok=True)
    with open(WM_DATEI, "a", encoding="utf-8", newline="\n") as f:  # Anhaengen blockiert nie
        f.write(befehl + "\n")


def arbeiter():
    """Hook-Rueckrufe muessen in Millisekunden zurueck sein (LowLevelHooksTimeout) - alles andere hier."""
    while True:
        aktion = AUFTRAEGE.get()
        try:
            aktion()
        except Exception as e:  # ein Fehlgriff darf den Dienst nicht mitnehmen
            protokoll(f"unerwartet - {e!r}")


# ------------------------------------------------------------ Belegung

VK_LWIN, VK_RWIN, VK_SHIFT, VK_CONTROL, VK_MENU = 0x5B, 0x5C, 0x10, 0x11, 0x12
VK_MASKE = 0xE8  # unbelegt; verhindert das Startmenue nach geschluckten Win-Kombinationen
VK = {"left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28, "H": 0x48, "J": 0x4A, "K": 0x4B,
      "A": 0x41, "I": 0x49, "D": 0x44, "R": 0x52, "T": 0x54, "M": 0x4D, "F": 0x46,
      "Return": 0x0D, "period": 0xBE, "F4": 0x73}

# (vk, shift, strg) -> Befehl an die Tile; wie in hypr/agents.lua
BELEGUNG = {}
WIEDERHOLEN = set()  # Tasten, die beim Halten wiederholen (Groesse aendern)
for richtung, vim, dx, dy in (("left", "H", -40, 0), ("down", "J", 0, 40), ("up", "K", 0, -40), ("right", None, 40, 0)):
    for taste in filter(None, (richtung, vim)):
        BELEGUNG[(VK[taste], False, False)] = f"focus {richtung}"
        BELEGUNG[(VK[taste], True, False)] = f"move {richtung}"
        BELEGUNG[(VK[taste], False, True)] = f"resize {dx} {dy}"
        WIEDERHOLEN.add((VK[taste], False, True))
BELEGUNG.update({
    (VK["Return"], False, True): "swapwithmaster",
    (VK["period"], False, False): "cyclenext",
    (VK["I"], False, False): "addmaster",
    (VK["D"], False, False): "removemaster",
    (VK["R"], False, False): "orientationnext",
    (VK["T"], False, False): "layout master",
    (VK["M"], False, False): "layout monocle",
    (VK["F"], False, False): "float",
    (VK["F"], False, True): "fullscreen",
    (VK["F4"], False, False): "close",
    (VK["F4"], True, False): "quit",
})


# ------------------------------------------------------------ Hook

WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0100, 0x0101, 0x0104, 0x0105
LLKHF_INJECTED = 0x10
KEYEVENTF_KEYUP = 0x0002

HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wt.WPARAM, wt.LPARAM)
user32.SetWindowsHookExW.restype = wt.HANDLE
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wt.HANDLE, wt.DWORD]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.CallNextHookEx.argtypes = [wt.HANDLE, ctypes.c_int, wt.WPARAM, wt.LPARAM]


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


def gedrueckt(vk):
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


def maskieren():
    user32.keybd_event(VK_MASKE, 0, 0, 0)
    user32.keybd_event(VK_MASKE, 0, KEYEVENTF_KEYUP, 0)


def horchen():
    threading.Thread(target=arbeiter, daemon=True).start()
    geschluckt = set()  # gedrueckte Tasten, deren Loslassen auch geschluckt wird
    maskiert = [False]  # pro Win-Druck einmal

    def entscheiden(vk, runter):
        """True = Taste schlucken."""
        if vk in (VK_LWIN, VK_RWIN):
            if not runter:
                maskiert[0] = False
            return False
        if not runter:
            if vk in geschluckt:
                geschluckt.discard(vk)
                return True
            return False
        if not (gedrueckt(VK_LWIN) or gedrueckt(VK_RWIN)) or gedrueckt(VK_MENU):
            return False
        shift, strg = gedrueckt(VK_SHIFT), gedrueckt(VK_CONTROL)

        if vk == VK["A"] and not shift and not strg:
            if vk not in geschluckt:
                AUFTRAEGE.put(umschalten)
        else:
            befehl = BELEGUNG.get((vk, shift, strg))
            if not befehl or not ist_tile(user32.GetForegroundWindow()):
                return False
            if vk not in geschluckt or (vk, shift, strg) in WIEDERHOLEN:
                AUFTRAEGE.put(lambda: an_tile(befehl))
        geschluckt.add(vk)
        if not maskiert[0]:
            maskiert[0] = True
            maskieren()
        return True

    def proc(ncode, wparam, lparam):
        if ncode == 0:
            k = ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
            if not k.flags & LLKHF_INJECTED:
                try:
                    if entscheiden(k.vkCode, wparam in (WM_KEYDOWN, WM_SYSKEYDOWN)):
                        return 1
                except Exception as e:
                    protokoll(f"Hook: {e!r}")
        return user32.CallNextHookEx(None, ncode, wparam, lparam)

    cb = HOOKPROC(proc)  # muss leben, solange der Hook haengt
    hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, cb, None, 0)
    if not hook:
        protokoll(f"Tastatur-Hook nicht gesetzt (WinError {ctypes.get_last_error()})")
        sys.exit(1)
    protokoll("horcht (Win+A, Fenstertasten in agent-tile)")
    msg = wt.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        pass  # der Hook wird in diesen Thread geliefert, also muss er pumpen


# ------------------------------------------------------------ eine Instanz

ERROR_ALREADY_EXISTS = 183


def beenden():
    try:
        pid = int(open(PIDFILE).read().strip())
    except (OSError, ValueError):
        return False
    if os.path.basename(exe_von(pid)).lower().startswith("python"):  # PID-Recycling: nur Python abschiessen
        h = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
        if h:
            kernel32.TerminateProcess(h, 0)
            kernel32.CloseHandle(h)
            return True
    return False


def main():
    if "--stop" in sys.argv[1:]:
        print("beendet" if beenden() else "lief nicht")
        return
    kernel32.CreateMutexW(None, False, "Local\\agent-tile-keys")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        return  # laeuft schon
    os.makedirs(CACHE, exist_ok=True)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
    horchen()


if __name__ == "__main__":
    main()
