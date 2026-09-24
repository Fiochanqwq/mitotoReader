const { app, BrowserWindow, dialog, ipcMain, protocol, session, clipboard } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assetHandler } = require("./assets.cjs");
const { prepareRuntime } = require("./runtime.cjs");

const origin = "mitoto://app";
const extensions = new Set([".pdf", ".epub", ".png", ".jpg", ".jpeg"]);
const testMode = process.env.MITOTO_TEST_MODE === "1";
const fileLimit = 256 * 1024 * 1024;
let win;
let state = { recent: [], books: {}, theme: "light" };
let writes = Promise.resolve();
let startupFailed = false;
if (process.platform === "win32") {
  try {
    prepareRuntime(path.dirname(process.execPath));
  } catch (error) {
    void failStartup(error);
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mitoto",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

if (testMode && process.env.MITOTO_TEST_PROFILE) app.setPath("userData", process.env.MITOTO_TEST_PROFILE);

function persist() {
  const data = JSON.stringify(state);
  writes = writes
    .catch(() => {})
    .then(async () => {
      const file = path.join(app.getPath("userData"), "reader.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + ".tmp", data);
      await fs.rename(file + ".tmp", file);
    });
  return writes;
}

async function openDocument(file) {
  const ext = path.extname(file).toLowerCase();
  if (!extensions.has(ext)) throw new Error("测试版支持 PDF、EPUB、PNG 和 JPEG。");
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > fileLimit) throw new Error("文件过大：测试版上限为 256 MB。");
  const bytes = await fs.readFile(file);
  const id = createHash("sha256").update(bytes).digest("hex");
  const entry = { id, path: file, name: path.basename(file), kind: ext.slice(1), opened: Date.now() };
  state.recent = [entry, ...state.recent.filter((x) => x.id !== id)].slice(0, 20);
  await persist();
  return { ...entry, path: undefined, bytes, settings: state.books[id] || {} };
}

function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      !event.senderFrame.url.startsWith(origin + "/")
    )
      throw new Error("拒绝访问");
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error.message || "操作失败" };
    }
  });
}

async function failStartup(error) {
  if (startupFailed) return;
  startupFailed = true;
  const text = `mitotoReader startup failed: ${error?.stack || error}\n`;
  console.error(text);
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(path.join(app.getPath("userData"), "startup-error.log"), text);
  } catch {
    // The console remains available when the profile directory is unwritable.
  } finally {
    app.exit(1);
  }
}

app
  .whenReady()
  .then(async () => {
    const portable = path.join(path.dirname(app.getPath("exe")), "portable.txt");
    if (!testMode && (await fs.stat(portable).catch(() => null)))
      app.setPath("userData", path.join(path.dirname(portable), "mitoto-data"));
    try {
      const saved = JSON.parse(await fs.readFile(path.join(app.getPath("userData"), "reader.json"), "utf8"));
      if (Array.isArray(saved.recent) && saved.books && typeof saved.books === "object") state = saved;
    } catch {}

    const root = path.resolve(__dirname, "../build");
    protocol.handle("mitoto", assetHandler(root));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(mitoto:\/\/app\/|blob:|data:|devtools:)/.test(details.url);
      callback({ cancel: !allowed });
    });
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({
      show: false,
      title: "mitotoReader",
      icon: path.join(__dirname, "../build/icon.png"),
      width: 1280,
      height: 860,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: "#f7f7f5",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: !testMode,
      },
    });
    win.once("ready-to-show", () => {
      if (!testMode) win.show();
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit")
        void failStartup(new Error(`Renderer ${details.reason}, exit ${details.exitCode}`));
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    session.defaultSession.on("will-download", (event) => event.preventDefault());

    handle("state", () => ({ ...state, recent: state.recent.map(({ path: _path, ...entry }) => entry) }));
    handle("open", async (id) => {
      if (id) {
        const entry = state.recent.find((x) => x.id === id);
        if (!entry) throw new Error("找不到最近阅读记录。");
        return openDocument(entry.path);
      }
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "阅读文档", extensions: [...extensions].map((x) => x.slice(1)) }],
      });
      return result.canceled ? null : openDocument(result.filePaths[0]);
    });
    handle("initial", async () => {
      const file = testMode
        ? process.env.MITOTO_TEST_FILE
        : process.argv.find((x) => extensions.has(path.extname(x).toLowerCase()));
      return file ? openDocument(path.resolve(file)) : null;
    });
    handle("settings", async (id, value) => {
      if (!state.recent.some((x) => x.id === id)) return;
      if (!value || typeof value !== "object" || JSON.stringify(value).length > 16384) throw new Error("设置无效");
      state.books[id] = value;
      await persist();
    });
    handle("theme", async (theme) => {
      state.theme = theme === "dark" ? "dark" : "light";
      await persist();
    });
    handle("export", async (text) => {
      if (typeof text !== "string" || text.length > 10_000_000) throw new Error("导出内容无效");
      const result = await dialog.showSaveDialog(win, {
        defaultPath: "mitoto-ocr.txt",
        filters: [{ name: "文本", extensions: ["txt"] }],
      });
      if (!result.canceled) await fs.writeFile(result.filePath, "\ufeff" + text, "utf8");
      return !result.canceled;
    });
    handle("copy", (text) => {
      if (typeof text !== "string" || text.length > 10_000_000) throw new Error("复制内容无效");
      clipboard.writeText(text);
    });
    await win.loadURL(origin + "/index.html");
  })
  .catch(failStartup);
app.on("window-all-closed", () => app.quit());
