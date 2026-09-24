import JSZip from "jszip";

const parser = new DOMParser();
const text = (node) => node?.textContent?.trim() || "";
const children = (node, name) => [...(node?.children || [])].filter((child) => child.localName === name);
const descendants = (node, name) =>
  [...(node?.getElementsByTagName("*") || [])].filter((child) => child.localName === name);
const attr = (node, name) => node?.getAttribute(name) || node?.getAttribute(`w:${name}`) || "";
const parseXml = (value) => {
  const xml = parser.parseFromString(value, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("文档 XML 无法解析。");
  return xml;
};
const paragraph = (value, type = "paragraph") => ({ text: value.trim(), type });
const chunk = (items, title = "正文") => {
  const pages = [];
  let current = [],
    size = 0;
  for (const item of items.filter((x) => x.text)) {
    if (size + item.text.length > 4500 && current.length) {
      pages.push({ title: pages.length ? `${title} · ${pages.length + 1}` : title, paragraphs: current });
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.text.length;
  }
  if (current.length || !pages.length)
    pages.push({ title: pages.length ? `${title} · ${pages.length + 1}` : title, paragraphs: current });
  return pages;
};
const ensureSize = (pages) => {
  const chars = pages.reduce((sum, page) => sum + page.paragraphs.reduce((n, item) => n + item.text.length, 0), 0);
  if (chars > 5_000_000) throw new Error("文档文字超过当前阅读上限（500 万字）。");
  return pages;
};
async function archive(bytes) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  let total = 0;
  for (const file of Object.values(zip.files)) {
    total += file._data?.uncompressedSize || 0;
    if (total > 512 * 1024 * 1024) throw new Error("压缩文档展开后过大。");
  }
  return zip;
}
async function xmlFile(zip, name) {
  const entry = zip.file(name);
  if (!entry) throw new Error("文档缺少必要内容。");
  if ((entry._data?.uncompressedSize || 0) > 30 * 1024 * 1024) throw new Error("文档内容过大。");
  return parseXml(await entry.async("string"));
}
function docxText(node) {
  return descendants(node, "t")
    .map((x) => x.textContent)
    .join("");
}
async function docx(bytes) {
  const xml = await xmlFile(await archive(bytes), "word/document.xml");
  const body = descendants(xml, "body")[0];
  const items = [];
  for (const node of body?.children || []) {
    if (node.localName === "p") {
      const style = descendants(node, "pStyle")[0];
      items.push(paragraph(docxText(node), /^Heading|^Title/i.test(attr(style, "val")) ? "heading" : "paragraph"));
    } else if (node.localName === "tbl") {
      for (const row of children(node, "tr"))
        items.push(paragraph(children(row, "tc").map(docxText).join("  |  "), "table"));
    }
  }
  return chunk(items);
}
async function pptx(bytes) {
  const zip = await archive(bytes);
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  slideNames.sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  if (!slideNames.length) throw new Error("演示文稿没有可读取的幻灯片。");
  const pages = [];
  for (const name of slideNames) {
    const xml = await xmlFile(zip, name);
    const items = descendants(xml, "p").map((node) =>
      paragraph(
        descendants(node, "t")
          .map((x) => x.textContent)
          .join(""),
      ),
    );
    pages.push({ title: `第 ${pages.length + 1} 张幻灯片`, paragraphs: items.filter((x) => x.text) });
  }
  return pages;
}
async function xlsx(bytes) {
  const zip = await archive(bytes);
  const shared = zip.file("xl/sharedStrings.xml")
    ? descendants(await xmlFile(zip, "xl/sharedStrings.xml"), "si").map((node) => text(node))
    : [];
  const names = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  names.sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  if (!names.length) throw new Error("工作簿没有可读取的工作表。");
  const pages = [];
  for (const name of names) {
    const xml = await xmlFile(zip, name);
    const items = descendants(xml, "row").map((row) => {
      const cells = children(row, "c").map((cell) => {
        const value = text(children(cell, "v")[0]) || text(children(cell, "is")[0]);
        return attr(cell, "t") === "s" ? shared[Number(value)] || "" : value;
      });
      return paragraph(cells.join("  |  "), "table");
    });
    pages.push(...chunk(items, `工作表 ${pages.length + 1}`));
  }
  return pages;
}
async function odf(bytes) {
  const xml = await xmlFile(await archive(bytes), "content.xml");
  const items = descendants(xml, "p").map((node) => paragraph(text(node)));
  return chunk(items);
}
function rtf(value) {
  return value
    .replace(/\\u(-?\d+)\??/g, (_, number) => String.fromCharCode((Number(number) + 65536) % 65536))
    .replace(/\\par\b/g, "\n")
    .replace(/\\'[0-9a-f]{2}/gi, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
}
export async function parseDocument(kind, bytes) {
  const data = new Uint8Array(bytes);
  let pages;
  if (kind === "docx") pages = await docx(data);
  else if (kind === "pptx") pages = await pptx(data);
  else if (kind === "xlsx") pages = await xlsx(data);
  else if (["odt", "odp", "ods"].includes(kind)) pages = await odf(data);
  else {
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(data);
    const source =
      kind === "html" || kind === "htm"
        ? text(parser.parseFromString(raw, "text/html").body)
        : kind === "rtf"
          ? rtf(raw)
          : raw;
    pages = chunk(source.split(/\n\s*\n|\r?\n/).map((line) => paragraph(line)));
  }
  return ensureSize(pages);
}
