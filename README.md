# mitotoReader

独立的 Windows 离线阅读器。现代、极简、黑白灰界面。

**0.1.0-alpha.1 是最小可行测试版。** 完整多格式阅读器仍在后续路线中。

![首页](docs/images/home.png)

## 测试版范围

- PDF：翻页、缩放、页码跳转、文字选择与复制、目录。
- EPUB：目录、横排/竖排、ruby、字体/字号/行距/页边距、阅读位置和单书设置。
- PNG/JPEG：查看、缩放。
- 当前 PDF 页或图片：离线中/日/英 OCR、取消、可编辑结果、复制、导出 TXT。
- 最近阅读、深浅色主题、可收起的阅读工具和侧栏。

文件留在本机；不使用遥测、远程字体、在线识别或更新检查。EPUB 内脚本禁用，外部网络请求被阻止。

## Windows 便携版

解压整个发行包，双击 `mitotoReader.exe`。保留随包文件。设置写入同目录 `mitoto-data/`；请放在当前用户可写的目录。OCR 引擎、语言数据、PDF 字体资源和 Chromium 运行时都包含在包内。

`Ctrl+O` 打开文档；`PageUp/PageDown` 翻页；`Esc` 收起侧栏。固定版式文档保留原件字体和颜色；排版面板仅用于 EPUB。

## 从源码运行

需要 Windows x64、Node.js 24、npm、Bun 和 PowerShell。首次获取依赖和模型需要联网；之后应用运行可断网。

```powershell
npm ci
bun cmd/build.ts
npm start
```

唯一构建入口为 `cmd/build.ts`。OCR 模型的来源、固定提交和 SHA-256 记录在 `resources/models.lock.json`；缓存损坏会使构建失败。Electron 二进制由其 npm 安装脚本依据随包校验清单验证。

## 针对性测试

```powershell
pwsh tests/generate-reader-fixtures.ps1
npm test
node tests/ocr-languages.mjs
```

测试通过 Playwright 启动实际 Electron 应用，使用隐藏窗口和独立配置目录；生成的 PDF 和 OCR 导出保存在 `tests/tmp/`。不覆盖正常阅读记录。截图需可用的图形桌面并显式设置 `MITOTO_CAPTURE=1`；`node tests/visual.mjs` 可通过无界面浏览器生成设计截图，但不代替桌面集成测试。

启动回归不打开窗口：`node --test tests/startup.test.cjs tests/runtime.test.cjs`。

## 打包

```powershell
bun cmd/build.ts --package
```

输出 `release/mitotoReader-0.1.0-alpha.1-win32-x64/`。打包后再次运行测试：

```powershell
$env:MITOTO_TEST_EXE = (Resolve-Path 'release/mitotoReader-0.1.0-alpha.1-win32-x64/mitotoReader.exe').Path
npm test
```

## 限制与后续路线

- 单文档阅读；测试版文件上限 256 MB。密码 PDF 尚不支持。
- OCR 处理当前页，最大栅格化面积 1600 万像素；识别结果须人工核对。图像过大时会缩小后识别。
- 页面、连续文字块和单行文字可选择不同识别布局；日文竖排使用竖排布局。单行日文在自动页面分析下可能重复识别，建议选择“单行文字”。
- 本次不包含 Office、其他电子书/漫画格式、完整书库、搜索、批注、区域/批量 OCR、翻译、公式/表格/手写专项模型和安装程序。
- 无 DRM 绕过、同步、朗读或 AI 问答。
- 更多真实书籍、复杂 EPUB、Windows 10、无障碍和低配机器需要后续验证。

这些能力仍在后续产品路线中，不视为本次已实现。测试证据和未通过项见 `TESTING.md`。

## 来源与许可证

项目采用 GPL-3.0-only。EPUB 排版逻辑由先前阅读器实验迁移并改造；不调用 Sumatra 可执行程序或链接其引擎。依赖独立遵循各自许可证，见 `THIRD-PARTY.md` 和构建生成的 `build/licenses/`、`build/components.json`。界面为原创代码实现。
