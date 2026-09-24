import { _electron as electron } from "playwright-core";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const tmp = join(root, "tests/tmp");
await mkdir(tmp, { recursive: true });
const profile = join(tmp, `profile-${Date.now()}`);
const fixture = join(tmp, "reading.pdf");
const epub = join(tmp, "reader-fixtures/ja-vertical.epub");
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i++) {
  const page = doc.addPage([595, 842]);
  page.drawText("A little space to read.", { x: 56, y: 730, size: 30, font, color: rgb(0.13, 0.13, 0.13) });
  page.drawText(`ReaderTestToken page ${i}`, { x: 56, y: 660, size: 22, font });
  page.drawText("Offline reading. Your documents stay with you.", { x: 56, y: 610, size: 15, font });
}
await writeFile(fixture, await doc.save());
async function officeFixture(name, files) {
  const zip = new JSZip();
  for (const [file, content] of Object.entries(files)) zip.file(file, content);
  const target = join(tmp, name);
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
  return target;
}
const docx = await officeFixture("reader.docx", {
  "word/document.xml": '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hello DOCX reader</w:t></w:r></w:p></w:body></w:document>',
});
const pptx = await officeFixture("reader.pptx", {
  "ppt/slides/slide1.xml": '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:sp><a:p><a:r><a:t>Hello PPTX slide</a:t></a:r></a:p></p:sp></p:sld>',
});
const xlsx = await officeFixture("reader.xlsx", {
  "xl/sharedStrings.xml": '<sst><si><t>Hello XLSX cell</t></si></sst>',
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
});
let app, page;
const errors = [];
async function launch(file) {
  app = await electron.launch({
    executablePath: process.env.MITOTO_TEST_EXE || join(root, "node_modules/electron/dist/electron.exe"),
    args: process.env.MITOTO_TEST_EXE ? [] : [root],
    env: { ...process.env, MITOTO_TEST_MODE: "1", MITOTO_TEST_PROFILE: profile, MITOTO_TEST_FILE: file || "" },
    timeout: 45000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") console.log("Browser:", entry.text().slice(0, 300));
  });
  await page.waitForFunction(() => document.getElementById("recent")?.children.length > 0);
  if (file)
    await page.waitForFunction(
      () =>
        document.getElementById("reading-status").textContent === "本地阅读" &&
        !document.getElementById("reader").hidden,
      null,
      { timeout: 45000 },
    );
}
async function close() {
  if (app) await app.close();
  app = null;
}
async function screenshot(name) {
  if (process.env.MITOTO_CAPTURE !== "1") return;
  const bytes = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return [...image.toPNG()];
  });
  await writeFile(join(tmp, name), Buffer.from(bytes));
}
try {
  await launch();
  await screenshot("home.png");
  await close();
  await launch(fixture);
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("ReaderTestToken"));
  await page.locator("#next").click();
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("page 2"));
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.getElementById("page-number").value === "1");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.getElementById("page-number").value === "2");
  const beforeZoom = parseInt(await page.locator("#zoom-label").textContent());
  await page.locator("#zoom-in").click();
  await page.waitForFunction(
    (before) => parseInt(document.getElementById("zoom-label").textContent) > before,
    beforeZoom,
  );
  const wheelZoom = parseInt(await page.locator("#zoom-label").textContent());
  await page
    .locator("#reading-stage")
    .dispatchEvent("wheel", { ctrlKey: true, deltaY: -100, clientX: 400, clientY: 300 });
  await page.waitForFunction(
    (before) => parseInt(document.getElementById("zoom-label").textContent) > before,
    wheelZoom,
  );
  await page.keyboard.press("F9");
  assert.equal(await page.locator("#reader").getAttribute("class"), "focus-mode");
  assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#reader").getAttribute("class"), "");
  await page.waitForFunction(() => document.querySelector(".textLayer")?.textContent.includes("ReaderTestToken"));
  const selection = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".textLayer"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup"));
    return selection.toString();
  });
  assert.match(selection, /ReaderTestToken/);
  await page.keyboard.press("Control+t");
  assert.equal(await page.locator("#quick-toolbox").isVisible(), true);
  await page.locator("#quick-highlight").click();
  await page.waitForFunction(() => document.querySelectorAll(".annotation-highlight").length > 0);
  await page.keyboard.press("Control+t");
  assert.equal(await page.locator("#quick-toolbox").isVisible(), false);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(
    await page.evaluate(() =>
      fetch("https://example.com/")
        .then(() => false)
        .catch(() => true),
    ),
    true,
  );
  await page.locator("#tools-toggle").click();
  await page.locator("#ocr-language").selectOption("eng");
  await page.locator("#ocr-start").click();
  await page.waitForFunction(
    () =>
      document.getElementById("ocr-status").textContent.includes("已完成") ||
      document.getElementById("ocr-status").textContent.includes("识别失败"),
    null,
    { timeout: 120000 },
  );
  const recognized = await page.locator("#ocr-result").inputValue();
  assert.match(recognized, /A little space to read/);
  assert.match(recognized, /page 2/);
  assert.match(recognized, /Your documents stay with you/);
  await page.locator("#ocr-copy").click();
  await page.waitForFunction(() => document.getElementById("message").textContent === "已复制识别文字");
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(copied, recognized);
  const exported = join(tmp, "ocr-export.txt");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exported);
  await page.locator("#ocr-export").click();
  await page.waitForFunction(() => document.getElementById("message").textContent === "已导出 TXT");
  assert.equal((await readFile(exported, "utf8")).replace(/^\ufeff/, ""), recognized);
  await screenshot("pdf-ocr.png");
  await page.locator("#ocr-start").click();
  await page.waitForFunction(() => document.getElementById("ocr-status").textContent.includes("来自缓存"));
  assert.equal(await page.locator("#ocr-result").inputValue(), recognized);
  await page.locator("#ocr-pages").fill("1-2");
  await page.locator("#ocr-start").click();
  await page.waitForFunction(
    () => document.getElementById("ocr-status").textContent.startsWith("已完成 · 2 页"),
    null,
    { timeout: 120000 },
  );
  const batch = await page.locator("#ocr-result").inputValue();
  assert.match(batch, /第 1 页/);
  assert.match(batch, /第 2 页/);
  assert.match(batch, /page 1/);
  assert.match(batch, /page 2/);
  await page.locator("#workbench-toggle").click();
  assert.equal(await page.locator("#workbench").isVisible(), true);
  await page.locator("#workbench-api-tab").click();
  await page.locator("#provider-cards button").first().waitFor();
  await page.locator("#provider-key").fill("integration-secret-key");
  await page.locator("#provider-save").click();
  await page.waitForFunction(() => document.getElementById("provider-status").textContent.includes("已保存"));
  assert.equal((await readFile(join(profile, "reader.json"), "utf8")).includes("integration-secret-key"), false);
  await page.locator("#provider-remove").click();
  await page.locator("#workbench-ocr-tab").click();
  await page.locator("#ocr-all").click();
  await page.waitForFunction(
    () => document.getElementById("ocr-status").textContent.startsWith("已完成 · 2 页"),
    null,
    { timeout: 120000 },
  );
  assert.match(await page.locator("#ocr-result").inputValue(), /第 2 页/);
  await page.locator("#workbench-back").click();
  await page.locator("#tools-toggle").click();
  await page.locator("#ocr-pages").fill("");
  await page.locator("#ocr-region").click();
  const region = await page.locator(".crop-overlay").boundingBox();
  await page.mouse.move(region.x + region.width * 0.05, region.y + region.height * 0.06);
  await page.mouse.down();
  await page.mouse.move(region.x + region.width * 0.95, region.y + region.height * 0.22);
  await page.mouse.up();
  await page.locator("#ocr-start").click();
  await page.waitForFunction(() => document.getElementById("ocr-status").textContent.startsWith("已完成"), null, {
    timeout: 120000,
  });
  assert.match(await page.locator("#ocr-result").inputValue(), /A little space to read/);
  assert.doesNotMatch(await page.locator("#ocr-result").inputValue(), /Your documents stay with you/);
  await page.locator("#ocr-region-clear").click();
  await page.locator("#ocr-rotation").selectOption("180");
  await page.locator("#ocr-start").click();
  await page.locator("#ocr-cancel").click();
  await page.waitForFunction(() => document.getElementById("ocr-status").textContent.startsWith("已取消识别"));
  await page.locator("#ocr-rotation").selectOption("90");
  await page.locator("#ocr-start").click();
  await page.locator("#home-button").click();
  await page.waitForFunction(() => !document.getElementById("home").hidden);
  await page.waitForFunction(() => document.getElementById("ocr-result").value === "");
  await page.locator("#theme").click();
  await close();
  await launch(fixture);
  assert.equal(await page.locator("#page-number").inputValue(), "2");
  await page.waitForFunction(() => document.querySelector("#annotations-list .bookmark-row") && document.querySelector(".annotation-highlight"));
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.locator("#theme").click();
  await close();
  await launch(epub);
  await page.waitForFunction(() => document.querySelector("#viewport iframe")?.contentDocument?.querySelector("ruby"));
  await page.locator("#tools-toggle").click();
  await page.locator("#type-toggle").click();
  await page.locator("#writing-mode").selectOption("vertical");
  await page.locator("#font-size").fill("130");
  await page.locator("#font-size").dispatchEvent("change");
  await page.waitForFunction(() => {
    const body = document.querySelector("#viewport iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).writingMode === "vertical-rl";
  });
  await screenshot("epub-vertical.png");
  await page.locator("#writing-mode").selectOption("horizontal");
  await page.waitForFunction(() => {
    const body = document.querySelector("#viewport iframe")?.contentDocument?.body;
    return body && getComputedStyle(body).writingMode === "horizontal-tb";
  });
  await close();
  await launch(epub);
  assert.equal(await page.locator("#writing-mode").inputValue(), "horizontal");
  assert.equal(await page.locator("#font-size").inputValue(), "130");
  await close();
  for (const [file, expected] of [[docx, "Hello DOCX reader"], [pptx, "Hello PPTX slide"], [xlsx, "Hello XLSX cell"]]) {
    await launch(file);
    await page.waitForFunction((value) => document.querySelector(".structured-page")?.textContent.includes(value), expected);
    await close();
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: PDF rendering/text/position, arrows/wheel/focus/drawer/workbench, EPUB ruby/direction/settings, offline English OCR/copy/export/cancel, theme, isolation.",
  );
} finally {
  await close();
}
