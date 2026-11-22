// Named Pipe des ptyhost, pro Windows-Benutzer eine
const os = require("node:os");

module.exports = `\\\\.\\pipe\\agent-tile-${os.userInfo().username.replace(/[^\w-]/g, "_")}`;
