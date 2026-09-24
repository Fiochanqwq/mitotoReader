export function workbenchController({ host, current, pdf, book, pages, pageNumber, selectedText, message }) {
  const $ = (id) => document.getElementById(id);
  const tabs = ["ocr", "translate", "api"];
  let providers = [],
    selectedProvider = "deepseek",
    engine = null,
    jobId = null,
    translationToken = 0;
  let results = [];
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
    if (pdf()) return (await (await pdf().getPage(index)).getTextContent()).items.map((x) => x.str || "").join(" ");
    if (book()) {
      const section = book().spine.spineItems[index - 1];
      const xml = await book().load(section.href);
      return xml.documentElement?.textContent || "";
    }
    return $("ocr-result").value.trim();
  }
  async function sourceChunks(scope) {
    if (scope === "selection") {
      const value = selectedText();
      if (!value) throw new Error("请先在阅读页面选中文字。");
      return [{ label: "选中内容", text: value }];
    }
    if (scope === "ocr") {
      const value = $("engine-result").value.trim() || $("ocr-result").value.trim();
      if (!value) throw new Error("请先运行 OCR 并获取识别结果。");
      return Array.from({ length: Math.ceil(value.length / 8000) }, (_, index) => ({
        label: `识别结果 · ${index + 1}`,
        text: value.slice(index * 8000, (index + 1) * 8000),
      }));
    }
    const total = scope === "page" ? 1 : pages()?.length || pdf()?.numPages || book()?.spine.spineItems.length || 1;
    const chunks = [];
    for (let offset = 0; offset < total; offset++) {
      const index = scope === "page" ? pageNumber() : offset + 1;
      const value = await pageText(index);
      if (!value.trim()) continue;
      for (let start = 0; start < value.length; start += 8000) {
        chunks.push({
          label: `第 ${index} ${book() ? "章" : "页"}${value.length > 8000 ? ` · ${Math.floor(start / 8000) + 1}` : ""}`,
          text: value.slice(start, start + 8000),
        });
      }
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
      $("translation-results").append(row);
    }
  }
  function saveResults(provider = $("translate-provider").value, target = $("translate-target").value) {
    const doc = current();
    return doc ? host.translationSave(doc.id, provider, target, results) : Promise.resolve();
  }
  async function loadResults() {
    const doc = current(),
      provider = $("translate-provider").value;
    if (!doc || !provider) return;
    const saved = await host.translationLoad(doc.id, provider, $("translate-target").value);
    results = Array.isArray(saved) ? saved.filter((item) => item && typeof item.translation === "string") : [];
    drawResults();
  }
  $("translate-provider").onchange = () => {
    void loadResults().catch((error) => message(error.message));
  };
  $("translate-target").onchange = () => {
    void loadResults().catch((error) => message(error.message));
  };
  $("translate-start").onclick = async () => {
    const doc = current();
    if (!doc) return;
    const provider = $("translate-provider").value;
    const target = $("translate-target").value;
    if (!providers.find((item) => item.id === provider)?.configured) return tab("api");
    const token = ++translationToken;
    $("translate-start").disabled = true;
    $("translate-cancel").hidden = false;
    $("translate-progress").hidden = false;
    try {
      const chunks = await sourceChunks($("translate-scope").value);
      const saved = await host.translationLoad(doc.id, provider, target);
      results = chunks
        .map((chunk) => saved.find((item) => item.label === chunk.label && item.source === chunk.text))
        .filter(Boolean);
      drawResults();
      for (let i = 0; i < chunks.length && token === translationToken; i++) {
        const chunk = chunks[i];
        if (results.some((item) => item.label === chunk.label && item.source === chunk.text)) {
          $("translate-progress").value = (i + 1) / chunks.length;
          continue;
        }
        $("translate-status").textContent = `正在翻译 ${i + 1}/${chunks.length} · ${chunk.label}`;
        const response = await host.translate(doc.id, { provider, text: chunk.text, target });
        results.push({ label: chunk.label, source: chunk.text, translation: response.text });
        await saveResults(provider, target);
        drawResults();
        $("translate-progress").value = (i + 1) / chunks.length;
        if (token !== translationToken) break;
      }
      if (token === translationToken) $("translate-status").textContent = `已完成 ${results.length} 段。`;
    } catch (error) {
      if (token === translationToken)
        $("translate-status").textContent = `翻译失败：${error.message}；已完成结果保留。`;
    } finally {
      if (token === translationToken) {
        $("translate-start").disabled = false;
        $("translate-cancel").hidden = true;
        $("translate-progress").hidden = true;
      }
    }
  };
  $("translate-cancel").onclick = () => {
    translationToken++;
    $("translate-status").textContent = "已取消，完成的译文保留。";
    $("translate-start").disabled = false;
    $("translate-cancel").hidden = true;
    $("translate-progress").hidden = true;
  };
  const combined = () =>
    results.map((item) => `${item.label}\n原文：${item.source}\n译文：${item.translation}`).join("\n\n");
  $("translation-copy").onclick = () =>
    host
      .copy(combined())
      .then(() => message("已复制译文"))
      .catch((error) => message(error.message));
  $("translation-export").onclick = () => host.export(combined()).catch((error) => message(error.message));
  async function selectEngine(value) {
    engine = value;
    for (const [id, kind] of [
      ["ocr-fast", "docling"],
      ["ocr-accurate", "mineru"],
    ])
      $(id).setAttribute("aria-pressed", String(kind === value));
    $("engine-status").textContent = "正在检查本地组件…";
    const ready = await host.engineInstalled(value);
    $("engine-action").hidden = false;
    $("engine-action").textContent = ready ? "开始解析当前文档" : `安装${value === "docling" ? "快速" : "高精度"} OCR`;
    $("engine-status").textContent = ready
      ? "组件已就绪，可离线解析已下载模型支持的文档。"
      : "首次使用需安装本地组件与模型；需要 Python 和网络连接。";
  }
  $("ocr-fast").onclick = () => selectEngine("docling").catch((error) => message(error.message));
  $("ocr-accurate").onclick = () => selectEngine("mineru").catch((error) => message(error.message));
  async function trackJob(id) {
    jobId = id;
    $("engine-action").disabled = true;
    $("engine-cancel").hidden = false;
    while (jobId === id) {
      const status = await host.engineStatus(id);
      $("engine-status").textContent = status.detail;
      if (status.status !== "running") {
        jobId = null;
        $("engine-action").disabled = false;
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
    try {
      const id = await ((await host.engineInstalled(engine))
        ? host.engineParse(current().id, engine)
        : host.engineInstall(engine));
      await trackJob(id);
    } catch (error) {
      $("engine-status").textContent = error.message;
      $("engine-action").disabled = false;
      $("engine-cancel").hidden = true;
    }
  };
  $("engine-cancel").onclick = () => {
    if (jobId) void host.engineCancel(jobId);
  };
  $("engine-copy").onclick = () => host.copy($("engine-result").value).then(() => message("已复制解析结果"));
  $("engine-export").onclick = () => host.export($("engine-result").value).catch((error) => message(error.message));
  function open(name = "ocr") {
    tab(name);
    void refreshProviders()
      .then(() => {
        if (name === "translate") return loadResults();
      })
      .catch((error) => message(error.message));
  }
  function reset() {
    translationToken++;
    if (jobId) void host.engineCancel(jobId).catch((error) => message(error.message));
    jobId = null;
    results = [];
    drawResults();
    $("engine-output").hidden = true;
    $("engine-result").value = "";
  }
  return { open, reset };
}
