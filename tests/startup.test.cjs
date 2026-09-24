const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const mainPath = path.join(root, "app/main.cjs");

async function boot() {
  let startup, handler, filter;
  const channels = new Set();
  const app = {
    whenReady: () => ({
      then(fn) {
        startup = Promise.resolve().then(fn);
        return startup;
      },
    }),
    getPath: (name) =>
      name === "exe" ? path.join(root, "tests/tmp/fake.exe") : path.join(root, "tests/tmp/startup-profile"),
    setPath() {},
    on() {},
    quit() {},
    exit() {},
  };
  class Window {
    constructor() {
      this.webContents = { setWindowOpenHandler() {}, on() {} };
    }
    setMenu() {}
    on() {}
    once() {}
    show() {}
    destroy() {}
    async loadURL(url) {
      const response = await handler({ url });
      assert.equal(response.status, 200, "Application HTML must load with the offline request filter enabled");
      assert.match(await response.text(), /mitotoReader/);
    }
  }
  const electron = {
    app,
    BrowserWindow: Window,
    dialog: {},
    ipcMain: {
      handle(name) {
        channels.add(name);
      },
    },
    protocol: {
      registerSchemesAsPrivileged() {},
      handle(_scheme, fn) {
        handler = fn;
      },
    },
    session: {
      defaultSession: {
        webRequest: {
          onBeforeRequest(fn) {
            filter = fn;
          },
        },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        on() {},
      },
    },
    net: {
      async fetch(url) {
        let blocked;
        filter({ url }, (result) => {
          blocked = result.cancel;
        });
        if (blocked) throw new Error("ERR_BLOCKED_BY_CLIENT: local asset request intercepted");
        return new Response(await fs.readFile(new URL(url)));
      },
    },
  };
  const localRequire = createRequire(mainPath);
  vm.runInNewContext(
    await fs.readFile(mainPath, "utf8"),
    {
      require: (name) => (name === "electron" ? electron : localRequire(name)),
      __dirname: path.dirname(mainPath),
      process: { env: {}, argv: [] },
      Response,
      URL,
      console,
      Buffer,
    },
    { filename: mainPath },
  );
  await startup;
  return { handler, filter, channels };
}

test("Offline startup loads local HTML and assets without opening Electron", async () => {
  const { handler, filter, channels } = await boot();
  assert.ok(channels.has("copy"), "Copy must be available before any export");
  for (const [file, mime] of [
    ["main.js", "javascript"],
    ["main.css", "text/css"],
    ["ocr/core/tesseract-core-lstm.wasm", "application/wasm"],
  ]) {
    const response = await handler({ url: `mitoto://app/${file}` });
    assert.equal(response.status, 200, file);
    assert.ok(response.headers.get("content-type")?.includes(mime), `${file}: correct MIME type`);
  }
  assert.equal((await handler({ url: "mitoto://app/missing-file.js" })).status, 404);
  assert.equal((await handler({ url: "mitoto://app/%2e%2e%5cpackage.json" })).status, 403);
  assert.equal((await handler({ url: "mitoto://other/main.js" })).status, 404);
  for (const url of ["https://example.com/", "file:///C:/Windows/win.ini"]) {
    let result;
    filter({ url }, (value) => {
      result = value;
    });
    assert.equal(result.cancel, true);
  }
});
