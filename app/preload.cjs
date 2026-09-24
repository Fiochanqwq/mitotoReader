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
});
