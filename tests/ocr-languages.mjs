import { chromium, _electron as electron } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const tmp = join(root, "tests/tmp");
await mkdir(tmp, { recursive: true });
const samples = [
  { lang: "eng", text: "Offline reading with mitoto Reader", extension: "jpg" },
  { lang: "chi_sim+eng", text: "离线阅读 文字识别 测试成功", extension: "png" },
  { lang: "chi_tra+eng", text: "離線閱讀 文字識別 測試成功", extension: "png" },
  { lang: "jpn", text: "日本語の文章を読みます", extension: "png" },
  { lang: "jpn_vert", text: "日本語の縦書き", extension: "png", vertical: true },
];
const browser = await chromium.launch({
  executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  for (const [index, sample] of samples.entries()) {
    sample.file = join(tmp, `ocr-${index}.${sample.extension}`);
    await page.setContent(
      `<main style="background:white;color:black;padding:64px;font:52px/1.9 'Microsoft YaHei','Yu Mincho',sans-serif;writing-mode:${sample.vertical ? "vertical-rl" : "horizontal-tb"};width:${sample.vertical ? "220" : "1200"}px;height:${sample.vertical ? "750" : "140"}px">${sample.text}</main>`,
    );
    await page.locator("main").screenshot({ path: sample.file });
  }
} finally {
  await browser.close();
}

function normalized(text) {
  return text.replace(/[\s\p{P}]/gu, "").toLowerCase();
}
function similarity(expected, actual) {
  expected = normalized(expected);
  actual = normalized(actual);
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let row = 1; row <= expected.length; row++) {
    const current = [row];
    for (let col = 1; col <= actual.length; col++)
      current[col] = Math.min(
        current[col - 1] + 1,
        previous[col] + 1,
        previous[col - 1] + (expected[row - 1] === actual[col - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - previous[actual.length] / Math.max(expected.length, actual.length, 1);
}
const app = await electron.launch({
  executablePath: process.env.MITOTO_TEST_EXE || join(root, "node_modules/electron/dist/electron.exe"),
  args: process.env.MITOTO_TEST_EXE ? [] : [root],
  env: {
    ...process.env,
    MITOTO_TEST_MODE: "1",
    MITOTO_TEST_PROFILE: join(tmp, `ocr-profile-${Date.now()}`),
    MITOTO_TEST_FILE: "",
  },
});
const results = [];
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById("recent")?.children.length);
  for (const sample of samples) {
    if (process.env.MITOTO_OCR_LANGUAGE && sample.lang !== process.env.MITOTO_OCR_LANGUAGE) continue;
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, sample.file);
    await page.locator("#open").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#viewport img")?.complete &&
        document.getElementById("reading-status").textContent === "本地阅读",
    );
    await page.locator("#zoom-in").click();
    await page.locator("#ocr-toggle").click();
    await page.locator("#ocr-language").selectOption(sample.lang);
    if (!sample.vertical) await page.locator("#ocr-layout").selectOption("7");
    await page.locator("#ocr-start").click();
    await page.waitForFunction(() => /已完成|识别失败/.test(document.getElementById("ocr-status").textContent), null, {
      timeout: 120000,
    });
    const actual = await page.locator("#ocr-result").inputValue();
    const score = similarity(sample.text, actual);
    results.push({ language: sample.lang, expected: sample.text, actual, similarity: score });
    console.log(`${sample.lang}: ${(score * 100).toFixed(1)}% normalized similarity`);
    assert.ok(score >= 0.8, `${sample.lang} OCR below simple sample threshold: ${actual}`);
  }
  console.log(`PASS: image opening, zoom, and ${results.length} offline OCR language modes. Synthetic samples only.`);
} finally {
  await writeFile(
    join(tmp, `ocr-language-results-${process.env.MITOTO_OCR_LANGUAGE || "all"}.json`),
    JSON.stringify(results, null, 2),
  );
  await app.close();
}
