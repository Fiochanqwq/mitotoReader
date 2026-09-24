const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
// Official CPython Windows NuGet distribution; private to this application.
const VERSION = "3.12.10";
const SHA256 = "0eb85c2dfccccf1b17352de4c397f69194035b7d37149eacc16f1147d93de3b8";
async function ensurePython(root, job, run) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("请在高级设置指定健康的 Python 3.10–3.14 路径。");
  const folder = path.join(root, `python-${VERSION}`),
    exe = path.join(folder, "tools", "python.exe");
  try {
    await run(exe, ["-I", "-c", "import ssl,html,venv,ensurepip; assert html.escape('<') == '&lt;'"], job, 15000);
    return exe;
  } catch {
    if (job.cancelled) throw new Error("已取消。");
  }
  job.phase = "下载独立 Python";
  job.detail = "系统 Python 不可用，正在从 python.org 官方 NuGet 包下载独立运行环境…";
  const url = `https://api.nuget.org/v3-flatcontainer/python/${VERSION}/python.${VERSION}.nupkg`;
  const controller = new AbortController();
  job.controller = controller;
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok)
      throw new Error(`Python 下载失败（HTTP ${response.status}）。请检查 nuget.org 网络连接，或指定本地 Python。`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== SHA256) throw new Error("Python 下载校验失败，请重试。");
    if (job.cancelled) throw new Error("已取消。");
    await fs.mkdir(root, { recursive: true });
    const archive = path.join(root, `python-${VERSION}.zip`);
    await fs.writeFile(archive, data);
    // Literal paths are embedded in an encoded command, never interpolated by a shell.
    const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(folder)} -Force`;
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      job,
      120000,
    );
    await run(exe, ["-I", "-c", "import ssl,html,venv,ensurepip; assert html.escape('<') == '&lt;'"], job, 30000);
    await fs.rm(archive, { force: true });
    return exe;
  } finally {
    clearTimeout(timer);
    job.controller = null;
  }
}
module.exports = { ensurePython };
