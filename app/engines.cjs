const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ensurePython } = require("./python-runtime.cjs");

const healthCheck = "import sys,ssl,html,venv,ensurepip; assert (3,10) <= sys.version_info[:2] < (3,15); assert html.escape('<') == '&lt;'; print(sys.executable)";
function parserArgs(engine, source, output, options = {}) {
  const kind = path.extname(source).slice(1).toLowerCase();
  const input = options.input || "auto";
  if (!["auto", "pdf", "image", "office"].includes(input)) throw new Error("输入文件类型无效。");
  if ((input === "pdf" && kind !== "pdf") || (input === "image" && !["png", "jpg", "jpeg"].includes(kind)) || (input === "office" && !["docx", "pptx", "xlsx"].includes(kind))) throw new Error("当前文件与指定输入类型不匹配，请修改输入类型。");
  if (engine === "mineru") {
    if (!["pdf", "png", "jpg", "jpeg"].includes(kind)) throw new Error("此 MinerU 接入支持 PDF / PNG / JPEG；Office 文件请使用 Docling。");
    return ["parse", source, "-o", output, "--tier", "advanced"];
  }
  if (!["pdf", "png", "jpg", "jpeg", "docx", "pptx", "xlsx", "html", "md", "csv"].includes(kind)) throw new Error("此格式请先导出 PDF，或使用 AI 工作台处理已提取的文字。");
  const args = ["convert", source, "--to", "md", "--output", output];
  if (options.force) args.push("--force-ocr");
  return args;
}

