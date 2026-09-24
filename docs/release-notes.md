# mitotoReader 0.2.0-alpha.2

Windows x64 功能测试版。加入文档工作台、快捷标注、多格式文字阅读、本地文档解析和可选的 AI 翻译。

## 下载与使用

- **安装版：`mitotoReader-0.2.0-alpha.2-Setup.exe`**。双击安装；阅读器和原有轻量 OCR 无需单独安装 Node.js。
- **便携版：`mitotoReader-0.2.0-alpha.2-win32-x64.zip`**。完整解压后运行 `mitotoReader.exe`，不要只复制 EXE。
- 源码包和 `SHA256SUMS.txt` 可用于查看源码及校验下载文件。

安装版的阅读数据保存在 `%APPDATA%/mitotoreader/`；便携版使用程序旁的 `mitoto-data/`。书库引用原文件，请保留原始文档。

## 本版更新

- `Ctrl+T` 打开浮动快捷工具：高光、批注、框选 OCR、翻译选中文字。阅读工具集中在可收起的抽屉；`F9` 只隐藏应用内栏位，不自动进入系统全屏。
- 独立文档工作台提供整份 PDF 轻量 OCR，并可安装 Docling“快速 OCR”或 MinerU“高精度 OCR”处理文档。
- 新增 DeepSeek、Gemini、OpenAI、Claude、Qwen、Kimi 的 API Key 配置和基础翻译。支持选中文字、当前页、整份文档和 OCR 结果；完成的分段译文可继续编辑、复制、导出。
- 新增 DOCX、PPTX、XLSX、ODT、ODP、ODS、TXT、MD、HTML、CSV、TSV、RTF 的文字阅读模式。PDF、EPUB 和图片阅读功能继续保留。
- PDF 缩放、翻页过渡、左右方向键和可收回栏位的交互得到调整。

## 验证与限制

发布流程会验证便携版阅读、OCR、书库、长篇 EPUB、五种 OCR 语言模式及安装后的程序。Office 和 ODF 文档目前提取文字供阅读，不保留复杂版式和嵌入媒体。Docling / MinerU 首次启用需要系统 Python、网络和额外模型下载；AI 翻译需要用户自己的 API Key 与网络连接，可能产生服务商费用。尚未加入提示词优化或自动费用预估。

此安装包未购买代码签名证书；Windows 可能显示未知发布者提示。请从本仓库 Releases 下载并核对校验值。
