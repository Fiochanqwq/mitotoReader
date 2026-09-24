const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, writeFile, mkdtemp } = require("node:fs/promises");
const path = require("node:path");
const { prepareRuntime } = require("../app/runtime.cjs");

test("Runtime access preparation excludes portable reading data", async () => {
  const parent = path.join(__dirname, "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "runtime-"));
  await writeFile(path.join(root, "mitotoReader.exe"), "test");
  await writeFile(path.join(root, "ffmpeg.dll"), "test");
  await mkdir(path.join(root, "resources"));
  await mkdir(path.join(root, "mitoto-data"));
  await writeFile(path.join(root, "mitoto-data", "reader.json"), "private");
  const calls = [];
  prepareRuntime(root, (exe, args, options) => calls.push({ exe, args, options }));
  assert.ok(calls.some((x) => x.args[0] === path.join(root, "ffmpeg.dll")));
  assert.ok(calls.every((x) => x.exe === "icacls.exe" && x.options.windowsHide));
  assert.ok(calls.every((x) => !x.args[0].includes("mitoto-data") && !x.args[0].includes("*")));
  assert.ok(!calls[0].args.some((x) => x.includes("(OI)") || x.includes("(CI)")));
});
