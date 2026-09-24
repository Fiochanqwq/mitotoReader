import "./style.css";
import ePub from "epubjs";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import { createWorker } from "tesseract.js";
import horizontalCss from "@readium/css/css/dist/cjk-horizontal/ReadiumCSS-after.css";
import verticalCss from "@readium/css/css/dist/cjk-vertical/ReadiumCSS-after.css";

const $ = (id) => document.getElementById(id);
const host = window.mitoto;
GlobalWorkerOptions.workerSrc = new URL("./pdf/pdf.worker.mjs", location.href).href;
let current, pdf, book, rendition, imageUrl;
let pageNumber = 1,
  zoom = 1,
  generation = 0,
  renderTask,
  textLayer;
let ocrWorker,
  ocrGeneration = 0,
  messageTimer;
let rendering = Promise.resolve();
let settings = {};
const defaults = { mode: "publisher", font: "'Yu Mincho', 'SimSun', serif", size: 110, line: 1.8, margin: 32 };

function message(text) {
  $("message").textContent = text;
  $("message").hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    $("message").hidden = true;
  }, 6000);
}
function safe(action) {
  return (...args) =>
    Promise.resolve()
      .then(() => action(...args))
      .catch((error) => message(error.message));
}
function save() {
  if (current) host.settings(current.id, { ...settings }).catch((error) => message(error.message));
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  host.theme(theme).catch((error) => message(error.message));
  applyType();
}
async function showRecent() {
  const state = await host.state();
  $("recent").replaceChildren();
  if (!state.recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有阅读记录。打开文件，开始你的第一本书。";
    $("recent").append(empty);
  }
  for (const entry of state.recent.slice(0, 6)) {
    const button = document.createElement("button");
    button.className = "recent-card";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = entry.kind.toUpperCase();
    const info = document.createElement("span");
    info.className = "recent-info";
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = entry.name;
    const date = document.createElement("span");
    date.className = "recent-date";
    date.textContent = new Date(entry.opened).toLocaleDateString("zh-CN") + " · 继续阅读";
    info.append(name, date);
    button.append(icon, info);
    button.title = entry.name;
    button.onclick = safe(async () => load(await host.open(entry.id)));
    $("recent").append(button);
  }
}

async function cancelOcr() {
  ocrGeneration++;
  const worker = ocrWorker;
  ocrWorker = null;
  if (worker) await worker.terminate();
  $("ocr-start").disabled = false;
  $("ocr-cancel").hidden = true;
  $("ocr-progress").hidden = true;
}
async function dispose() {
  generation++;
  await cancelOcr();
  renderTask?.cancel();
  textLayer?.cancel();
  await rendering.catch(() => {});
  rendition?.destroy();
  book?.destroy();
  if (pdf) await pdf.destroy();
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  pdf = book = rendition = imageUrl = null;
  $("viewport").replaceChildren();
  $("toc").replaceChildren();
  $("ocr-result").value = "";
}
async function load(doc) {
  if (!doc) return;
  await dispose();
  current = doc;
  settings = { ...defaults, ...doc.settings };
  pageNumber = Math.max(1, Number(settings.page) || 1);
  zoom = Number(settings.zoom) || 1;
  $("home").hidden = true;
  $("reader").hidden = false;
  $("document-title").textContent = doc.name;
  $("kind-label").textContent = doc.kind.toUpperCase();
  $("reading-status").textContent = "正在打开…";
  $("viewport").className = doc.kind;
  $("page-number").disabled = doc.kind !== "pdf";
  $("zoom-tools").hidden = doc.kind === "epub";
  $("type-toggle").disabled = doc.kind !== "epub";
  $("ocr-toggle").disabled = doc.kind === "epub";
  $("toc-toggle").disabled = doc.kind !== "epub" && doc.kind !== "pdf";
  for (const id of ["type-panel", "ocr-panel", "toc-panel"]) $(id).hidden = true;
  try {
    if (doc.kind === "pdf") await loadPdf(doc.bytes);
    else if (doc.kind === "epub") await loadEpub(doc.bytes);
    else await loadImage(doc.bytes, doc.kind);
    $("reading-status").textContent = "本地阅读";
  } catch (error) {
    await dispose();
    current = null;
    $("reader").hidden = true;
    $("home").hidden = false;
    $("document-title").textContent = "打开失败";
    throw error;
  }
}

