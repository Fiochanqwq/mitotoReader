import { createWorker } from "tesseract.js";
import { pageRange, rasterScale } from "./reader-utils.mjs";

// One reusable worker, one page at a time, bounded raster size and idle release.
export function ocrController({ host, document: getDocument, pdf: getPdf, page: getPage, message }) {
  const $ = (id) => document.getElementById(id);
  let worker,
    workerLanguage,
    initializing,
    token = 0,
    idle,
    crop,
    overlay,
    activeRender,
    busy = false;
  let activeLogger = () => {};
  const isActive = (ticket) => ticket === token;
  function uiBusy(value) {
    busy = value;
    $("ocr-start").disabled = value;
    $("ocr-all").disabled = value;
    $("ocr-cancel").hidden = !value;
    $("ocr-progress").hidden = !value;
    for (const id of [
      "ocr-language",
      "ocr-layout",
      "ocr-rotation",
      "ocr-pages",
      "ocr-contrast",
      "ocr-region",
      "ocr-region-clear",
    ])
      $(id).disabled = value || (id === "ocr-layout" && $("ocr-language").value === "jpn_vert");
  }
  async function releaseWorker() {
    clearTimeout(idle);
    const previous = worker;
    worker = null;
    workerLanguage = null;
    if (previous) await previous.terminate();
    if (initializing) await initializing.catch(() => {});
  }
  async function cancel() {
    token++;
    activeRender?.cancel();
    activeRender = null;
    activeLogger = () => {};
    await releaseWorker();
    uiBusy(false);
  }
  function clearCrop() {
    crop = null;
    overlay?.remove();
    overlay = null;
    $("ocr-region-clear").hidden = true;
    $("ocr-region-status").textContent = "默认识别整页；点击框选区域后在页面拖动。";
  }
  function selectCrop() {
    clearCrop();
    const viewport = $("viewport").querySelector(`.pdf-page[data-page="${getPage()}"]`) || $("viewport");
    if (!viewport.querySelector("canvas, img")) return;
    overlay = document.createElement("div");
    overlay.className = "crop-overlay";
    const box = document.createElement("div");
    box.className = "crop-box";
    box.hidden = true;
    overlay.append(box);
    viewport.append(overlay);
    let origin;
    const point = (event) => {
      const rect = overlay.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      };
    };
    overlay.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      origin = point(event);
      overlay.setPointerCapture(event.pointerId);
      box.hidden = false;
    };
    overlay.onpointermove = (event) => {
      if (!origin) return;
      const end = point(event);
      crop = {
        x: Math.min(origin.x, end.x),
        y: Math.min(origin.y, end.y),
        w: Math.abs(end.x - origin.x),
        h: Math.abs(end.y - origin.y),
      };
      Object.assign(box.style, {
        left: `${crop.x * 100}%`,
        top: `${crop.y * 100}%`,
        width: `${crop.w * 100}%`,
        height: `${crop.h * 100}%`,
      });
    };
    overlay.onpointerup = () => {
      origin = null;
      if (!crop || crop.w < 0.005 || crop.h < 0.005) return clearCrop();
      $("ocr-region-status").textContent = "已选择区域，可再次拖动调整；识别时会保持原页面显示。";
      $("ocr-region-clear").hidden = false;
    };
    overlay.onpointercancel = clearCrop;
    $("ocr-region-clear").hidden = false;
    $("ocr-region-status").textContent = "在页面上拖动选择文字区域，Esc 取消框选。";
  }
  async function inputImage(pageNumber, options, ticket) {
    const source = document.createElement("canvas");
    const pdf = getPdf();
    if (pdf) {
      const page = await pdf.getPage(pageNumber);
      if (!isActive(ticket)) return null;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: rasterScale(base.width, base.height, 200 / 72, 4_000_000) });
      source.width = Math.floor(viewport.width);
      source.height = Math.floor(viewport.height);
      const task = page.render({ canvasContext: source.getContext("2d"), viewport });
      activeRender = task;
      try {
        await task.promise;
      } finally {
        if (activeRender === task) activeRender = null;
      }
    } else {
      const image = $("viewport").querySelector("img");
      if (!image) throw new Error("请打开 PDF 或图片。");
      const scale = rasterScale(image.naturalWidth, image.naturalHeight, 1, 4_000_000);
      source.width = Math.floor(image.naturalWidth * scale);
      source.height = Math.floor(image.naturalHeight * scale);
      const context = source.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, source.width, source.height);
      context.drawImage(image, 0, 0, source.width, source.height);
    }
    if (!isActive(ticket)) {
      source.width = source.height = 0;
      return null;
    }
    const region = options.crop || { x: 0, y: 0, w: 1, h: 1 };
    const width = Math.max(1, Math.floor(source.width * region.w)),
      height = Math.max(1, Math.floor(source.height * region.h));
    const output = document.createElement("canvas"),
      rotate = options.rotation;
    output.width = rotate % 180 ? height : width;
    output.height = rotate % 180 ? width : height;
    const context = output.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, output.width, output.height);
    context.translate(output.width / 2, output.height / 2);
    context.rotate((rotate * Math.PI) / 180);
    context.filter = options.contrast ? "grayscale(1) contrast(1.5)" : "none";
    context.drawImage(
      source,
      source.width * region.x,
      source.height * region.y,
      width,
      height,
      -width / 2,
      -height / 2,
      width,
      height,
    );
    source.width = source.height = 0;
    const blob = await new Promise((resolve) => output.toBlob(resolve, "image/png"));
    output.width = output.height = 0;
    if (!blob) throw new Error("无法准备识别图像，请缩小区域。");
    return blob;
  }
  async function ensureWorker(language, ticket) {
    clearTimeout(idle);
    if (worker && workerLanguage === language) return worker;
    await releaseWorker();
    if (!isActive(ticket)) return null;
    const creation = createWorker(language, 1, {
      workerPath: new URL("./ocr/worker.min.js", location.href).href,
      corePath: new URL("./ocr/core/", location.href).href,
      langPath: new URL("./ocr/models/", location.href).href,
      gzip: false,
      workerBlobURL: false,
      logger: (event) => activeLogger(event),
    }).then(async (created) => {
      if (!isActive(ticket)) {
        await created.terminate();
        return null;
      }
      return created;
    });
    initializing = creation;
    let created;
    try {
      created = await creation;
    } finally {
      if (initializing === creation) initializing = null;
    }
    if (!created) return null;
    if (!isActive(ticket)) {
      await created.terminate();
      return null;
    }
    worker = created;
    workerLanguage = language;
    return worker;
  }
  async function start({ allPages = false } = {}) {
    if (busy || !getDocument()) return;
    const document = getDocument(),
      ticket = ++token;
    const input = $("ocr-input").value;
    if ((input === "pdf" && document.kind !== "pdf") || (input === "image" && !["png", "jpg", "jpeg"].includes(document.kind)) || input === "office")
      throw new Error("当前文件与指定输入类型不匹配；轻量 OCR 支持 PDF 与 PNG / JPEG，请调整工作台输入类型。");
    const pages =
      allPages && getPdf()
        ? Array.from({ length: getPdf().numPages }, (_, index) => index + 1)
        : pageRange(getPdf() ? $("ocr-pages").value : "", getPdf()?.numPages || 1, getPage());
    const options = {
      version: 2,
      language: $("ocr-language").value,
      layout: $("ocr-language").value === "jpn_vert" ? "5" : $("ocr-layout").value,
      rotation: Number($("ocr-rotation").value),
      contrast: $("ocr-contrast").checked,
      crop: !allPages && pages.length === 1 && pages[0] === getPage() ? crop : null,
    };
    clearTimeout(idle);
    uiBusy(true);
    $("ocr-progress").value = 0;
    $("ocr-result").value = "";
    let cached = 0;
    try {
      for (let index = 0; index < pages.length; index++) {
        const page = pages[index],
          key = JSON.stringify({ ...options, page });
        $("ocr-status").textContent = `第 ${page} 页 · ${index + 1}/${pages.length} · 准备识别…`;
        let text = await host.ocrCacheGet(document.id, key);
        if (!isActive(ticket)) return;
        if (text === null) {
          const input = await inputImage(page, options, ticket);
          if (!isActive(ticket) || !input) return;
          activeLogger = (event) => {
            if (!isActive(ticket)) return;
            $("ocr-progress").value = (index + (event.progress || 0)) / pages.length;
            $("ocr-status").textContent =
              `第 ${page} 页 · ${index + 1}/${pages.length} · ${event.status === "recognizing text" ? `识别 ${Math.round((event.progress || 0) * 100)}%` : "加载本地引擎…"}`;
          };
          const engine = await ensureWorker(options.language, ticket);
          if (!isActive(ticket) || !engine) return;
          await engine.setParameters({
            tessedit_pageseg_mode: options.layout,
            textord_tabfind_vertical_text: options.language === "jpn" ? "0" : "1",
          });
          if (!isActive(ticket)) return;
          const result = await engine.recognize(input);
          if (!isActive(ticket)) return;
          text = result.data.text;
          await host
            .ocrCacheSet(document.id, key, text)
            .catch((error) => message(`识别完成，缓存未写入：${error.message}`));
        } else cached++;
        if (!isActive(ticket)) return;
        $("ocr-result").value += pages.length > 1 ? `${index ? "\n\n" : ""}—— 第 ${page} 页 ——\n${text}` : text;
        $("ocr-progress").value = (index + 1) / pages.length;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      $("ocr-status").textContent = `已完成 · ${pages.length} 页${cached ? ` · ${cached} 页来自缓存` : ""}`;
    } catch (error) {
      if (isActive(ticket)) {
        $("ocr-status").textContent = `识别失败：${error.message}（已完成结果保留）`;
        await releaseWorker();
      }
    } finally {
      if (isActive(ticket)) {
        uiBusy(false);
        activeLogger = () => {};
        idle = setTimeout(() => void releaseWorker(), 90_000);
      }
    }
  }
  $("ocr-start").onclick = () => start().catch((error) => message(error.message));
  $("ocr-cancel").onclick = async () => {
    await cancel();
    $("ocr-status").textContent = "已取消识别。已完成结果保留。";
  };
  $("ocr-region").onclick = selectCrop;
  $("ocr-region-clear").onclick = clearCrop;
  $("ocr-language").onchange = () => {
    $("ocr-layout").disabled = $("ocr-language").value === "jpn_vert";
  };
  $("ocr-pages").oninput = () => {
    $("ocr-start").textContent = $("ocr-pages").value.trim() ? "开始批量识别" : "识别当前页";
  };
  return {
    start,
    selectCrop,
    cancel,
    clearCrop,
    hasCrop: () => !!overlay,
    hasSelectedRegion: () => !!crop,
    reset: async () => {
      await cancel();
      clearCrop();
      $("ocr-pages").value = "";
      $("ocr-start").textContent = "识别当前页";
      $("ocr-status").textContent = "选择语言后开始识别。";
    },
  };
}
