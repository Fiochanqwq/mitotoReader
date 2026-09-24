const { app, BrowserWindow, dialog, ipcMain, protocol, session, clipboard, safeStorage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { extensions, migrate, inspect, upsert, publicEntry, cacheKey } = require("./library.cjs");
const { assetHandler } = require("./assets.cjs");
const { prepareRuntime } = require("./runtime.cjs");
const { providers, validateProvider, verifyProvider, translateText } = require("./providers.cjs");
const { secretStore } = require("./secrets.cjs");
const { engineManager } = require("./engines.cjs");

const origin = "mitoto://app";
const testMode = process.env.MITOTO_TEST_MODE === "1";
let win;
let state = migrate();
let writes = Promise.resolve();
let persistTimer,
  dirty = false,
  quitting = false;
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
  clearTimeout(persistTimer);
  dirty = false;
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

function schedulePersist() {
  dirty = true;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist().catch((error) => console.error("Save failed", error)), 250);
}

function snapshot() {
  const library = state.library.map((entry) => publicEntry(entry, state.books[entry.id]));
  return { theme: state.theme, library, recent: library.filter((x) => x.opened).sort((a, b) => b.opened - a.opened) };
}

async function cacheFile(id, key) {
  if (!state.library.some((x) => x.id === id) || typeof key !== "string" || key.length > 2048)
    throw new Error("缓存参数无效");
  const dir = path.join(app.getPath("userData"), "ocr-cache");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, cacheKey(id + ":" + key) + ".txt");
}
async function translationFile(id, provider, target) {
  if (!state.library.some((entry) => entry.id === id) || !Object.hasOwn(providers, provider) || typeof target !== "string" || target.length > 40)
    throw new Error("翻译缓存参数无效。");
  const dir = path.join(app.getPath("userData"), "translations");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, cacheKey(`${id}:${provider}:${target}`) + ".json");
}

