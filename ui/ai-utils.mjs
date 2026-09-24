// Lossless splitting: prefer paragraph, line and sentence boundaries, with a hard
// limit for unusually long blocks. Context is sent separately and never exported.
export function splitText(text, max = 6000) {
  if (!Number.isInteger(max) || max < 2) throw new Error("Invalid chunk size");
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const piece = text.slice(start, end);
      const floor = Math.floor(max * 0.45);
      const boundaries = [
        piece.lastIndexOf("\n\n"),
        piece.lastIndexOf("\n"),
        ...[...piece.matchAll(/(?:[。！？]|[.!?](?=\s|$))\s*/g)].reverse().map((x) => x.index + x[0].length - 1),
      ];
      const boundary = boundaries.find((x) => x >= floor);
      if (boundary !== undefined) end = start + boundary + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push({
      text: text.slice(start, end),
      before: text.slice(Math.max(0, start - 500), start),
      after: text.slice(end, end + 500),
    });
    start = end;
  }
  return chunks;
}
export const presets = {
  reading: {
    name: "个人阅读",
    genre: "一般阅读，保持原文语气与信息完整",
    layout: "single",
    input: "auto",
    output: "text",
    language: "chi_sim+eng",
  },
  nature: {
    name: "Nature / Science 类论文",
    genre: "综合科学论文；谨慎保留证据强度、图注、统计量与参考文献",
    layout: "columns",
    input: "pdf",
    output: "markdown",
    language: "eng",
  },
  ieee: {
    name: "IEEE / ACM 类论文",
    genre: "工程与计算机论文；保留算法、代码、数学记号、单位与编号引文",
    layout: "columns",
    input: "pdf",
    output: "markdown",
    language: "eng",
  },
  medical: {
    name: "医学期刊论文",
    genre: "医学论文；严格保留剂量、置信区间、风险方向、样本量和试验限定条件",
    layout: "columns",
    input: "pdf",
    output: "markdown",
    language: "eng",
  },
  book: {
    name: "书籍 / 人文阅读",
    genre: "书籍与人文文献；保留作者文风、引语、注释及专名",
    layout: "single",
    input: "auto",
    output: "text",
    language: "chi_sim+eng",
  },
  scan: {
    name: "扫描件 / 档案",
    genre: "扫描档案；保留历史拼写，不猜测缺损文字",
    layout: "auto",
    input: "auto",
    output: "markdown",
    language: "chi_sim+eng",
    force: true,
  },
};
