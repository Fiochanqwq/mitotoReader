# Third-party components

Dependency versions and integrity values are pinned in `package-lock.json`.

- Electron: MIT; Chromium and other bundled notices are distributed as `LICENSE` and `LICENSES.chromium.html` in the runtime. The application GPL license is separate.
- PDF.js (`pdfjs-dist`): Apache-2.0. PDF CMaps, standard fonts and WASM assets retain their supplied notices.
- epub.js: BSD-2-Clause. The transitive XML parser is pinned to `@xmldom/xmldom` 0.9.12.
- Readium CSS: BSD-3-Clause.
- Tesseract.js and tesseract.js-core: Apache-2.0. The core embeds Tesseract, Leptonica and supporting code; retain upstream notices in distribution.
- Tesseract tessdata_fast: Apache-2.0. Twelve language files: `eng`, `chi_sim`, `chi_tra`, `jpn`, `jpn_vert`, `kor`, `deu`, `fra`, `spa`, `rus`, `ita`, `por`. Fixed source revision and hashes are in `resources/models.lock.json`.

The build produces `build/components.json` and copies license/notice files for bundled JavaScript dependencies into `build/licenses/`. It also retains model licenses and PDF resource directories. Development dependencies are not installed inside the portable application.

Source locations:

- https://github.com/electron/electron
- https://github.com/mozilla/pdf.js
- https://github.com/futurepress/epub.js
- https://github.com/readium/css
- https://github.com/naptha/tesseract.js
- https://github.com/naptha/tesseract.js-core
- https://github.com/tesseract-ocr/tessdata_fast

Pinned core dependency notices are stored in `resources/notices/` with their source URLs and copied into the package. Bundled worker license notices and Electron's Chromium notice file are preserved. Models are downloaded from the fixed official source revision and checked against the SHA-256 lock. The application's license is distributed as `LICENSE-mitotoReader`, preserving Electron's own `LICENSE`.

# 可选 Python 运行环境

当用户安装解析组件且系统 Python 不可用时，应用可下载 Python Software Foundation 在 NuGet 发布的 Windows x64 CPython 3.12.10 包。包不随阅读器预置；包内许可证保留在独立安装目录。来源与固定 SHA-256 见 `app/python-runtime.cjs`。Docling / MinerU 及其依赖在用户触发安装后另行下载，遵循各自许可证。