async function loadPdf(bytes) {
  pdf = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    cMapUrl: new URL("./pdf/cmaps/", location.href).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./pdf/standard_fonts/", location.href).href,
    wasmUrl: new URL("./pdf/wasm/", location.href).href,
  }).promise;
  pageNumber = Math.min(pageNumber, pdf.numPages);
  const outline = await pdf.getOutline();
  async function jump(dest) {
    const target = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!target) return;
    pageNumber = typeof target[0] === "number" ? target[0] + 1 : (await pdf.getPageIndex(target[0])) + 1;
    await renderPdf();
  }
  appendToc(
    outline || [],
    (item) => item.title,
    (item) => item.items,
    (item) => jump(item.dest),
  );
  await renderPdf();
}
function renderPdf() {
  renderTask?.cancel();
  textLayer?.cancel();
  const token = ++generation;
  rendering = rendering
    .catch(() => {})
    .then(async () => {
      if (!pdf || token !== generation) return;
      const page = await pdf.getPage(pageNumber);
      if (token !== generation) return;
      const viewport = page.getViewport({ scale: zoom });
      const canvas = document.createElement("canvas");
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const layer = document.createElement("div");
      layer.className = "textLayer";
      $("viewport").style.width = `${viewport.width}px`;
      $("viewport").style.height = `${viewport.height}px`;
      $("viewport").style.setProperty("--scale-factor", String(zoom));
      $("viewport").style.setProperty("--total-scale-factor", String(zoom));
      $("viewport").replaceChildren(canvas, layer);
      renderTask = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      try {
        await renderTask.promise;
      } catch (error) {
        if (error.name === "RenderingCancelledException") return;
        throw error;
      }
      if (token !== generation) return;
      textLayer = new TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
      await textLayer.render();
      settings.page = pageNumber;
      settings.zoom = zoom;
      save();
      updatePages(pdf.numPages);
      $("reading-stage").scrollTop = 0;
    });
  return rendering;
}

