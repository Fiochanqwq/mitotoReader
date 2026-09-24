// Optional network integration: component packages can consume several GB.
const path = require("node:path");
const { engineManager } = require("../app/engines.cjs");
const engine = process.argv[2] || "mineru";
const manager = engineManager(path.join(__dirname, "tmp", "parser-integration"));
(async () => {
  const id = await manager.install(engine, {
    python: path.join(__dirname, "tmp", "python-bootstrap", "python-3.12.10", "tools", "python.exe"),
  });
  let previous = "";
  for (;;) {
    const job = manager.status(id);
    if (job.detail !== previous) {
      console.log(job.detail);
      previous = job.detail;
    }
    if (job.status !== "running") {
      if (job.status !== "done" || !(await manager.installed(engine)))
        throw new Error("Component installation did not complete");
      console.log(`PASS: ${engine} installed and CLI verified`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
