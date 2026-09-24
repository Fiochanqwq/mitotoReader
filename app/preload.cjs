const { contextBridge, ipcRenderer } = require("electron");
const call = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld("mitoto", {
  state: () => call("state"),
  open: (id) => call("open", id),
  initial: () => call("initial"),
  settings: (id, value) => call("settings", id, value),
  theme: (value) => call("theme", value),
  export: (text) => call("export", text),
  copy: (text) => call("copy", text),
  fullscreen: (value) => call("fullscreen", value),
  libraryAdd: () => call("library-add"),
  libraryRemove: (id) => call("library-remove", id),
  libraryRelink: (id) => call("library-relink", id),
  metadata: (id, value) => call("metadata", id, value),
  ocrCacheGet: (id, key) => call("ocr-cache-get", id, key),
  ocrCacheSet: (id, key, text) => call("ocr-cache-set", id, key, text),
  providerList: () => call("provider-list"),
  providerSave: (id, options) => call("provider-save", id, options),
  providerRemove: (id) => call("provider-remove", id),
  providerVerify: (id) => call("provider-verify", id),
  translate: (id, options) => call("translate", id, options),
  aiCancel: (id) => call("ai-cancel", id),
  translationLoad: (id, provider, target) => call("translation-load", id, provider, target),
  translationSave: (id, provider, target, results) => call("translation-save", id, provider, target, results),
  engineInstalled: (engine) => call("engine-installed", engine),
  engineInstall: (engine, options) => call("engine-install", engine, options),
  engineParse: (id, engine, options) => call("engine-parse", id, engine, options),
  engineStatus: (jobId) => call("engine-status", jobId),
  engineCancel: (jobId) => call("engine-cancel", jobId),
});