async function loadImage(bytes, kind) {
  imageUrl = URL.createObjectURL(new Blob([bytes], { type: kind === "png" ? "image/png" : "image/jpeg" }));
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  $("viewport").replaceChildren(image);
  renderImage();
}
function renderImage() {
  const image = $("viewport").querySelector("img");
  if (!image) return;
  image.style.width = `${image.naturalWidth * zoom}px`;
  $("viewport").style.width = "auto";
  $("viewport").style.height = "auto";
  pageNumber = 1;
  updatePages(1);
  settings.zoom = zoom;
  save();
}
function updatePages(total) {
  $("page-number").value = String(pageNumber);
  $("page-number").max = String(total);
  $("page-total").textContent = `/ ${total}`;
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  $("previous").disabled = pageNumber <= 1;
  $("next").disabled = pageNumber >= total;
}
function appendToc(items, label, children, action, depth = 0) {
  if (!items.length && !depth) $("toc").textContent = "这份文档没有目录。";
  for (const item of items) {
    const button = document.createElement("button");
    button.textContent = label(item);
    button.style.paddingLeft = `${5 + depth * 12}px`;
    button.onclick = safe(() => action(item));
    $("toc").append(button);
    if (children(item)?.length) appendToc(children(item), label, children, action, depth + 1);
  }
}
async function loadEpub(bytes) {
  $("reading-status").textContent = "正在解析电子书…";
  $("viewport").style.width = "100%";
  $("viewport").style.height = "100%";
  book = ePub();
  await book.open(new Uint8Array(bytes).buffer);
  $("reading-status").textContent = "正在准备排版…";
  rendition = book.renderTo("viewport", {
    width: "100%",
    height: "100%",
    flow: "paginated",
    spread: "none",
    allowScriptedContent: false,
  });
  await rendition.started;
  $("reading-status").textContent = "正在载入目录…";
  rendition.themes.registerCss("horizontal", horizontalCss);
  rendition.themes.registerCss("vertical", verticalCss);
  rendition.hooks.content.register((contents) => {
    contents.document.addEventListener(
      "click",
      (event) => {
        const link = event.target.closest?.("a");
        if (link && /^(https?:|javascript:|file:|mailto:)/i.test(link.getAttribute("href") || "")) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  });
  $("writing-mode").value = settings.mode;
  $("font-family").value = settings.font;
  $("font-size").value = settings.size;
  $("line-spacing").value = settings.line;
  $("page-margin").value = settings.margin;
  applyType();
  rendition.on("relocated", (location) => {
    settings.cfi = location.start.cfi;
    save();
    $("page-number").value = String(location.start.displayed.page);
    $("page-total").textContent = `/ ${location.start.displayed.total} · 本章`;
    $("previous").disabled = location.atStart;
    $("next").disabled = location.atEnd;
  });
  const navigation = await book.loaded.navigation;
  appendToc(
    navigation.toc,
    (item) => item.label,
    (item) => item.subitems,
    (item) => rendition.display(item.href),
  );
  $("reading-status").textContent = "正在显示章节…";
  try {
    await rendition.display(settings.cfi || undefined);
  } catch {
    await rendition.display();
  }
}
function applyType() {
  $("font-value").textContent = `${settings.size || defaults.size}%`;
  $("line-value").textContent = settings.line || defaults.line;
  $("margin-value").textContent = `${settings.margin || defaults.margin} px`;
  if (!rendition) return;
  const rtl = book.packaging.metadata.direction === "rtl";
  const vertical =
    settings.mode === "vertical" ||
    (settings.mode === "publisher" && rtl && book.packaging.metadata.language?.startsWith("ja"));
  rendition.themes.select(vertical ? "vertical" : "horizontal");
  rendition.themes.font(settings.font);
  rendition.themes.fontSize(`${settings.size}%`);
  rendition.themes.override("line-height", String(settings.line), true);
  rendition.themes.override(
    "writing-mode",
    settings.mode === "publisher" ? "" : vertical ? "vertical-rl" : "horizontal-tb",
    true,
  );
  const css = getComputedStyle(document.documentElement);
  rendition.themes.override("color", css.getPropertyValue("--text"), true);
  rendition.themes.override("background-color", css.getPropertyValue("--surface"), true);
  rendition.direction(settings.mode === "publisher" ? (rtl ? "rtl" : "ltr") : vertical ? "rtl" : "ltr");
  $("reading-stage").style.padding = `${settings.margin}px`;
  if (rendition.manager?.isRendered()) rendition.resize();
}
async function turn(delta) {
  if (rendition) return delta > 0 ? rendition.next() : rendition.prev();
  if (!pdf) return;
  pageNumber = Math.max(1, Math.min(pdf.numPages, pageNumber + delta));
  await renderPdf();
}
async function changeZoom(delta) {
  zoom = Math.min(3, Math.max(0.25, Math.round((zoom + delta) * 100) / 100));
  if (pdf) await renderPdf();
  else renderImage();
}
async function ocrImage() {
  const canvas = document.createElement("canvas");
  if (pdf) {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / 72, Math.sqrt(16_000_000 / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  } else {
    const image = $("viewport").querySelector("img");
    if (!image) throw new Error("请打开 PDF 或图片。");
    const scale = Math.min(1, Math.sqrt(16_000_000 / (image.naturalWidth * image.naturalHeight)));
    canvas.width = Math.ceil(image.naturalWidth * scale);
    canvas.height = Math.ceil(image.naturalHeight * scale);
    canvas.getContext("2d").fillStyle = "white";
    canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  return canvas.toDataURL("image/png");
}
async function startOcr() {
  if (!current || rendition) return;
  await cancelOcr();
  const token = ocrGeneration;
  const sourceName = current.name,
    sourcePage = pageNumber;
  $("ocr-start").disabled = true;
  $("ocr-cancel").hidden = false;
  $("ocr-progress").hidden = false;
  $("ocr-progress").value = 0;
  $("ocr-status").textContent = "准备当前页…";
  try {
    const input = await ocrImage();
    if (token !== ocrGeneration) return;
    const worker = await createWorker($("ocr-language").value, 1, {
      workerPath: new URL("./ocr/worker.min.js", location.href).href,
      corePath: new URL("./ocr/core/", location.href).href,
      langPath: new URL("./ocr/models/", location.href).href,
      gzip: false,
      workerBlobURL: false,
      logger: (event) => {
        if (token !== ocrGeneration) return;
        $("ocr-progress").value = event.progress || 0;
        $("ocr-status").textContent =
          event.status === "recognizing text"
            ? `正在识别 · ${Math.round((event.progress || 0) * 100)}%`
            : "正在加载本地识别引擎…";
      },
    });
    if (token !== ocrGeneration) {
      await worker.terminate();
      return;
    }
    ocrWorker = worker;
    await worker.setParameters({
      tessedit_pageseg_mode: $("ocr-language").value === "jpn_vert" ? "5" : $("ocr-layout").value,
      textord_tabfind_vertical_text: $("ocr-language").value === "jpn" ? "0" : "1",
    });
    const result = await worker.recognize(input);
    if (token !== ocrGeneration) return;
    $("ocr-result").value = result.data.text;
    $("ocr-status").textContent = `${sourceName} · 第 ${sourcePage} 页 · 已完成`;
  } catch (error) {
    if (token === ocrGeneration) $("ocr-status").textContent = `识别失败：${error.message}`;
  } finally {
    if (token === ocrGeneration) await cancelOcr();
  }
}

for (const id of ["open", "home-open"]) $(id).onclick = safe(async () => load(await host.open()));
$("home-button").onclick = safe(async () => {
  await dispose();
  current = null;
  $("reader").hidden = true;
  $("home").hidden = false;
  $("document-title").textContent = "你的下一页，从这里开始。";
  await showRecent();
});
$("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
for (const [button, panel] of [
  ["toc-toggle", "toc-panel"],
  ["type-toggle", "type-panel"],
  ["ocr-toggle", "ocr-panel"],
]) {
  $(button).onclick = () => {
    const open = $(panel).hidden;
    for (const id of ["toc-panel", "type-panel", "ocr-panel"]) $(id).hidden = true;
    $(panel).hidden = !open;
    rendition?.resize();
  };
}
document.querySelectorAll("[data-close]").forEach((button) => {
  button.onclick = () => {
    $(button.dataset.close).hidden = true;
    rendition?.resize();
  };
});
$("focus-toggle").onclick = () => {
  document.querySelector(".reader-tools").hidden = true;
  $("restore-tools").hidden = false;
  rendition?.resize();
};
$("restore-tools").onclick = () => {
  document.querySelector(".reader-tools").hidden = false;
  $("restore-tools").hidden = true;
  rendition?.resize();
};
$("previous").onclick = safe(() => turn(-1));
$("next").onclick = safe(() => turn(1));
$("page-number").onchange = safe(async () => {
  if (!pdf) return;
  pageNumber = Math.max(1, Math.min(pdf.numPages, Number($("page-number").value) || 1));
  await renderPdf();
});
$("zoom-out").onclick = safe(() => changeZoom(-0.1));
$("zoom-in").onclick = safe(() => changeZoom(0.1));
for (const [id, key, numeric] of [
  ["writing-mode", "mode"],
  ["font-family", "font"],
  ["font-size", "size", true],
  ["line-spacing", "line", true],
  ["page-margin", "margin", true],
]) {
  $(id).onchange = () => {
    settings[key] = numeric ? Number($(id).value) : $(id).value;
    applyType();
    save();
  };
}
$("ocr-start").onclick = safe(startOcr);
$("ocr-language").onchange = () => {
  $("ocr-layout").disabled = $("ocr-language").value === "jpn_vert";
};
$("ocr-cancel").onclick = safe(async () => {
  await cancelOcr();
  $("ocr-status").textContent = "已取消识别。";
});
$("ocr-copy").onclick = safe(async () => {
  await host.copy($("ocr-result").value);
  message("已复制识别文字");
});
$("ocr-export").onclick = safe(async () => {
  if (!$("ocr-result").value.trim()) return message("还没有可导出的文字");
  if (await host.export($("ocr-result").value)) message("已导出 TXT");
});
document.addEventListener(
  "keydown",
  safe(async (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      return load(await host.open());
    }
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || !current) return;
    if (event.key === "PageDown") {
      event.preventDefault();
      await turn(1);
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      await turn(-1);
    }
    if (event.key === "Escape") for (const id of ["type-panel", "ocr-panel", "toc-panel"]) $(id).hidden = true;
  }),
);
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  message(event.reason?.message || "操作失败，请重新打开文档");
});
await safe(async () => {
  const state = await host.state();
  document.documentElement.dataset.theme = state.theme === "dark" ? "dark" : "light";
  await showRecent();
  await load(await host.initial());
})();
