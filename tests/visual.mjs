import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";

const root = resolve(import.meta.dirname, "..");
const build = resolve(root, "build");
const output = resolve(root, "tests/tmp");
await mkdir(output, { recursive: true });
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  const file = resolve(build, "." + new URL(request.url, "http://localhost").pathname);
  if (!file.startsWith(build + "/".replace("/", process.platform === "win32" ? "\\" : "/")))
    return response.writeHead(403).end();
  try {
    const data = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
try {
  for (const kind of process.env.MITOTO_VISUAL_KIND ? [process.env.MITOTO_VISUAL_KIND] : ["home", "pdf", "epub"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => console.error(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error") console.error(entry.text());
    });
    let doc = null;
    if (kind !== "home")
      doc = {
        id: "visual-sample",
        name: kind === "pdf" ? "A little space to read.pdf" : "日文竖排 · 阅读样本.epub",
        kind,
        bytes: [
          ...(await readFile(resolve(output, kind === "pdf" ? "reading.pdf" : "reader-fixtures/ja-vertical.epub"))),
        ],
        settings: {},
      };
    await page.addInitScript((doc) => {
      window.mitoto = {
        state: async () => ({
          library: [
            {
              id: "1",
              name: "雨の街.epub",
              title: "雨の街",
              author: "日本語の読書",
              kind: "epub",
              opened: 1,
              progress: 0.42,
            },
            {
              id: "2",
              name: "A little space to read.pdf",
              title: "A little space to read",
              author: "Reading collection",
              kind: "pdf",
              opened: 2,
              progress: 0.18,
            },
            { id: "3", name: "我的扫描笔记.png", title: "我的扫描笔记", kind: "png", progress: 0 },
          ],
          recent: [],
          books: {},
          theme: "light",
        }),
        initial: async () => (doc ? { ...doc, bytes: new Uint8Array(doc.bytes) } : null),
        settings: async () => {},
        theme: async () => {},
        open: async () => null,
        copy: async () => {},
        export: async () => false,
        metadata: async () => {},
        fullscreen: async () => {},
      };
    }, doc);
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.waitForFunction(() => document.getElementById("recent").children.length > 0);
    if (kind !== "home") {
      await page
        .waitForFunction(
          () =>
            document.getElementById("reading-status").textContent === "本地阅读" ||
            document.getElementById("document-title").textContent === "打开失败",
          null,
          { timeout: 15000 },
        )
        .catch(async (error) => {
          console.error(await page.locator("#reading-status").textContent());
          console.error(await page.locator("#message").textContent());
          throw error;
        });
      if ((await page.locator("#document-title").textContent()) === "打开失败")
        throw new Error(await page.locator("#message").textContent());
    }
    if (kind === "epub") await page.locator("#type-toggle").click();
    await page.screenshot({ path: resolve(output, `visual-${kind}.png`) });
    await page.setViewportSize({ width: 650, height: 520 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(output, `visual-${kind}-compact.png`) });
    await page.setViewportSize({ width: 1280, height: 860 });
    if (kind === "home") {
      await page.locator("#theme").click();
      await page.screenshot({ path: resolve(output, "visual-home-dark.png") });
    }
    await page.close();
  }
  console.log("Saved headless browser design snapshots (host bridge mocked; not desktop integration evidence).");
} finally {
  await browser.close();
  server.close();
}
