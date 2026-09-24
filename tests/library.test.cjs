const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { migrate, inspect, upsert, publicEntry } = require("../app/library.cjs");

test("legacy records migrate without losing positions, theme or paths", () => {
  const state = migrate({
    recent: [{ id: "a", path: "C:/book.pdf", opened: 2 }],
    books: { a: { page: 8 } },
    theme: "dark",
  });
  assert.equal(state.library[0].path, "C:/book.pdf");
  assert.equal(state.books.a.page, 8);
  assert.equal(state.theme, "dark");
  assert.equal(publicEntry(state.library[0]).path, undefined);
  for (let i = 0; i < 30; i++) upsert(state, { id: String(i), path: `${i}.pdf` });
  assert.equal(state.library.length, 31, "library must not be truncated to the old recent limit");
  upsert(state, { id: "a", path: "D:/moved.pdf" });
  assert.equal(state.library.length, 31);
  assert.equal(state.library[0].opened, 2);
  assert.equal(state.library[0].path, "D:/moved.pdf");
});
test("content identity deduplicates moves and invalidates changed files", async () => {
  const parent = path.join(__dirname, "tmp");
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, "library-"));
  const first = path.join(dir, "one.pdf"),
    copy = path.join(dir, "copy.pdf");
  await fs.writeFile(first, "sample PDF");
  await fs.copyFile(first, copy);
  const entry = await inspect(first);
  assert.equal((await inspect(copy)).id, entry.id);
  assert.equal((await inspect(first, entry)).id, entry.id);
  await fs.writeFile(first, "changed PDF content");
  assert.notEqual((await inspect(first, entry)).id, entry.id);
  await assert.rejects(inspect(path.join(dir, "missing.pdf")), { code: "ENOENT" });
  await assert.rejects(inspect(path.join(dir, "bad.exe")), /支持/);
});
