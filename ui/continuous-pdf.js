import { TextLayer } from "pdfjs-dist";
import { rasterScale } from "./reader-utils.mjs";

// Placeholders retain scroll extent; only a five-page neighborhood owns canvases.
export function continuousPdf({ stage, viewport, changed, message, decorated }) {
  let document = null,
    scale = 1,
    epoch = 0,
    timer,
    nodes = [],
    active = new Map(),
    current = 1;
  function destroy() {
    epoch++;
    clearTimeout(timer);
    for (const entry of active.values()) {
      entry.task?.cancel();
      entry.layer?.cancel();
    }
    active.clear();
    nodes = [];
    document = null;
    viewport.classList.remove("pdf-continuous");
  }
  async function paint(index) {
    if (active.has(index) || !document) return;
    const ticket = epoch,
      source = document,
      node = nodes[index],
      entry = {};
    active.set(index, entry);
    const valid = () => ticket === epoch && active.get(index) === entry;
    try {
      const page = await source.getPage(index + 1);
      if (!valid()) return;
      const view = page.getViewport({ scale });
      node.style.width = `${view.width}px`;
      node.style.height = `${view.height}px`;
      const canvas = window.document.createElement("canvas");
      const ratio = rasterScale(view.width, view.height, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(view.width * ratio));
      canvas.height = Math.max(1, Math.floor(view.height * ratio));
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
      const layer = window.document.createElement("div");
      layer.className = "textLayer";
      node.replaceChildren(canvas, layer);
      entry.task = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: view,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await entry.task.promise;
      if (!valid()) return;
      const content = await page.getTextContent();
      if (!valid()) return;
      entry.layer = new TextLayer({ textContentSource: content, container: layer, viewport: view });
      await entry.layer.render();
      if (valid()) decorated();
    } catch (error) {
      if (valid() && error.name !== "RenderingCancelledException" && error.name !== "AbortException") {
        node.textContent = `第 ${index + 1} 页显示失败：${error.message}`;
        message(error.message);
      }
    }
  }
  function update() {
    if (!document || !nodes.length || !stage.clientHeight) return;
    const bounds = stage.getBoundingClientRect(),
      center = bounds.top + Math.min(bounds.height * 0.35, 200);
    let nearest = 0,
      distance = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const rect = nodes[i].getBoundingClientRect();
      const gap = center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
      if (gap < distance) {
        nearest = i;
        distance = gap;
      }
    }
    for (const [index, entry] of active)
      if (Math.abs(index - nearest) > 2) {
        entry.task?.cancel();
        entry.layer?.cancel();
        nodes[index].replaceChildren();
        active.delete(index);
      }
    for (let i = Math.max(0, nearest - 2); i <= Math.min(nodes.length - 1, nearest + 2); i++) void paint(i);
    if (current !== nearest + 1) {
      current = nearest + 1;
      changed(current);
    }
  }
  stage.addEventListener(
    "scroll",
    () => {
      clearTimeout(timer);
      timer = setTimeout(update, 60);
    },
    { passive: true },
  );
  return {
    destroy,
    async show(pdf, zoom, page, preserve = false) {
      if (document !== pdf || scale !== zoom) {
        const offset = nodes[current - 1]
          ? (stage.scrollTop - nodes[current - 1].offsetTop) / Math.max(1, nodes[current - 1].offsetHeight)
          : 0;
        destroy();
        document = pdf;
        scale = zoom;
        current = page;
        const ticket = epoch,
          first = await pdf.getPage(1);
        if (ticket !== epoch) return;
        const base = first.getViewport({ scale });
        viewport.replaceChildren();
        viewport.classList.add("pdf-continuous");
        viewport.style.width = "max-content";
        viewport.style.height = "auto";
        viewport.style.setProperty("--scale-factor", String(scale));
        viewport.style.setProperty("--total-scale-factor", String(scale));
        nodes = Array.from({ length: pdf.numPages }, (_, index) => {
          const node = window.document.createElement("div");
          node.className = "pdf-page";
          node.dataset.page = index + 1;
          node.setAttribute("aria-label", `第 ${index + 1} 页`);
          node.style.width = `${base.width}px`;
          node.style.height = `${base.height}px`;
          viewport.append(node);
          return node;
        });
        await paint(page - 1);
        if (ticket !== epoch) return;
        stage.scrollTop = nodes[page - 1].offsetTop + (preserve ? offset * nodes[page - 1].offsetHeight : 0);
      } else if (!preserve) stage.scrollTop = nodes[page - 1].offsetTop;
      current = page;
      update();
    },
  };
}