async function openDocument(file) {
  const info = await inspect(
    file,
    state.library.find((x) => x.path === file),
  );
  const bytes = await fs.readFile(file);
  const entry = upsert(state, info, true);
  await persist();
  return { ...publicEntry(entry), bytes, settings: state.books[entry.id] || {} };
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
      state = migrate(saved);
    } catch {}
    const secrets = secretStore(safeStorage, app.getPath("userData"));
    const engines = engineManager(app.getPath("userData"));

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
      minWidth: 560,
      minHeight: 420,
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
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      (dirty ? persist() : writes)
        .then(() => win.close())
        .catch((error) => {
          quitting = false;
          dialog.showErrorBox("未能保存阅读记录", error.message);
        });
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    session.defaultSession.on("will-download", (event) => event.preventDefault());

    handle("state", () => snapshot());
    handle("provider-list", async () => {
      const configured = new Set(await secrets.status());
      return Object.entries(providers).map(([id, preset]) => ({
        id, name: preset.name, model: state.providers[id]?.model || preset.model,
        region: state.providers[id]?.region || "cn", configured: configured.has(id),
      }));
    });
    handle("provider-save", async (id, options) => {
      validateProvider(id);
      if (!options || typeof options !== "object") throw new Error("服务配置无效。");
      const model = options.model || providers[id].model;
      if (typeof model !== "string" || !/^[a-zA-Z0-9._:-]{2,100}$/.test(model)) throw new Error("模型名称无效。");
      const region = options.region === "global" ? "global" : "cn";
      if (typeof options.key === "string" && options.key.trim()) {
        if (options.key.length > 500) throw new Error("API Key 过长。");
        await secrets.save(id, options.key.trim());
      }
      state.providers[id] = { model, region };
      await persist();
      return true;
    });
    handle("provider-remove", async (id) => {
      validateProvider(id);
      await secrets.save(id, null);
      return true;
    });
    handle("provider-verify", async (id) => {
      validateProvider(id);
      const key = await secrets.get(id);
      if (!key) throw new Error("请先保存 API Key。");
      return verifyProvider(id, key, state.providers[id]?.region);
    });
    handle("translate", async (id, input) => {
      if (!state.library.some((entry) => entry.id === id)) throw new Error("文档不存在。");
      if (!input || typeof input !== "object") throw new Error("翻译请求无效。");
      validateProvider(input.provider);
      const key = await secrets.get(input.provider);
      if (!key) throw new Error("请先配置 API Key。");
      return translateText({
        provider: input.provider, key, region: state.providers[input.provider]?.region,
        model: state.providers[input.provider]?.model, text: input.text, target: input.target,
      });
    });
    handle("translation-load", async (id, provider, target) => {
      const file = await translationFile(id, provider, target);
      return fs.readFile(file, "utf8").then(JSON.parse).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    });
    handle("translation-save", async (id, provider, target, results) => {
      const file = await translationFile(id, provider, target);
      if (!Array.isArray(results) || results.length > 5000) throw new Error("翻译结果无效。");
      const data = JSON.stringify(results);
      if (data.length > 10_000_000) throw new Error("翻译结果过大。");
      await fs.writeFile(file + ".tmp", data, "utf8");
      await fs.rename(file + ".tmp", file);
    });
    handle("engine-installed", (engine) => engines.installed(engine));
    handle("engine-install", (engine) => engines.install(engine));
    handle("engine-parse", (id, engine) => {
      const entry = state.library.find((item) => item.id === id);
      if (!entry) throw new Error("文档不存在。");
      return engines.parse(engine, entry.path);
    });
    handle("engine-status", (jobId) => engines.status(jobId));
    handle("engine-cancel", (jobId) => engines.cancel(jobId));
    handle("fullscreen", (value) => {
      win.setFullScreen(typeof value === "boolean" ? value : !win.isFullScreen());
      return win.isFullScreen();
    });
    handle("library-add", async () => {
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "阅读文档", extensions: [...extensions].map((x) => x.slice(1)) }],
      });
      const errors = [];
      for (const file of result.filePaths || []) {
        try {
          upsert(
            state,
            await inspect(
              file,
              state.library.find((x) => x.path === file),
            ),
          );
        } catch (error) {
          errors.push(`${path.basename(file)}：${error.message}`);
        }
      }
      await persist();
      return { ...snapshot(), errors };
    });
    handle("library-remove", async (id) => {
      state.library = state.library.filter((x) => x.id !== id);
      // Keep positions and bookmarks so re-importing an unchanged file restores them.
      await persist();
    });
    handle("library-relink", async (id) => {
      const entry = state.library.find((x) => x.id === id);
      if (!entry) throw new Error("书籍不存在");
      const result = await dialog.showOpenDialog(win, { properties: ["openFile"], title: "重新定位原文件" });
      if (result.canceled) return false;
      const info = await inspect(result.filePaths[0]);
      if (info.id !== id) throw new Error("所选文件与原书内容不同，请通过添加图书导入。");
      upsert(state, info);
      await persist();
      return true;
    });
    handle("metadata", (id, value) => {
      const entry = state.library.find((x) => x.id === id);
      if (!entry || !value || typeof value !== "object") return;
      for (const key of ["title", "author"]) if (typeof value[key] === "string") entry[key] = value[key].slice(0, 512);
      if (
        typeof value.cover === "string" &&
        /^data:image\/(png|jpeg);base64,/.test(value.cover) &&
        value.cover.length < 100000
      )
        entry.cover = value.cover;
      schedulePersist();
    });
    handle("ocr-cache-get", async (id, key) => {
      const file = await cacheFile(id, key);
      return fs.readFile(file, "utf8").catch(() => null);
    });
    handle("ocr-cache-set", async (id, key, text) => {
      if (typeof text !== "string" || text.length > 2_000_000) throw new Error("缓存内容过大");
      const file = await cacheFile(id, key);
      await fs.writeFile(file, text, "utf8");
      const dir = path.dirname(file);
      const files = await Promise.all(
        (await fs.readdir(dir))
          .filter((x) => /^[a-f0-9]{64}\.txt$/.test(x))
          .map(async (name) => {
            const target = path.join(dir, name);
            const stat = await fs.stat(target);
            return { target, ...stat };
          }),
      );
      let bytes = files.reduce((n, x) => n + x.size, 0);
      for (const item of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (bytes <= 32 * 1024 * 1024) break;
        await fs.unlink(item.target);
        bytes -= item.size;
      }
    });
    handle("open", async (id) => {
      if (id) {
        const entry = state.library.find((x) => x.id === id);
        if (!entry) throw new Error("找不到最近阅读记录。");
        try {
          return await openDocument(entry.path);
        } catch (error) {
          if (error.code === "ENOENT") {
            entry.missing = true;
            await persist();
            throw new Error("原文件已移动，请在书库中重新定位。");
          }
          throw error;
        }
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
      if (!state.library.some((x) => x.id === id)) return;
      if (!value || typeof value !== "object" || JSON.stringify(value).length > 262144) throw new Error("设置无效");
      state.books[id] = value;
      schedulePersist();
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
