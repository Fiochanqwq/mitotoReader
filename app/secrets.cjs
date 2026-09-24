const fs = require("node:fs/promises");
const path = require("node:path");

function secretStore(safeStorage, userData) {
  const file = path.join(userData, "provider-keys.json");
  let queue = Promise.resolve();
  async function read() {
    return fs
      .readFile(file, "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      });
  }
  async function get(id) {
    const value = (await read())[id];
    if (!value) return null;
    const encrypted = Buffer.from(value, "base64");
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    return decrypted.result;
  }
  function save(id, key) {
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统密钥存储暂不可用。");
        const data = await read();
        if (key) data[id] = (await safeStorage.encryptStringAsync(key)).toString("base64");
        else delete data[id];
        await fs.mkdir(userData, { recursive: true });
        await fs.writeFile(file + ".tmp", JSON.stringify(data), { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
      });
    return queue;
  }
  async function status() {
    return Object.keys(await read());
  }
  return { get, save, status };
}
module.exports = { secretStore };