function engineManager(userData) {
  const jobs = new Map();
  const supported = new Set(["docling", "mineru"]);
  const root = path.join(userData, "parsers");
  const python = (engine) =>
    path.join(root, engine, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const command = (engine, name) =>
    path.join(root, engine, process.platform === "win32" ? `Scripts/${name}.exe` : `bin/${name}`);
  const marker = (engine) => path.join(root, engine, ".ready");
  function validate(engine) {
    if (!supported.has(engine)) throw new Error("未知文档解析引擎。");
  }
  function stopChild(child) {
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else child.kill();
  }
  function run(executable, args, job, timeout = 30 * 60_000) {
    return new Promise((resolve, reject) => {
      if (job.cancelled) return reject(new Error("已取消。"));
      const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
      delete env.PYTHONHOME; delete env.PYTHONPATH;
      const child = spawn(executable, args, { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
      job.child = child;
      const timer = setTimeout(() => {
        stopChild(child);
        reject(new Error("操作超时，请检查网络连接后重试。"));
      }, timeout);
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output = (output + chunk.toString()).slice(-4000);
          job.detail = output.split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 200) || job.detail;
        });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (job.child === child) job.child = null;
        if (job.cancelled) reject(new Error("已取消。"));
        else if (code === 0) resolve(output);
        else reject(new Error(`进程退出（${code}）。\n${output}`));
      });
    });
  }
  async function installed(engine) {
    validate(engine);
    return (
      !!(await fs.stat(marker(engine)).catch(() => null)) &&
      !!(await fs.stat(command(engine, engine === "mineru" ? "mineru-kit" : "docling")).catch(() => null))
    );
  }
  async function install(engine, options = {}) {
    validate(engine);
    if ([...jobs.values()].some((job) => job.status === "running")) throw new Error("请等待当前任务结束。");
    const id = randomUUID();
    const job = { id, engine, status: "running", detail: "正在准备独立 Python 环境…", result: null, cancelled: false };
    jobs.set(id, job);
    void (async () => {
      try {
        job.phase = "检查 Python";
        const custom = typeof options.python === "string" ? options.python.trim() : "";
        if (custom && (!path.isAbsolute(custom) || !/python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(custom)))) throw new Error("请填写 python.exe 的完整路径。");
        const candidates = custom ? [[custom, []]] : [["py", ["-3.12"]], ["py", ["-3.11"]], ["py", ["-3.13"]], ["python", []], ["python3", []]];
        let base;
        for (const [exe, prefix] of candidates) {
          try { await run(exe, [...prefix, "-I", "-c", healthCheck], job, 15000); base = { exe, prefix }; break; }
          catch { if (job.cancelled) throw new Error("已取消。"); }
        }
        if (!base && custom) throw new Error("指定的 Python 不可用或标准库损坏。请清空路径以自动下载独立 Python，或选择健康的 Python 3.10–3.14。");
        if (!base) base = { exe: await ensurePython(root, job, run), prefix: [] };
        job.phase = "修复独立环境";
        await fs.mkdir(path.join(root, engine), { recursive: true });
        // A python.exe left by failed ensurepip is not a ready environment.
        await fs.rm(marker(engine), { force: true });
        await run(base.exe, [...base.prefix, "-I", "-m", "venv", "--without-pip", path.join(root, engine)], job);
        await run(python(engine), ["-I", "-c", healthCheck], job, 30000);
        try { await run(python(engine), ["-I", "-m", "pip", "--version"], job, 30000); }
        catch {
          try { await run(python(engine), ["-I", "-m", "ensurepip", "--upgrade", "--default-pip"], job); }
          catch {
            await run(base.exe, [...base.prefix, "-I", "-m", "pip", "--python", python(engine), "install", "--upgrade", "pip"], job);
          }
        }
        job.phase = "下载解析组件";
        job.detail = "正在安装解析组件；首次安装可能需要较长时间…";
        await run(python(engine), ["-I", "-m", "pip", "install", "--upgrade", "--retries", "3", "--timeout", "60", engine === "mineru" ? "mineru>=4,<5" : "docling>=2,<3"], job);
        job.phase = "验证组件";
        await run(command(engine, engine === "mineru" ? "mineru-kit" : "docling"), ["--help"], job, 120000);
        if (job.cancelled) throw new Error("已取消。");
        await fs.writeFile(marker(engine), "ready\n");
        job.status = "done";
        job.detail = "安装完成。首次解析还可能下载模型文件。";
      } catch (error) {
        job.status = job.cancelled ? "cancelled" : "error";
        job.detail = `${job.phase || "安装"}失败：${error.message}\n可直接重试以修复环境；如使用自定义 Python，请确认其标准库与 pip 可用。`;
      }
    })();
    return id;
  }
  async function parse(engine, source, options = {}) {
    validate(engine);
    parserArgs(engine, source, "output", options);
    if (!(await installed(engine))) throw new Error("请先安装此解析组件。");
    if ([...jobs.values()].some((job) => job.status === "running")) throw new Error("请等待当前任务结束。");
    const id = randomUUID();
    const job = { id, engine, status: "running", detail: "正在解析文档…", result: null, cancelled: false };
    jobs.set(id, job);
    void (async () => {
      try {
        const folder = path.join(userData, "parse-jobs", id);
        await fs.mkdir(folder, { recursive: true });
        let output;
        if (engine === "docling") {
          await run(command(engine, "docling"), parserArgs(engine, source, folder, options), job);
          const names = (await fs.readdir(folder)).filter((name) => name.endsWith(".md"));
          if (!names.length) throw new Error("Docling 未生成 Markdown 结果。");
          output = path.join(folder, names[0]);
        } else {
          output = path.join(folder, "result.md");
          await run(command(engine, "mineru-kit"), parserArgs(engine, source, output, options), job);
        }
        if (job.cancelled) throw new Error("已取消。");
        const result = await fs.readFile(output, "utf8");
        if (result.length > 10_000_000) throw new Error("解析结果过大，请缩小处理范围。");
        job.result = result;
        job.status = "done";
        job.detail = "解析完成。";
      } catch (error) {
        job.status = job.cancelled ? "cancelled" : "error";
        job.detail = error.message;
      }
    })();
    return id;
  }
  function status(id) {
    const job = jobs.get(id);
    if (!job) throw new Error("找不到解析任务。");
    return { id: job.id, engine: job.engine, status: job.status, detail: job.detail, result: job.result };
  }
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    job.detail = "正在取消任务…";
    job.controller?.abort();
    stopChild(job.child);
  }
  return { installed, install, parse, status, cancel };
}
module.exports = { engineManager, parserArgs, healthCheck };
