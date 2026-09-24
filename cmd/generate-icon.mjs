import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const browser = await chromium.launch({
  executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>body{margin:0;background:transparent}</style>${await readFile(resolve(root, "resources/icon.svg"), "utf8")}`,
  );
  const png = await page.screenshot({ omitBackground: true });
  await writeFile(resolve(root, "resources/icon.png"), png);
  // ICO directory: one 256px, 32-bit PNG image starting after the 22-byte header.
  const header = Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
  header.writeUInt32LE(png.length, 14);
  await writeFile(resolve(root, "resources/icon.ico"), Buffer.concat([header, png]));
} finally {
  await browser.close();
}
