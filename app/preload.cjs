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
});
