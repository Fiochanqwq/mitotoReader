import { _electron as electron } from "playwright-core";
import JSZip from "jszip";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, ".."),
  tmp = join(root, "tests/tmp");
await mkdir(tmp, { recursive: true });
const profile = join(tmp, `long-epub-${Date.now()}`),
  file = join(tmp, "long.epub");
const zip = await JSZip.loadAsync(await readFile(join(tmp, "reader-fixtures/ja-vertical.epub")));
const paragraphs = Array.from(
  { length: 160 },
  (_, i) => `<p id="p${i}">段落${i}。${"雨が降る。静かな図書館で本を読む。長い物語の続きを探す。".repeat(8)}</p>`,
).join("");
zip.file(
  "OEBPS/chapter.xhtml",
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>長篇</title></head><body>${paragraphs}</body></html>`,
);
await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
let app, page;
async function saved() {
  const state = JSON.parse(await readFile(join(profile, "reader.json"), "utf8"));
  return state.books[state.library[0].id];
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.MITOTO_TEST_EXE || join(root, "node_modules/electron/dist/electron.exe"),
    args: process.env.MITOTO_TEST_EXE ? [] : [root],
    env: { ...process.env, MITOTO_TEST_MODE: "1", MITOTO_TEST_PROFILE: profile, MITOTO_TEST_FILE: file },
    timeout: 45000,
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById("reading-status").textContent === "本地阅读", null, {
    timeout: 45000,
  });
  await page.waitForTimeout(800);
}
try {
  await launch();
  for (let i = 0; i < 5; i++) {
    await page.locator("#next").click();
    await page.waitForTimeout(200);
  }
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(500);
  const before = await saved();
  assert.equal(before.bookmarks.length, 1);
  assert.ok(before.progress > 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 540));
  await page.waitForTimeout(1000);
  const resized = await saved();
  assert.equal(resized.cfi, before.cfi, "resize should retain the stored passage locator");
  await app.close();
  app = null;
  await launch();
  const reopened = await saved();
  assert.equal(reopened.bookmarks[0].key, before.bookmarks[0].key);
  assert.ok(reopened.progress > 0, "long book must not reopen at the beginning");
  await page.locator("#bookmarks-toggle").click();
  await page.locator("#bookmarks button").first().click();
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#message").textContent(), "", "bookmark navigation should not surface errors");
  console.log("PASS: long EPUB position across resize/reopen and persistent CFI bookmark.");
} finally {
  if (app) await app.close();
}
