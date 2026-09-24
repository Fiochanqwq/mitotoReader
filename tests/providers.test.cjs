const { test } = require("node:test");
const assert = require("node:assert/strict");
const { providers, verifyProvider, translateText } = require("../app/providers.cjs");

test("all six providers send credentials only to their official HTTPS endpoint", async () => {
  for (const id of Object.keys(providers)) {
    let called;
    const fetcher = async (url, options) => {
      called = { url, options };
      return { ok: true, json: async () => ({ data: [] }) };
    };
    await verifyProvider(id, "secret-key", "cn", fetcher);
    assert.match(called.url, /^https:\/\//);
    assert.ok(!called.url.includes("secret-key"));
    assert.ok(Object.values(called.options.headers).some((value) => value.includes("secret-key")));
  }
});

test("translation adapters extract text from each provider response", async () => {
  const response = {
    deepseek: { choices: [{ message: { content: "译文" } }] },
    gemini: { candidates: [{ content: { parts: [{ text: "译文" }] } }] },
    openai: { output: [{ content: [{ type: "output_text", text: "译文" }] }] },
    claude: { content: [{ type: "text", text: "译文" }] },
    qwen: { choices: [{ message: { content: "译文" } }] },
    kimi: { choices: [{ message: { content: "译文" } }] },
  };
  for (const id of Object.keys(providers)) {
    const fetcher = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(JSON.stringify(body).includes("Hello"));
      if (id === "openai") assert.equal(body.store, false);
      return { ok: true, json: async () => response[id] };
    };
    const result = await translateText({ provider: id, key: "secret", text: "Hello", target: "简体中文" }, fetcher);
    assert.equal(result.text, "译文");
  }
});
