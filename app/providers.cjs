const { buildPrompt, qualityWarnings } = require("./prompts.cjs");
const providers = Object.freeze({
  deepseek: { name: "DeepSeek", model: "deepseek-flash", base: "https://api.deepseek.com" },
  gemini: { name: "Gemini", model: "gemini-3.7-flash", base: "https://generativelanguage.googleapis.com/v1beta" },
  openai: { name: "OpenAI", model: "gpt-5-mini", base: "https://api.openai.com/v1" },
  claude: { name: "Claude", model: "claude-sonnet-5", base: "https://api.anthropic.com/v1" },
  qwen: { name: "Qwen", model: "qwen-plus", base: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  kimi: { name: "Kimi", model: "kimi-k2.6", base: "https://api.moonshot.cn/v1" },
});
const validateProvider = (id) => {
  if (!Object.hasOwn(providers, id)) throw new Error("不支持此模型服务商。");
  return providers[id];
};
function endpoint(id, region) {
  const preset = validateProvider(id);
  if (id === "kimi" && region === "global") return "https://api.moonshot.ai/v1";
  if (id === "qwen" && region === "global") return "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  return preset.base;
}
function headers(id, key) {
  if (id === "claude") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (id === "gemini") return { "x-goog-api-key": key };
  return { Authorization: `Bearer ${key}` };
}
async function request(url, init, fetcher = fetch, signal, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetcher(url, { ...init, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
      await response.text().catch(() => "");
      clearTimeout(timer);
      const retry = Number(response.headers?.get("retry-after"));
      const delay = Number.isFinite(retry) && retry > 0 ? Math.min(10000, retry * 1000) : 1000 * 2 ** attempt;
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("已取消 AI 任务。"));
        const abort = () => { clearTimeout(wait); reject(new Error("已取消 AI 任务。")); };
        const wait = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
        signal?.addEventListener("abort", abort, { once: true });
      });
      return request(url, init, fetcher, signal, attempt + 1);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Do not surface response bodies: providers may echo sensitive request data.
      throw new Error(
        `服务商返回 ${response.status}${body.includes("model_not_found") ? "：当前模型不可用，请在高级设置更换模型" : ""}。`,
      );
    }
    return response.json();
  } catch (error) {
    if (signal?.aborted) throw new Error("已取消 AI 任务。");
    if (error.name === "AbortError") throw new Error("请求超时，请检查网络后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function verifyProvider(id, key, region, fetcher = fetch) {
  const base = endpoint(id, region);
  const url =
    id === "gemini"
      ? `${base}/models?pageSize=1`
      : id === "qwen"
        ? `${base.replace("/compatible-mode/v1", "/api/v1")}/models?page_size=1`
        : `${base}/models`;
  await request(url, { method: "GET", headers: headers(id, key) }, fetcher);
  return true;
}
async function translateText(input, fetcher = fetch) {
  const { provider, key, region, model, text, target, signal } = input;
  const preset = validateProvider(provider);
  if (typeof text !== "string" || !text.trim() || text.length > 12_000)
    throw new Error("单次翻译文字须在 1 至 12000 字之间。");
  if (typeof target !== "string" || !/^[\p{L}\p{N} ()-]{2,40}$/u.test(target)) throw new Error("目标语言无效。");
  const chosenModel = typeof model === "string" && /^[a-zA-Z0-9._:-]{2,100}$/.test(model) ? model : preset.model;
  const prompt = buildPrompt(input);
  const base = endpoint(provider, region);
  let url, body;
  if (provider === "gemini") {
    url = `${base}/models/${encodeURIComponent(chosenModel)}:generateContent`;
    body = { systemInstruction: { parts: [{ text: prompt.system }] }, contents: [{ role: "user", parts: [{ text: prompt.user }] }], generationConfig: { maxOutputTokens: 12000 } };
  } else if (provider === "claude") {
    url = `${base}/messages`;
    body = { model: chosenModel, max_tokens: 12000, system: prompt.system, messages: [{ role: "user", content: prompt.user }] };
  } else if (provider === "openai") {
    url = `${base}/responses`;
    body = { model: chosenModel, instructions: prompt.system, input: prompt.user, max_output_tokens: 16000, store: false };
  } else {
    url = `${base}/chat/completions`;
    body = { model: chosenModel, max_tokens: 8192, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] };
  }
  const result = await request(
    url,
    {
      method: "POST",
      headers: { ...headers(provider, key), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    fetcher, signal,
  );
  if (result.status === "incomplete" || result.stop_reason === "max_tokens" || result.choices?.[0]?.finish_reason === "length" || result.candidates?.[0]?.finishReason === "MAX_TOKENS")
    throw new Error("模型输出被截断；此段未保存。请在高级设置减小分段长度后重试。");
  if (result.error || result.status === "failed" || result.choices?.[0]?.finish_reason === "content_filter" || result.promptFeedback?.blockReason || ["SAFETY", "RECITATION", "PROHIBITED_CONTENT"].includes(result.candidates?.[0]?.finishReason) || result.choices?.[0]?.message?.refusal || result.output?.some(x => x.content?.some(p => p.type === "refusal")))
    throw new Error("模型未完成此段处理，请检查模型或调整输入。");
  const output =
    provider === "gemini"
      ? result.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
      : provider === "claude"
        ? result.content
            ?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
        : provider === "openai"
          ? result.output_text ||
            result.output
              ?.flatMap((part) => part.content || [])
              .map((part) => part.text || "")
              .join("")
          : result.choices?.[0]?.message?.content;
  if (!output?.trim()) throw new Error("服务商未返回译文，请检查模型设置。");
  return { text: output.trim(), usage: result.usage || result.usageMetadata || null, model: chosenModel, promptVersion: prompt.version, warnings: qualityWarnings(text, output, input.task) };
}
module.exports = { providers, validateProvider, verifyProvider, translateText };
