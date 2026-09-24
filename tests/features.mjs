import { _electron as electron } from "playwright-core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, ".."),
  tmp = join(root, "tests/tmp");
await mkdir(tmp, { recursive: true });
const profile = join(tmp, `features-${Date.now()}`),
  fixture = join(tmp, "features.pdf"),
  moved = join(tmp, "features-moved.pdf");
const epub = join(tmp, "reader-fixtures/ja-vertical.epub");
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.setTitle("Feature Test Book");
pdf.setAuthor("Reader Test");
for (let i = 1; i <= 3; i++) {
  const p = pdf.addPage([595, 842]);
  p.drawText(`LibrarySearchToken page ${i}`, { x: 50, y: 720, size: 26, font });
}
await writeFile(fixture, await pdf.save());
let app, page;
const errors = [];
async function launch(file = fixture) {
  app = await electron.launch({
    executablePath: process.env.MITOTO_TEST_EXE || join(root, "node_modules/electron/dist/electron.exe"),
    args: process.env.MITOTO_TEST_EXE ? [] : [root],
    env: { ...process.env, MITOTO_TEST_MODE: "1", MITOTO_TEST_PROFILE: profile, MITOTO_TEST_FILE: file },
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  if (file) await ready();
  else await page.locator("#home").waitFor();
}
async function ready() {
  await page.waitForFunction(
    () =>
      !document.getElementById("reader").hidden && document.getElementById("reading-status").textContent === "本地阅读",
    null,
    { timeout: 45000 },
  );
}
async function close() {
  if (app) await app.close();
  app = null;
}
async function selectFile(file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: Array.isArray(file) ? file : [file] });
  }, file);
}
async function openFile(file) {
  await selectFile(file);
  await page.locator("#open").click();
  await page.waitForFunction(
    (name) => document.getElementById("document-title").textContent === name,
    file.split(/[\\/]/).pop(),
  );
  await ready();
}
try {
  await launch();
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("LibrarySearchToken"));
  // Fit reacts to viewport changes without losing the current page.
  await page.locator("#next").click();
  await page.waitForFunction(() => document.getElementById("page-number").value === "2");
  await page.locator("#bookmark-add").click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(650, 520));
  await page.waitForFunction(() => {
    const stage = document.getElementById("reading-stage"),
      canvas = document.querySelector("#viewport canvas");
    return (
      canvas &&
      canvas.getBoundingClientRect().width <= stage.clientWidth &&
      canvas.getBoundingClientRect().height <= stage.clientHeight
    );
  });
  assert.equal(await page.locator("#page-number").inputValue(), "2");
  await page.keyboard.press("F11");
  await page.waitForTimeout(300);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await page.keyboard.press("F11");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await page.keyboard.press("Control+f");
  await page.locator("#search-query").fill("LibrarySearchToken");
  await page.locator("#search-query").press("Enter");
  await page.waitForFunction(() => document.getElementById("search-status").textContent.startsWith("找到 3 处"));
  await page.locator("#search-results button").last().click();
  await page.waitForFunction(() => document.getElementById("page-number").value === "3");
  await page.locator("#bookmarks-toggle").click();
  await page.locator("#bookmarks button").first().click();
  await page.waitForFunction(() => document.getElementById("page-number").value === "2");
  // Editing fields must not trigger reader shortcuts.
  await page.keyboard.press("Control+f");
  await page.locator("#search-query").fill("input");
  await page.locator("#search-query").press("PageDown");
  assert.equal(await page.locator("#page-number").inputValue(), "2");
  await page.locator("#home-button").click();
  await page.waitForFunction(() => document.querySelector(".book-info strong")?.textContent === "Feature Test Book");
  await selectFile([fixture, epub]);
  await page.locator("#library-add").click();
  await page.waitForFunction(() => document.querySelectorAll(".book-card").length === 2);
  await page.locator("#library-query").fill("Reader Test");
  assert.equal(await page.locator(".book-card").count(), 1);
  await page.locator("#library-query").fill("");
  // Move the file, fail to reopen, then relink by content identity.
  await rename(fixture, moved);
  await page.locator(".book-open").filter({ hasText: "Feature Test Book" }).click();
  await page.waitForFunction(() => document.getElementById("message").textContent.includes("重新定位"));
  const card = page.locator(".book-card").filter({ hasText: "Feature Test Book" });
  await selectFile(moved);
  await card.getByText("重新定位", { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#recent")?.textContent.includes("文件已移动"));
  await card.locator(".book-open").click();
  await ready();
  assert.equal(await page.locator("#page-number").inputValue(), "2");
  await openFile(epub);
  await page.keyboard.press("Control+f");
  await page.locator("#search-query").fill("図書館");
  await page.locator("#search-query").press("Enter");
  await page.waitForFunction(() => document.getElementById("search-status").textContent.startsWith("找到 1 处"));
  await page.locator("#search-results button").click();
  await page.waitForFunction(() => document.querySelector("#viewport iframe")?.contentDocument?.querySelector("ruby"));
  await page.locator("#bookmark-add").click();
  // Bad documents must recover to a usable library.
  const bad = join(tmp, "broken.pdf");
  await writeFile(bad, "not a PDF");
  await selectFile(bad);
  await page.locator("#open").click();
  await page.waitForFunction(
    () =>
      !document.getElementById("home").hidden && document.getElementById("document-title").textContent === "打开失败",
  );
  await openFile(moved);
  await close();
  const saved = JSON.parse(await readFile(join(profile, "reader.json"), "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.library.filter((x) => x.title === "Feature Test Book").length, 1);
  assert.equal(saved.books[saved.library.find((x) => x.title === "Feature Test Book").id].bookmarks.length, 1);
  await launch("");
  await page.locator("#library-query").fill("Feature Test Book");
  await page.locator(".book-actions button").last().click();
  await page.waitForFunction(() => document.querySelectorAll(".book-card").length === 0);
  assert.ok((await readFile(moved)).length > 0, "removing a library entry must not delete the source");
  await close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: responsive fit, fullscreen, search, bookmarks, persistent library, deduplication, relink, EPUB search, invalid-file recovery.",
  );
} catch (error) {
  if (page && !page.isClosed())
    console.error(
      await page.evaluate(() => ({
        title: document.getElementById("document-title").textContent,
        message: document.getElementById("message").textContent,
        home: document.getElementById("home").hidden,
        cards: document.getElementById("recent").textContent,
        status: document.getElementById("search-status").textContent,
      })),
    );
  throw error;
} finally {
  await close();
}
