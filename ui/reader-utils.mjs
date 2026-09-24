export function fitScale(width, height, availableWidth, availableHeight, mode) {
  const horizontal = Math.max(1, availableWidth) / width;
  return Math.max(
    0.05,
    Math.min(3, mode === "page" ? Math.min(horizontal, Math.max(1, availableHeight) / height) : horizontal),
  );
}
export function rasterScale(width, height, desired, budget = 8_000_000) {
  return Math.min(desired, Math.sqrt(budget / (width * height)));
}
export function pageRange(value, total, current) {
  if (!value.trim()) return [current];
  const pages = new Set();
  for (const part of value.split(/[,，]/)) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error("页码格式：1-5, 8, 10");
    const first = Number(match[1]),
      last = Number(match[2] || match[1]);
    if (first < 1 || last > total || first > last) throw new Error(`页码必须介于 1 和 ${total} 之间`);
    if (last - first > 99) throw new Error("每批最多识别 100 页，请分批处理。");
    for (let page = first; page <= last; page++) pages.add(page);
  }
  if (pages.size > 100) throw new Error("每批最多识别 100 页，请分批处理。");
  return [...pages].sort((a, b) => a - b);
}
export function snippets(text, query, limit = 30) {
  const lower = text.toLocaleLowerCase(),
    needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const found = [];
  let start = 0;
  while (found.length < limit) {
    const index = lower.indexOf(needle, start);
    if (index < 0) break;
    found.push(text.slice(Math.max(0, index - 35), index + query.length + 65));
    start = index + Math.max(1, needle.length);
  }
  return found;
}
