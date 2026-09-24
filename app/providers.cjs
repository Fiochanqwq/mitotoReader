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
async function request(url, init, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Do not surface response bodies: providers may echo sensitive request data.
      throw new Error(
        `服务商返回 ${response.status}${body.includes("model_not_found") ? "：当前模型不可用，请在高级设置更换模型" : ""}。`,
      );
    }
    return response.json();
  } catch (error) {
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
async function translateText({ provider, key, region, model, text, target }, fetcher = fetch) {
  const preset = validateProvider(provider);
  if (typeof text !== "string" || !text.trim() || text.length > 12_000)
    throw new Error("单次翻译文字须在 1 至 12000 字之间。");
  if (typeof target !== "string" || !/^[\p{L}\p{N} ()-]{2,40}$/u.test(target)) throw new Error("目标语言无效。");
  const chosenModel = typeof model === "string" && /^[a-zA-Z0-9._:-]{2,100}$/.test(model) ? model : preset.model;
  const instruction = `将以下内容翻译成${target}。只输出译文。\n\n${text}`;
  // Translation contract for later prompt work: preserve paragraph boundaries, numbers,
  // citations, formulas, code, and table cells; never invent missing source content.
  // Keep prompt revisions separate from provider transport and version them before rollout.
  // Future work: tokenize/chunk by document blocks, estimate cost, retry 429, and persist
  // per-block results so whole-document jobs can resume without duplicate billing.
  const base = endpoint(provider, region);
  let url, body;
  if (provider === "gemini") {
    url = `${base}/models/${encodeURIComponent(chosenModel)}:generateContent`;
    body = { contents: [{ role: "user", parts: [{ text: instruction }] }] };
  } else if (provider === "claude") {
    url = `${base}/messages`;
    body = { model: chosenModel, max_tokens: 4096, messages: [{ role: "user", content: instruction }] };
  } else if (provider === "openai") {
    url = `${base}/responses`;
    body = { model: chosenModel, input: instruction, store: false };
  } else {
    url = `${base}/chat/completions`;
    body = { model: chosenModel, messages: [{ role: "user", content: instruction }] };
  }
  const result = await request(
    url,
    {
      method: "POST",
      headers: { ...headers(provider, key), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    fetcher,
  );
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
  return { text: output.trim(), usage: result.usage || result.usageMetadata || null, model: chosenModel };
}
module.exports = { providers, validateProvider, verifyProvider, translateText };
