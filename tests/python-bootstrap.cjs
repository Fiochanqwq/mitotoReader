// Explicit integration check: downloads official private Python into tests/tmp.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { ensurePython } = require("../app/python-runtime.cjs");
const { healthCheck } = require("../app/engines.cjs");
const exec = promisify(execFile);
const job = { cancelled: false };
const run = async (exe, args) => {
  const result = await exec(exe, args, { windowsHide: true, timeout: 180000 });
  return result.stdout;
};
(async () => {
  const root = path.join(__dirname, "tmp", "python-bootstrap");
  const exe = await ensurePython(root, job, run);
  console.log(await run(exe, ["-I", "-c", healthCheck]));
  const venv = path.join(root, "test-venv");
  await run(exe, ["-I", "-m", "venv", "--without-pip", venv]);
  const python = path.join(venv, "Scripts/python.exe");
  await run(python, ["-I", "-m", "ensurepip", "--upgrade", "--default-pip"]);
  console.log(await run(python, ["-I", "-m", "pip", "--version"]));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
