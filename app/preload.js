// Schmale Brücke zwischen Renderer und Main-Prozess
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("tile", {
  paths: () => ipcRenderer.invoke("paths"),
  initial: () => ipcRenderer.invoke("data:initial"),
  onState: (fn) => ipcRenderer.on("data:state", (_e, state) => fn(state)),
  onPins: (fn) => ipcRenderer.on("data:pins", (_e, pins) => fn(pins)),
  onUsage: (fn) => ipcRenderer.on("data:usage", (_e, entry) => fn(entry)),
  onEvent: (fn) => ipcRenderer.on("data:event", (_e, event) => fn(event)),

  openPty: (options) => ipcRenderer.invoke("pty:open", options),
  writePty: (paneId, data) => ipcRenderer.send("pty:write", paneId, data),
  resizePty: (paneId, cols, rows) => ipcRenderer.send("pty:resize", paneId, cols, rows),
  closePty: (paneId) => ipcRenderer.send("pty:close", paneId),
  copy: (text) => ipcRenderer.send("clipboard:write", text),
  paste: () => ipcRenderer.invoke("clipboard:read"),
  pathForFile: (file) => webUtils.getPathForFile(file), // Drag and Drop: Pfad der gezogenen Datei
  onPtyData: (fn) => ipcRenderer.on("pty:data", (_e, paneId, data) => fn(paneId, data)),
  onPtyExit: (fn) => ipcRenderer.on("pty:exit", (_e, paneId) => fn(paneId)),

  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  quit: () => ipcRenderer.invoke("quit"),
  pin: (args) => ipcRenderer.send("pin", args),
  gitDiff: (cwd) => ipcRenderer.invoke("git-diff", cwd),
  finishWorktree: (options) => ipcRenderer.invoke("worktree:finish", options),
  killSession: (pid, sessionId) => ipcRenderer.invoke("kill-session", pid, sessionId),
  onFocusSession: (fn) => ipcRenderer.on("focus-session", (_e, paneId, sessionId) => fn(paneId, sessionId)),
  onWm: (fn) => ipcRenderer.on("wm", (_e, line) => fn(line)),
  hostList: () => ipcRenderer.invoke("host:list"),
  tagPane: (paneId, sessionId) => ipcRenderer.send("host:tag", paneId, sessionId),
});
