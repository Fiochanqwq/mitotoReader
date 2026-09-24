import { _electron as electron } from "playwright-core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  tmp = join(root, "tests/tmp");
await mkdir(tmp, { recursive: true });
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 12; i++) {
  const page = pdf.addPage([595, i % 2 ? 842 : 750]);
  page.drawText(`Page ${i}: Scientific results, n = 20.`, { x: 40, y: 600, font, size: 18 });
}
const fixture = join(tmp, "continuous.pdf");
await writeFile(fixture, await pdf.save());
const profile = join(tmp, `workbench-${Date.now()}`);
const app = await electron.launch({
  executablePath: process.env.MITOTO_TEST_EXE || join(root, "node_modules/electron/dist/electron.exe"),
  args: process.env.MITOTO_TEST_EXE ? [] : [root],
  env: { ...process.env, MITOTO_TEST_MODE: "1", MITOTO_TEST_PROFILE: profile, MITOTO_TEST_FILE: fixture },
  timeout: 45000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById("reading-status").textContent === "本地阅读");
  await page.locator("#reading-mode").selectOption("continuous");
  await page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 12);
  await page.locator("#page-number").fill("8");
  await page.locator("#page-number").press("Enter");
  await page.waitForFunction(() =>
    document.querySelector('.pdf-page[data-page="8"] .textLayer')?.textContent.includes("Page 8"),
  );
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#page-number").inputValue(), "8");
  assert.ok((await page.locator("#viewport canvas").count()) <= 5);
  await page
    .locator("#reading-stage")
    .evaluate((node) => (node.scrollTop += document.querySelector('.pdf-page[data-page="8"]').offsetHeight + 100));
  await page.waitForFunction(() => Number(document.getElementById("page-number").value) > 8);
  await page.locator("#reading-mode").selectOption("paged");
  await page.locator("#fit-mode").selectOption("page");
  await page.locator("#page-number").fill("2");
  await page.locator("#page-number").press("Enter");
  await page.waitForFunction(() => document.querySelector("#viewport > .textLayer")?.textContent.includes("Page 2"));
  await page.locator("#reading-stage").dispatchEvent("wheel", { deltaY: 140 });
  await page.waitForFunction(() => document.getElementById("page-number").value === "3");
  await page.locator("#workbench-toggle").click();
  await page.locator("#ocr-preset").selectOption("ieee");
  assert.equal(await page.locator("#ocr-language").inputValue(), "eng");
  await page.locator(".advanced-settings summary").first().click();
  await page.locator("#profile-name").fill("My paper");
  await page.locator("#profile-save").click();
  assert.equal(await page.locator("#ocr-preset option:checked").textContent(), "My paper");
  await page.locator("#ocr-ai").click();
  assert.equal(await page.locator("#ai-task").inputValue(), "correct");
  assert.equal(await page.locator("#translate-target").isDisabled(), true);
  // Stub transport at IPC boundary, leaving the real renderer lifecycle and persistence intact.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("provider-list");
    ipcMain.handle("provider-list", () => ({
      ok: true,
      value: [{ id: "openai", name: "Test provider", model: "test-model", region: "cn", configured: true }],
    }));
    ipcMain.removeHandler("translate");
    globalThis.aiCalls = [];
    ipcMain.handle("translate", async (_event, id, input) => {
      globalThis.aiCalls.push({ id, input });
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        ok: true,
        value: { text: input.text, warnings: ["Synthetic quality check"], model: "test-model", promptVersion: "test" },
      };
    });
  });
  await page.locator("#workbench-back").click();
  await page.locator("#workbench-toggle").click();
  await page.locator("#workbench-translate-tab").click();
  await page.locator("#translate-provider option").waitFor({ state: "attached" });
  await page.locator("#translate-scope").selectOption("page");
  await page.locator("#translate-start").click();
  await page.waitForFunction(() => document.getElementById("translate-status").textContent.startsWith("已完成"));
  assert.equal(await page.locator(".translation-row").count(), 1);
  assert.equal(await page.locator(".quality-warning").count(), 1);
  const calls = await app.evaluate(() => globalThis.aiCalls.length);
  await page.locator("#translate-start").click();
  await page.waitForFunction(() => !document.getElementById("translate-start").disabled);
  assert.equal(await app.evaluate(() => globalThis.aiCalls.length), calls, "unchanged request uses saved chunk");
  await page.locator("#ai-task").selectOption("translate");
  await page.locator("#translate-start").click();
  await page.waitForFunction(() => !document.getElementById("translate-start").disabled);
  assert.equal(
    await app.evaluate(() => globalThis.aiCalls.length),
    calls + 1,
    "task change must invalidate cached result",
  );
  await page.locator("#translate-scope").selectOption("document");
  await page.locator("#translate-start").click();
  await page.locator("#translate-cancel").click();
  const rows = await page.locator(".translation-row").count();
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator(".translation-row").count(),
    rows,
    "late response after cancellation must not mutate UI",
  );
  if (process.env.MITOTO_CAPTURE === "1") await page.screenshot({ path: join(tmp, "workbench-ai.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: continuous pages, bounded canvases, scroll position, wheel turning, presets, AI tasks, cache isolation, cancellation and quality warnings.",
  );
} catch (error) {
  const page = await app.firstWindow();
  console.error(
    await page.evaluate(() => ({
      page: document.getElementById("page-number").value,
      mode: document.getElementById("reading-mode").value,
      pages: [...document.querySelectorAll(".pdf-page")]
        .filter((n) => n.querySelector("canvas"))
        .map((n) => ({ page: n.dataset.page, text: n.textContent })),
      status: document.getElementById("translate-status").textContent,
      message: document.getElementById("message").textContent,
    })),
  );
  if (process.env.MITOTO_CAPTURE === "1") await page.screenshot({ path: join(tmp, "workbench-failure.png") });
  throw error;
} finally {
  await app.close();
}
