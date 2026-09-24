import { splitText } from "./ai-utils.mjs";
import { workbenchSettings } from "./workbench-settings.js";
import { PROMPT_VERSION } from "../app/prompts.cjs";
export function workbenchController({ host, current, pdf, book, pages, pageNumber, selectedText, message, readSettings, writeSettings }) {
  const $ = (id) => document.getElementById(id);
  const tabs = ["ocr", "translate", "api"];
  let providers = [],
    selectedProvider = "deepseek",
    engine = null,
    jobId = null,
    translationToken = 0;
  let results = [];
  let requestId = null, restoredDocument = null;
  const config = workbenchSettings({ read: readSettings, write: writeSettings, message });
  const taskName = () => ({ translate: "翻译", correct: "校正", structure: "整理" })[$("ai-task").value];
  function updateTask() {
    $("translate-target").disabled = $("ai-task").value !== "translate";
    $("translate-start").textContent = `开始${taskName()}`;
    $("ai-task-hint").textContent = $("ai-task").value === "translate" ? "保留术语、证据强度、公式与引文；不总结、不补写。" : "保留原语言与原始信息；不确定处标记待核对，原始 OCR 结果保持可用。";
  }
  $("ai-task").addEventListener("change", () => { updateTask(); void loadResults().catch(error => message(error.message)); });
  $("ocr-ai").onclick = () => { tab("translate"); $("ai-task").value = "correct"; $("translate-scope").value = $("engine-result").value.trim() ? "parser" : "ocr"; updateTask(); config.save(); void loadResults().catch(error => message(error.message)); };
  const cacheTarget = () => $("ai-task").value === "translate" ? $("translate-target").value : `ai-${$("ai-task").value}`;
  const signature = () => JSON.stringify({ version: PROMPT_VERSION, model: providers.find(x => x.id === $("translate-provider").value)?.model, region: providers.find(x => x.id === $("translate-provider").value)?.region, task: $("ai-task").value, target: cacheTarget(), profile: config.profile(), size: $("ai-chunk-size").value });
  function busy(value) {
    $("translate-start").disabled = value;
    $("translate-cancel").hidden = !value;
    $("translate-progress").hidden = !value;
    for (const id of ["ai-task", "translate-provider", "translate-scope", "ai-glossary", "ai-custom", "ai-chunk-size"]) $(id).disabled = value;
    $("translate-target").disabled = value || $("ai-task").value !== "translate";
  }
  function tab(name) {
    for (const item of tabs) {
      $(`workbench-${item}-view`).hidden = item !== name;
      $(`workbench-${item}-tab`).setAttribute("aria-current", item === name ? "page" : "false");
    }
  }
  for (const name of tabs) $(`workbench-${name}-tab`).onclick = () => tab(name);
  async function refreshProviders() {
    providers = await host.providerList();
    $("provider-cards").replaceChildren();
    $("translate-provider").replaceChildren();
    for (const provider of providers) {
      const button = document.createElement("button");
      const status = document.createElement("span");
      button.textContent = provider.name;
      status.textContent = provider.configured ? "已配置" : "未配置";
      button.append(status);
      button.onclick = () => selectProvider(provider.id);
      button.dataset.provider = provider.id;
      $("provider-cards").append(button);
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = `${provider.name}${provider.configured ? " ✓" : ""}`;
      $("translate-provider").append(option);
    }
    if (!providers.some((item) => item.id === selectedProvider)) selectedProvider = providers[0]?.id;
    selectProvider(selectedProvider);
  }
  function selectProvider(id) {
    const provider = providers.find((item) => item.id === id);
    if (!provider) return;
    selectedProvider = id;
    $("provider-title").textContent = provider.name;
    $("provider-model").value = provider.model;
    $("provider-region").value = provider.region;
    $("provider-region-label").hidden = !["qwen", "kimi"].includes(id);
    $("provider-key").value = "";
    $("provider-key").placeholder = provider.configured ? "已配置，留空保持原密钥" : "粘贴 API Key";
    $("provider-status").textContent = provider.configured ? "密钥已加密保存在本机。" : "尚未配置密钥。";
    $("translate-provider").value = id;
    for (const button of $("provider-cards").children)
      button.setAttribute("aria-pressed", String(button.dataset.provider === id));
  }
  $("provider-save").onclick = async () => {
    try {
      await host.providerSave(selectedProvider, {
        key: $("provider-key").value,
        model: $("provider-model").value,
        region: $("provider-region").value,
      });
      await refreshProviders();
      $("provider-status").textContent = "已保存。可以点击“验证连接”。";
    } catch (error) {
      $("provider-status").textContent = error.message;
    }
  };
  $("provider-verify").onclick = async () => {
    $("provider-status").textContent = "正在验证官方接口…";
    try {
      await host.providerVerify(selectedProvider);
      $("provider-status").textContent = "连接成功。";
    } catch (error) {
      $("provider-status").textContent = `连接失败：${error.message}`;
    }
  };
  $("provider-remove").onclick = async () => {
    try {
      await host.providerRemove(selectedProvider);
      await refreshProviders();
      $("provider-status").textContent = "已移除密钥。";
    } catch (error) {
      $("provider-status").textContent = error.message;
    }
  };
  async function pageText(index) {
    if (pages())
      return pages()
        [index - 1].paragraphs.map((x) => x.text)
        .join("\n");
    if (pdf()) return (await (await pdf().getPage(index)).getTextContent()).items.map((x) => (x.str || "") + (x.hasEOL ? "\n" : " ")).join("");
    if (book()) {
      const section = book().spine.spineItems[index - 1];
      const xml = await book().load(section.href);
      const copy = xml.documentElement?.cloneNode(true);
      copy?.querySelectorAll("script,style,head").forEach(node => node.remove());
      return copy?.textContent || "";
    }
    return $("ocr-result").value.trim();
  }
  async function sourceChunks(scope) {
    const chunk = (value, label) => splitText(value, Number($("ai-chunk-size").value)).map((part, i) => ({ ...part, label: `${label} · ${i + 1}` }));
    if (scope === "selection") {
      const value = selectedText();
      if (!value) throw new Error("请先在阅读页面选中文字。");
      return chunk(value, "选中内容");
    }
    if (scope === "ocr" || scope === "parser") {
      const value = $(scope === "parser" ? "engine-result" : "ocr-result").value.trim();
      if (!value) throw new Error("请先运行 OCR 并获取识别结果。");
      return chunk(value, "识别结果");
    }
    const total = scope === "page" ? 1 : pages()?.length || pdf()?.numPages || book()?.spine.spineItems.length || 1;
    const chunks = [];
    for (let offset = 0; offset < total; offset++) {
      const index = scope === "page" ? pageNumber() : offset + 1;
      const value = await pageText(index);
      if (!value.trim()) continue;
      chunks.push(...chunk(value, `第 ${index} ${book() ? "章" : "页"}`));
    }
    if (!chunks.length) throw new Error("没有可翻译的文字；扫描文档请先运行 OCR。");
    return chunks;
  }
  function drawResults() {
    $("translation-results").replaceChildren();
    for (const result of results) {
      const row = document.createElement("article");
      row.className = "translation-row";
      const title = document.createElement("h3"),
        source = document.createElement("p"),
        translated = document.createElement("textarea");
      title.textContent = result.label;
      source.className = "source";
      source.textContent = result.source;
      translated.className = "translation-edit";
      translated.value = result.translation;
      translated.setAttribute("aria-label", `编辑${result.label}的译文`);
      translated.onchange = () => {
        result.translation = translated.value;
        void saveResults().catch((error) => message(error.message));
      };
      row.append(title, source, translated);
      if (result.warnings?.length) {
        const warning = document.createElement("p"); warning.className = "quality-warning";
        warning.textContent = result.warnings.join(" "); row.append(warning);
      }
      $("translation-results").append(row);
    }
  }
  function saveResults(provider = $("translate-provider").value, target = cacheTarget()) {
    const doc = current();
    return doc ? host.translationSave(doc.id, provider, target, results) : Promise.resolve();
  }
  async function loadResults() {
    const doc = current(),
      provider = $("translate-provider").value;
    if (!doc || !provider) return;
    const target = cacheTarget(), key = signature(), token = translationToken;
    const saved = await host.translationLoad(doc.id, provider, target);
    if (current()?.id !== doc.id || token !== translationToken || key !== signature()) return;
    results = Array.isArray(saved) ? saved.filter((item) => item && typeof item.translation === "string" && item.signature === key) : [];
    drawResults();
  }
  $("translate-provider").onchange = () => {
    selectedProvider = $("translate-provider").value;
    void loadResults().catch((error) => message(error.message));
  };
  $("translate-target").onchange = () => {
    void loadResults().catch((error) => message(error.message));
  };
  $("translate-start").onclick = async () => {
    const doc = current();
    if (!doc) return;
    const provider = $("translate-provider").value;
    const target = $("translate-target").value, targetKey = cacheTarget(), key = signature();
    const options = { task: $("ai-task").value, profile: config.profile(), glossary: $("ai-glossary").value, custom: $("ai-custom").value };
    if (!providers.find((item) => item.id === provider)?.configured) return tab("api");
    const token = ++translationToken;
    busy(true);
    $("translate-progress").value = 0;
    $("translate-status").textContent = "正在提取文字并按段落组织上下文…";
    try {
      const chunks = await sourceChunks($("translate-scope").value);
      const saved = await host.translationLoad(doc.id, provider, targetKey);
      if (token !== translationToken || current()?.id !== doc.id) return;
      results = [];
      drawResults();
      for (let i = 0; i < chunks.length && token === translationToken; i++) {
        const chunk = chunks[i];
        const cached = saved.find(item => item.signature === key && item.label === chunk.label && item.source === chunk.text && item.before === chunk.before && item.after === chunk.after);
        if (cached) {
          results.push(cached); drawResults();
          $("translate-progress").value = (i + 1) / chunks.length;
          continue;
        }
        $("translate-status").textContent = `正在${taskName()} ${i + 1}/${chunks.length} · ${chunk.label} · 共 ${chunks.reduce((n, x) => n + x.text.length, 0).toLocaleString()} 字符`;
        requestId = crypto.randomUUID();
        const response = await host.translate(doc.id, { provider, ...options, text: chunk.text, target, before: chunk.before, after: chunk.after, previous: results.at(-1)?.translation?.slice(-500) || "", requestId });
        if (token !== translationToken || current()?.id !== doc.id) return;
        results.push({ label: chunk.label, source: chunk.text, before: chunk.before, after: chunk.after, translation: response.text, signature: key, warnings: response.warnings, model: response.model, usage: response.usage, promptVersion: response.promptVersion });
        await host.translationSave(doc.id, provider, targetKey, results);
        drawResults();
        $("translate-progress").value = (i + 1) / chunks.length;
        if (token !== translationToken) break;
      }
      if (token === translationToken) $("translate-status").textContent = `已完成 ${results.length} 段。`;
    } catch (error) {
      if (token === translationToken)
        $("translate-status").textContent = `处理未完成：${error.message} 已完成结果保留，可点击开始续跑。`;
    } finally {
      if (token === translationToken) {
        requestId = null; busy(false);
      }
    }
  };
  $("translate-cancel").onclick = () => {
    translationToken++;
    if (requestId) void host.aiCancel(requestId).catch(error => message(error.message));
    requestId = null;
    $("translate-status").textContent = "已取消，完成的处理结果保留。";
    busy(false);
  };
  const combined = () =>
    results.map((item) => `${item.label}\n原文：${item.source}\n结果：${item.translation}`).join("\n\n");
  $("translation-copy").onclick = () =>
    host
      .copy(combined())
      .then(() => message("已复制处理结果"))
      .catch((error) => message(error.message));
  $("translation-export").onclick = () => host.export(combined()).catch((error) => message(error.message));
  async function selectEngine(value) {
    if (jobId) return;
    engine = value;
    for (const [id, kind] of [
      ["ocr-fast", "docling"],
      ["ocr-accurate", "mineru"],
    ])
      $(id).setAttribute("aria-pressed", String(kind === value));
    $("engine-status").textContent = "正在检查本地组件…";
    const ready = await host.engineInstalled(value);
    if (engine !== value) return;
    $("engine-action").hidden = false;
    $("engine-action").textContent = ready ? "开始解析当前文档" : `安装${value === "docling" ? "快速" : "高精度"} OCR`;
    $("engine-status").textContent = ready
      ? "组件已就绪，可离线解析已下载模型支持的文档。"
      : "首次安装需要网络连接；自动检查 Python，不可用时下载独立环境。模型将在解析时按需下载。";
  }
  $("ocr-fast").onclick = () => selectEngine("docling").catch((error) => message(error.message));
  $("ocr-accurate").onclick = () => selectEngine("mineru").catch((error) => message(error.message));
  async function trackJob(id) {
    jobId = id;
    $("engine-action").disabled = true;
    $("ocr-fast").disabled = $("ocr-accurate").disabled = true;
    $("engine-cancel").hidden = false;
    while (jobId === id) {
      const status = await host.engineStatus(id);
      if (jobId !== id) return;
      $("engine-status").textContent = status.detail;
      if (status.status !== "running") {
        jobId = null;
        $("engine-action").disabled = false;
        $("ocr-fast").disabled = $("ocr-accurate").disabled = false;
        $("engine-cancel").hidden = true;
        if (status.result) {
          $("engine-output").hidden = false;
          $("engine-result").value = status.result;
        }
        if (status.status === "done") await selectEngine(engine);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  $("engine-action").onclick = async () => {
    if (!engine || !current()) return;
    $("engine-action").disabled = true;
    try {
      const id = await ((await host.engineInstalled(engine))
        ? host.engineParse(current().id, engine, config.profile())
        : host.engineInstall(engine, config.profile()));
      await trackJob(id);
    } catch (error) {
      $("engine-status").textContent = error.message;
      $("engine-action").disabled = false;
      $("ocr-fast").disabled = $("ocr-accurate").disabled = false;
      $("engine-cancel").hidden = true;
    }
  };
  $("engine-cancel").onclick = () => {
    if (jobId) void host.engineCancel(jobId);
  };
  $("engine-copy").onclick = () => host.copy($("engine-result").value).then(() => message("已复制解析结果"));
  $("engine-export").onclick = () => host.export($("engine-result").value).catch((error) => message(error.message));
  function open(name = "ocr") {
    if (restoredDocument !== current()?.id) { config.restore(); restoredDocument = current()?.id; }
    updateTask();
    tab(name);
    if (requestId) return;
    void refreshProviders()
      .then(() => {
        if (name === "translate") return loadResults();
      })
      .catch((error) => message(error.message));
  }
  function reset() {
    translationToken++;
    restoredDocument = null;
    if (requestId) void host.aiCancel(requestId).catch(error => message(error.message));
    requestId = null; busy(false);
    if (jobId) void host.engineCancel(jobId).catch((error) => message(error.message));
    jobId = null;
    $("engine-action").disabled = false;
    $("ocr-fast").disabled = $("ocr-accurate").disabled = false;
    $("engine-cancel").hidden = true;
    results = [];
    drawResults();
    $("engine-output").hidden = true;
    $("engine-result").value = "";
  }
  return { open, reset };
}
