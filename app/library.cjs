const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

const extensions = new Set([".pdf", ".epub", ".png", ".jpg", ".jpeg"]);
const fileLimit = 256 * 1024 * 1024;
function migrate(saved = {}) {
  const library = Array.isArray(saved.library) ? saved.library : Array.isArray(saved.recent) ? saved.recent : [];
  return {
    version: 2,
    library: library.filter((x) => x && typeof x.id === "string" && typeof x.path === "string"),
    books: saved.books && typeof saved.books === "object" ? saved.books : {},
    theme: saved.theme === "dark" ? "dark" : "light",
  };
}
async function inspect(file, known) {
  const ext = path.extname(file).toLowerCase();
  if (!extensions.has(ext)) throw new Error("支持 PDF、EPUB、PNG 和 JPEG。");
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > fileLimit) throw new Error("文件过大：上限为 256 MB。");
  let id = known?.size === stat.size && known?.mtime === stat.mtimeMs ? known.id : null;
  if (!id) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    id = hash.digest("hex");
  }
  return { id, path: file, name: path.basename(file), kind: ext.slice(1), size: stat.size, mtime: stat.mtimeMs };
}
function upsert(state, entry, opened = false) {
  const old = state.library.find((x) => x.id === entry.id);
  const next = { added: Date.now(), ...old, ...entry, missing: false };
  if (opened) next.opened = Date.now();
  state.library = [next, ...state.library.filter((x) => x.id !== entry.id)];
  return next;
}
function publicEntry(entry, settings = {}) {
  const { path: _path, mtime: _mtime, ...safe } = entry;
  return { ...safe, progress: Math.max(0, Math.min(1, Number(settings.progress) || 0)) };
}
function cacheKey(value) {
  return createHash("sha256").update(value).digest("hex");
}
module.exports = { extensions, fileLimit, migrate, inspect, upsert, publicEntry, cacheKey };
