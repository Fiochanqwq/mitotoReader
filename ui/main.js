import "./style.css";
import ePub from "epubjs";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import { libraryView } from "./library.js";
import { ocrController } from "./ocr.js";
import { fitScale, rasterScale, snippets } from "./reader-utils.mjs";
import horizontalCss from "@readium/css/css/dist/cjk-horizontal/ReadiumCSS-after.css";
import verticalCss from "@readium/css/css/dist/cjk-vertical/ReadiumCSS-after.css";

const $ = (id) => document.getElementById(id);
const host = window.mitoto;
GlobalWorkerOptions.workerSrc = new URL("./pdf/pdf.worker.mjs", location.href).href;
let current, pdf, pdfLoadingTask, book, rendition, imageUrl;
let pageNumber = 1,
  zoom = 1,
  generation = 0,
  renderTask,
  textLayer;
let messageTimer,
  searchToken = 0,
  documentToken = 0,
  loadQueue = Promise.resolve(),
  resizeTimer;
let searchHighlight,
  resizing = false;
const textCache = new Map();
const panels = ["toc-panel", "type-panel", "ocr-panel", "search-panel", "bookmarks-panel"];
const library = libraryView(
  host,
  safe(async (id) => {
    try {
      await load(await host.open(id));
    } finally {
      await library.refresh();
    }
  }),
  message,
);
const ocr = ocrController({ host, document: () => current, pdf: () => pdf, page: () => pageNumber, message });
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
  await library.refresh();
}
async function dispose() {
  generation++;
  documentToken++;
  searchToken++;
  textCache.clear();
  clearTimeout(resizeTimer);
  await ocr.reset();
  renderTask?.cancel();
  textLayer?.cancel();
  await rendering.catch(() => {});
  rendition?.destroy();
  book?.destroy();
  if (pdfLoadingTask) await pdfLoadingTask.destroy();
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  pdf = pdfLoadingTask = book = rendition = imageUrl = null;
  $("viewport").replaceChildren();
  $("toc").replaceChildren();
  $("ocr-result").value = "";
  $("search-results").replaceChildren();
  $("search-query").value = "";
  searchHighlight = null;
}
function load(doc) {
  loadQueue = loadQueue.catch(() => {}).then(() => loadDocument(doc));
  return loadQueue;
}
async function loadDocument(doc) {
  if (!doc) return;
  await dispose();
  current = { ...doc, bytes: undefined };
  settings = { ...defaults, ...doc.settings };
  pageNumber = Math.max(1, Number(settings.page) || 1);
  zoom = Math.min(3, Math.max(0.05, Number(settings.zoom) || 1));
  settings.fit = ["page", "width", "manual"].includes(settings.fit) ? settings.fit : "page";
  settings.bookmarks = Array.isArray(settings.bookmarks) ? settings.bookmarks : [];
  $("fit-mode").value = settings.fit;
  $("search-toggle").disabled = !["epub", "pdf"].includes(doc.kind);
  $("ocr-pages-label").hidden = doc.kind !== "pdf";
  $("search-status").textContent = "搜索 PDF 文字层或 EPUB 正文；扫描页请使用 OCR。";
  $("search-cancel").hidden = true;
  $("reading-stage").style.padding = doc.kind === "epub" ? settings.margin + "px" : "24px";
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
  for (const id of panels) $(id).hidden = true;
  try {
    if (doc.kind === "pdf") await loadPdf(doc.bytes);
    else if (doc.kind === "epub") await loadEpub(doc.bytes);
    else await loadImage(doc.bytes, doc.kind);
    $("reading-status").textContent = "本地阅读";
    drawBookmarks();
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
  pdfLoadingTask = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    cMapUrl: new URL("./pdf/cmaps/", location.href).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("./pdf/standard_fonts/", location.href).href,
    wasmUrl: new URL("./pdf/wasm/", location.href).href,
  });
  pdf = await pdfLoadingTask.promise;
  pageNumber = Math.min(pageNumber, pdf.numPages);
  const metadata = await pdf.getMetadata().catch(() => null);
  await host.metadata(current.id, {
    title: metadata?.info?.Title || current.name,
    author: metadata?.info?.Author || "",
  });
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
function renderPdf(preserveScroll = false) {
  renderTask?.cancel();
  textLayer?.cancel();
  const token = ++generation;
  rendering = rendering
    .catch(() => {})
    .then(async () => {
      if (!pdf || token !== generation) return;
      const page = await pdf.getPage(pageNumber);
      if (token !== generation) return;
      const stage = $("reading-stage");
      const oldHeight = stage.scrollHeight,
        oldWidth = stage.scrollWidth;
      const scroll = { x: stage.scrollLeft / Math.max(1, oldWidth), y: stage.scrollTop / Math.max(1, oldHeight) };
      const base = page.getViewport({ scale: 1 });
      if (settings.fit !== "manual")
        zoom = fitScale(base.width, base.height, stage.clientWidth - 48, stage.clientHeight - 48, settings.fit);
      const viewport = page.getViewport({ scale: zoom });
      ocr.clearCrop();
      const canvas = document.createElement("canvas");
      const ratio = rasterScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
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
      if (token !== generation) return;
      if (searchHighlight)
        for (const span of layer.querySelectorAll("span")) {
          if (span.textContent.toLocaleLowerCase().includes(searchHighlight.toLocaleLowerCase()))
            span.classList.add("search-hit");
        }
      settings.progress = pageNumber / pdf.numPages;
      drawBookmarks();
      if (!current.cover) {
        const cover = thumbnail(canvas);
        current.cover = cover;
        void host.metadata(current.id, { cover }).catch((error) => message(error.message));
      }
      settings.page = pageNumber;
      settings.zoom = zoom;
      save();
      updatePages(pdf.numPages);
      stage.scrollTop = preserveScroll ? scroll.y * stage.scrollHeight : 0;
      stage.scrollLeft = preserveScroll ? scroll.x * stage.scrollWidth : 0;
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
  const cover = thumbnail(image);
  await host.metadata(current.id, { cover, title: current.name });
}
function renderImage() {
  const image = $("viewport").querySelector("img");
  if (!image) return;
  if (settings.fit !== "manual")
    zoom = fitScale(
      image.naturalWidth,
      image.naturalHeight,
      $("reading-stage").clientWidth - 48,
      $("reading-stage").clientHeight - 48,
      settings.fit,
    );
  ocr.clearCrop();
  settings.progress = 1;
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
  const metadata = book.packaging.metadata;
  await host.metadata(current.id, { title: metadata.title || current.name, author: metadata.creator || "" });
  try {
    const url = await book.coverUrl();
    if (url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      await host.metadata(current.id, { cover: thumbnail(image) });
    }
  } catch {
    /* Books without readable cover art keep their format cover. */
  }
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
    contents.document.addEventListener("keydown", (event) => onKeydown(event).catch((error) => message(error.message)));
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
    if (resizing) return;
    settings.cfi = location.start.cfi;
    const chapters = book.spine.spineItems.length;
    settings.progress = location.atEnd
      ? 1
      : Math.min(
          1,
          (location.start.index + (location.start.displayed.page - 1) / Math.max(1, location.start.displayed.total)) /
            Math.max(1, chapters),
        );
    drawBookmarks();
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
  if (rendition.manager?.isRendered()) scheduleResize();
}
async function turn(delta) {
  if (rendition) return delta > 0 ? rendition.next() : rendition.prev();
  if (!pdf) return;
  pageNumber = Math.max(1, Math.min(pdf.numPages, pageNumber + delta));
  await renderPdf();
}
async function changeZoom(delta) {
  if (rendition || !current) return;
  settings.fit = "manual";
  $("fit-mode").value = "manual";
  zoom = Math.min(3, Math.max(0.25, Math.round((zoom + delta) * 100) / 100));
  if (pdf) await renderPdf();
  else renderImage();
}
function thumbnail(source) {
  const canvas = document.createElement("canvas");
  const width = source.naturalWidth || source.width,
    height = source.naturalHeight || source.height;
  const scale = Math.min(180 / width, 240 / height, 1);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}
function scheduleResize() {
  clearTimeout(resizeTimer);
  const token = documentToken;
  resizeTimer = setTimeout(
    safe(async () => {
      if (!current || token !== documentToken) return;
      if (pdf) await renderPdf(true);
      else if (rendition?.manager?.isRendered()) {
        const target = rendition,
          cfi = settings.cfi;
        resizing = true;
        try {
          target.resize();
          if (cfi) await target.display(cfi);
        } finally {
          resizing = false;
        }
      } else if (imageUrl) renderImage();
    }),
    160,
  );
}
new ResizeObserver(scheduleResize).observe($("reading-stage"));
function openPanel(id) {
  const opening = $(id).hidden;
  for (const panel of panels) $(panel).hidden = true;
  $(id).hidden = !opening;
  scheduleResize();
  if (opening && id === "search-panel") $("search-query").focus();
}
function bookmarkKey() {
  return rendition ? settings.cfi : String(pageNumber);
}
function drawBookmarks() {
  const marks = settings.bookmarks || [];
  $("bookmark-add").textContent = marks.some((x) => x.key === bookmarkKey()) ? "★" : "☆";
  $("bookmark-add").setAttribute("aria-pressed", String(marks.some((x) => x.key === bookmarkKey())));
  $("bookmarks").replaceChildren();
  for (const mark of marks) {
    const row = document.createElement("div");
    row.className = "bookmark-row";
    const button = document.createElement("button");
    button.textContent = mark.label;
    button.onclick = safe(async () => {
      if (rendition) await rendition.display(mark.key);
      else if (pdf) {
        pageNumber = Number(mark.key);
        await renderPdf();
      }
    });
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.setAttribute("aria-label", "删除书签 " + mark.label);
    remove.onclick = () => {
      settings.bookmarks = marks.filter((x) => x !== mark);
      save();
      drawBookmarks();
    };
    row.append(button, remove);
    $("bookmarks").append(row);
  }
  if (!marks.length) $("bookmarks").textContent = "暂无书签，按 Ctrl+D 添加当前位置。";
}
function toggleBookmark() {
  if (!current || !bookmarkKey()) return;
  const key = bookmarkKey(),
    existing = settings.bookmarks.some((x) => x.key === key);
  if (existing) settings.bookmarks = settings.bookmarks.filter((x) => x.key !== key);
  else {
    if (settings.bookmarks.length >= 300) return message("每本书最多保存 300 个书签。");
    const chapter = rendition ? book.spine.get(key)?.href?.split("/").pop() || "章节" : "";
    settings.bookmarks.push({
      key,
      label: rendition
        ? chapter + " · " + Math.round((settings.progress || 0) * 100) + "%"
        : "第 " + pageNumber + " 页",
      created: Date.now(),
    });
  }
  save();
  drawBookmarks();
  message(existing ? "已移除书签" : "已添加书签");
}
async function search() {
  const query = $("search-query").value.trim();
  if (!query || (!pdf && !book)) return;
  if (query.length > 200) return message("搜索词请控制在 200 字以内。");
  const token = ++searchToken,
    sourcePdf = pdf,
    sourceBook = book;
  $("search-results").replaceChildren();
  $("search-cancel").hidden = false;
  let count = 0;
  const total = sourcePdf ? sourcePdf.numPages : sourceBook.spine.spineItems.length;
  const add = (label, excerpt, jump) => {
    const button = document.createElement("button");
    const title = document.createElement("strong");
    title.textContent = label;
    const text = document.createElement("span");
    text.textContent = excerpt;
    button.append(title, text);
    button.onclick = safe(jump);
    $("search-results").append(button);
    count++;
  };
  try {
    for (let index = 0; index < total && count < 200; index++) {
      if (token !== searchToken) return;
      $("search-status").textContent = "正在搜索 " + (index + 1) + "/" + total + " · 找到 " + count + " 处";
      if (sourcePdf) {
        let content = textCache.get(index);
        if (content === undefined) {
          const page = await sourcePdf.getPage(index + 1);
          content = (await page.getTextContent()).items.map((x) => (x.str || "") + (x.hasEOL ? "\n" : "")).join("");
          if (token !== searchToken) return;
          if (textCache.size >= 24) textCache.delete(textCache.keys().next().value);
          if (content.length < 200000) textCache.set(index, content);
        }
        for (const excerpt of snippets(content, query, 200 - count))
          add("第 " + (index + 1) + " 页", excerpt, async () => {
            if (pdf !== sourcePdf) return;
            pageNumber = index + 1;
            searchHighlight = query;
            await renderPdf();
          });
      } else {
        const section = sourceBook.spine.spineItems[index];
        // Search detached sections, so unloading never invalidates a rendered chapter.
        const xml = await sourceBook.load(section.href);
        if (token !== searchToken) return;
        const original = section.document,
          originalContents = section.contents;
        let matches;
        try {
          section.document = xml;
          section.contents = xml.documentElement;
          matches = section.find(query);
        } finally {
          section.document = original;
          section.contents = originalContents;
        }
        for (const match of matches.slice(0, 200 - count))
          add("第 " + (index + 1) + " 章", match.excerpt, async () => {
            if (book !== sourceBook) return;
            if (searchHighlight) rendition.annotations.remove(searchHighlight, "highlight");
            await rendition.display(match.cfi);
            searchHighlight = match.cfi;
            rendition.annotations.highlight(match.cfi, {}, null, "epub-search-hit", {
              fill: "#e2b63b",
              "fill-opacity": "0.35",
            });
          });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token === searchToken)
      $("search-status").textContent = count
        ? "找到 " + count + " 处" + (count >= 200 ? "（最多显示 200 处，请缩小关键词范围）" : "")
        : "未找到匹配；扫描 PDF 需要先使用 OCR。";
  } finally {
    if (token === searchToken) $("search-cancel").hidden = true;
  }
}
$("search-form").onsubmit = (event) => {
  event.preventDefault();
  void search().catch((error) => message(error.message));
};
$("search-cancel").onclick = () => {
  searchToken++;
  $("search-cancel").hidden = true;
  $("search-status").textContent = "搜索已停止，已找到的结果保留。";
};
$("bookmark-add").onclick = toggleBookmark;
$("fit-mode").onchange = safe(async () => {
  settings.fit = $("fit-mode").value;
  if (pdf) await renderPdf(true);
  else renderImage();
});
$("fullscreen").onclick = safe(() => host.fullscreen());
$("shortcuts-toggle").onclick = () => $("shortcuts").showModal();
$("shortcuts-close").onclick = () => $("shortcuts").close();

for (const id of ["open", "home-open"]) $(id).onclick = safe(async () => load(await host.open()));
$("home-button").onclick = safe(async () => {
  await loadQueue.catch(() => {});
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
  ["search-toggle", "search-panel"],
  ["bookmarks-toggle", "bookmarks-panel"],
  ["type-toggle", "type-panel"],
  ["ocr-toggle", "ocr-panel"],
]) {
  $(button).onclick = () => openPanel(panel);
}
document.querySelectorAll("[data-close]").forEach((button) => {
  button.onclick = () => {
    $(button.dataset.close).hidden = true;
    scheduleResize();
  };
});
$("focus-toggle").onclick = () => {
  document.querySelector(".reader-tools").hidden = true;
  $("restore-tools").hidden = false;
  scheduleResize();
};
$("restore-tools").onclick = () => {
  document.querySelector(".reader-tools").hidden = false;
  $("restore-tools").hidden = true;
  scheduleResize();
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

$("ocr-copy").onclick = safe(async () => {
  await host.copy($("ocr-result").value);
  message("已复制识别文字");
});
$("ocr-export").onclick = safe(async () => {
  if (!$("ocr-result").value.trim()) return message("还没有可导出的文字");
  if (await host.export($("ocr-result").value)) message("已导出 TXT");
});
async function onKeydown(event) {
  const key = event.key.toLowerCase(),
    modifier = event.ctrlKey || event.metaKey;
  const input = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
  if (key === "f11") {
    event.preventDefault();
    return host.fullscreen();
  }
  if (key === "escape") {
    event.preventDefault();
    if ($("shortcuts").open) return $("shortcuts").close();
    if (ocr.hasCrop()) return ocr.clearCrop();
    if (panels.some((id) => !$(id).hidden)) {
      for (const id of panels) $(id).hidden = true;
      scheduleResize();
      return;
    }
    return host.fullscreen(false);
  }
  if (modifier && key === "o") {
    event.preventDefault();
    return load(await host.open());
  }
  if (!current) return;
  if (modifier && key === "f" && (pdf || rendition)) {
    event.preventDefault();
    $("search-panel").hidden = true;
    openPanel("search-panel");
    return;
  }
  if (input) return;
  if (modifier && key === "d") {
    event.preventDefault();
    return toggleBookmark();
  }
  if (modifier && ["+", "=", "-", "0"].includes(key) && !rendition) {
    event.preventDefault();
    if (key === "0") {
      settings.fit = "page";
      $("fit-mode").value = "page";
      if (pdf) return renderPdf();
      return renderImage();
    }
    return changeZoom(key === "-" ? -0.1 : 0.1);
  }
  if (key === "pagedown" || key === "pageup") {
    event.preventDefault();
    return turn(key === "pagedown" ? 1 : -1);
  }
}
document.addEventListener("keydown", (event) => onKeydown(event).catch((error) => message(error.message)));

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
