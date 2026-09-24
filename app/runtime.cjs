const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function prepareRuntime(root, run = execFileSync) {
  const runtime = path.resolve(root);
  if (!fs.existsSync(path.join(runtime, "electron.exe")) && !fs.existsSync(path.join(runtime, "mitotoReader.exe")))
    throw new Error("Electron runtime executable missing.");
  const invoke = (args) => run("icacls.exe", args, { stdio: "pipe", windowsHide: true });
  const readAccess = ["*S-1-15-2-1:(RX)", "*S-1-15-2-2:(RX)"];
  // Keep root grants non-inheritable so portable reading data remains private.
  invoke([runtime, "/grant:r", ...readAccess, "/Q"]);
  for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (entry.isFile() && /\.(exe|dll|pak|bin|dat|json)$/i.test(entry.name))
      invoke([path.join(runtime, entry.name), "/grant:r", ...readAccess, "/Q"]);
  }
  for (const name of ["locales", "resources"]) {
    const target = path.join(runtime, name);
    if (fs.existsSync(target))
      invoke([target, "/grant:r", "*S-1-15-2-1:(OI)(CI)(RX)", "*S-1-15-2-2:(OI)(CI)(RX)", "/T", "/Q"]);
  }
}

module.exports = { prepareRuntime };
