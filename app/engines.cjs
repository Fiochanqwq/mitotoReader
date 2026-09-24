const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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
  function run(executable, args, job, timeout = 30 * 60_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      job.child = child;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("解析超时。"));
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
      child.on("exit", (code) => {
        clearTimeout(timer);
        job.child = null;
        if (job.cancelled) reject(new Error("已取消。"));
        else if (code === 0) resolve();
        else reject(new Error(`解析进程退出（${code}）。${job.detail || ""}`));
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
  async function install(engine) {
    validate(engine);
    if ([...jobs.values()].some((job) => job.status === "running")) throw new Error("请等待当前任务结束。");
    const id = randomUUID();
    const job = { id, engine, status: "running", detail: "正在准备独立 Python 环境…", result: null, cancelled: false };
    jobs.set(id, job);
    void (async () => {
      try {
        await fs.mkdir(path.join(root, engine), { recursive: true });
        if (!(await fs.stat(python(engine)).catch(() => null)))
          await run("python", ["-m", "venv", path.join(root, engine)], job);
        if (job.cancelled) return;
        job.detail = "正在安装解析组件；首次安装可能需要较长时间…";
        await run(python(engine), ["-m", "pip", "install", engine === "mineru" ? "mineru>=4,<5" : "docling"], job);
        if (job.cancelled) return;
        await fs.writeFile(marker(engine), "ready\n");
        job.status = "done";
        job.detail = "安装完成。首次解析还可能下载模型文件。";
      } catch (error) {
        job.status = job.cancelled ? "cancelled" : "error";
        job.detail = error.message;
      }
    })();
    return id;
  }
  async function parse(engine, source) {
    validate(engine);
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
          await run(command(engine, "docling"), ["convert", source, "--to", "md", "--output", folder], job);
          const names = (await fs.readdir(folder)).filter((name) => name.endsWith(".md"));
          if (!names.length) throw new Error("Docling 未生成 Markdown 结果。");
          output = path.join(folder, names[0]);
        } else {
          output = path.join(folder, "result.md");
          await run(command(engine, "mineru-kit"), ["parse", source, "-o", output, "--tier", "advanced"], job);
        }
        if (job.cancelled) return;
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
    job.status = "cancelled";
    job.child?.kill();
  }
  return { installed, install, parse, status, cancel };
}
module.exports = { engineManager };
