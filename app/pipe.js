// Named Pipe des ptyhost, pro Windows-Benutzer eine.
// AGENT_TILE_PIPE (z. B. "agent-tile-demo") gibt einer zweiten Instanz einen eigenen ptyhost; der bekommt den
// Namen als Argument, weil er per WMI mit frischer Umgebung startet.
const os = require("node:os");

const name = process.env.AGENT_TILE_PIPE || `agent-tile-${os.userInfo().username.replace(/[^\w-]/g, "_")}`;
module.exports = `\\\\.\\pipe\\${name}`;
