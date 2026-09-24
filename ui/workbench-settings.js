import { presets } from "./ai-utils.mjs";
export function workbenchSettings({ read, write, message }) {
  const $ = (id) => document.getElementById(id);
  let customPresets = {};
  const fields = {
    input: "ocr-input",
    layout: "profile-layout",
    output: "profile-output",
    genre: "profile-genre",
    glossary: "ai-glossary",
    custom: "ai-custom",
    python: "engine-python",
  };
  const profile = () => ({
    ...Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $(id).value])),
    force: $("profile-force").checked,
    language: $("ocr-language").value,
  });
  function apply(value) {
    for (const [key, id] of Object.entries(fields))
      $(id).value =
        value[key] || (key === "input" ? "auto" : key === "output" ? "markdown" : key === "layout" ? "auto" : "");
    $("profile-force").checked = !!value.force;
    if (value.language) $("ocr-language").value = value.language;
    $("ocr-layout").value = value.layout === "single" ? "6" : "3";
    $("ocr-language").dispatchEvent(new Event("change"));
  }
  function options() {
    $("ocr-preset").replaceChildren(
      ...Object.entries({ ...presets, ...customPresets }).map(([key, value]) => new Option(value.name, key)),
    );
  }
  function save() {
    write({
      profile: profile(),
      preset: $("ocr-preset").value,
      customPresets,
      task: $("ai-task").value,
      chunkSize: Number($("ai-chunk-size").value),
      glossary: $("ai-glossary").value,
      custom: $("ai-custom").value,
    });
  }
  $("ocr-preset").onchange = () => {
    const value = { ...presets, ...customPresets }[$("ocr-preset").value];
    apply({ ...profile(), ...value });
    save();
  };
  for (const id of [...Object.values(fields), "profile-force", "ai-task", "ai-chunk-size"])
    $(id).addEventListener("change", save);
  $("profile-layout").addEventListener("change", () => {
    $("ocr-layout").value = $("profile-layout").value === "single" ? "6" : "3";
  });
  $("ocr-language").addEventListener("change", () => {
    if (read()) save();
  });
  $("profile-save").onclick = () => {
    const name = $("profile-name").value.trim().slice(0, 40);
    if (!name) return message("请填写方案名称。");
    const existing = Object.keys(customPresets).find((key) => customPresets[key].name === name);
    if (!existing && Object.keys(customPresets).length >= 12) return message("最多保存 12 个自定义方案。");
    const key = existing || `custom-${crypto.randomUUID()}`;
    customPresets[key] = { ...profile(), name };
    options();
    $("ocr-preset").value = key;
    save();
    message("已保存自定义方案，可在当前文档中复用。");
  };
  $("profile-delete").onclick = () => {
    const key = $("ocr-preset").value;
    if (!customPresets[key]) return message("内置方案不能删除，可另存为自定义方案。");
    delete customPresets[key];
    options();
    apply(presets.reading);
    save();
  };
  return {
    profile,
    save,
    restore() {
      const value = read() || {};
      customPresets = value.customPresets || {};
      options();
      $("ocr-preset").value = value.preset || "reading";
      $("ai-task").value = value.task || "translate";
      $("ai-chunk-size").value = value.chunkSize || 6000;
      apply(value.profile || presets.reading);
    },
  };
}
