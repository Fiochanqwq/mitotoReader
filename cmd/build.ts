import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { prepareRuntime } from "../app/runtime.cjs";
import { existsSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
if (process.platform === "win32") prepareRuntime(resolve("node_modules/electron/dist"));
const modelRevision = "87416418657359cb625c412a48b6e1d6d41c29bd";
const models = ["eng", "chi_sim", "chi_tra", "jpn", "jpn_vert"];
const modelRoot = "resources/models";
await mkdir(modelRoot, { recursive: true });
const lockPath = "resources/models.lock.json";
const lock = await readFile(lockPath, "utf8")
  .then(JSON.parse)
  .catch(() => ({}));
for (const name of [...models.map((x) => x + ".traineddata"), "LICENSE"]) {
  const source = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${modelRevision}/${name}`;
  const target = join(modelRoot, name);
  let data = await readFile(target).catch(() => null);
  if (!data) {
    console.log(`Downloading official OCR asset: ${name}`);
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (lock[name] && lock[name].sha256 !== sha256) throw new Error(`Model checksum mismatch: ${name}`);
  lock[name] = { ...lock[name], source, sha256, bytes: data.length };
  await writeFile(target, data);
}
await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");

await mkdir("build", { recursive: true });
const result = await build({
  entryPoints: ["ui/main.js"],
  bundle: true,
  outdir: "build",
  format: "esm",
  platform: "browser",
  target: "chrome144",
  minify: true,
  metafile: true,
  legalComments: "linked",
  loader: { ".svg": "dataurl", ".png": "dataurl", ".gif": "dataurl" },
  plugins: [
    {
      name: "readium-css-text",
      setup(api) {
        api.onLoad({ filter: /ReadiumCSS-after\.css$/ }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
await cp("ui/index.html", "build/index.html");
await cp("resources/icon.png", "build/icon.png");
await mkdir("build/pdf", { recursive: true });
await cp("node_modules/pdfjs-dist/build/pdf.worker.mjs", "build/pdf/pdf.worker.mjs");
for (const folder of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${folder}`, `build/pdf/${folder}`, { recursive: true });
await mkdir("build/ocr/core", { recursive: true });
await cp("node_modules/tesseract.js/dist/worker.min.js", "build/ocr/worker.min.js");
await cp("node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt", "build/ocr/worker.min.js.LICENSE.txt");
for (const name of await readdir("node_modules/tesseract.js-core")) {
  if (/\.wasm(\.js)?$/.test(name)) await cp(join("node_modules/tesseract.js-core", name), join("build/ocr/core", name));
}
await cp(modelRoot, "build/ocr/models", { recursive: true });
await cp(lockPath, "build/ocr/models.lock.json");
await cp("resources/notices", "build/licenses/ocr-core-dependencies", { recursive: true });

const packages = new Set(["tesseract.js", "tesseract.js-core", "pdfjs-dist", "@readium/css"]);
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll("\\", "/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
const inventory = [];
for (const name of [...packages].sort()) {
  const dir = join("node_modules", name);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  inventory.push({ name, version: pkg.version, license: pkg.license, repository: pkg.repository });
  const target = join("build/licenses", name.replace("/", "__"));
  await mkdir(target, { recursive: true });
  for (const file of await readdir(dir))
    if (/^(licen[sc]e|copying|notice)/i.test(file)) await cp(join(dir, file), join(target, file), { recursive: true });
}
await writeFile("build/components.json", JSON.stringify(inventory, null, 2) + "\n");
await cp(
  "node_modules/tesseract.js/dist/tesseract.min.js.LICENSE.txt",
  "build/licenses/tesseract.js/bundled-LICENSE.txt",
);
console.log("Built mitotoReader with local PDF, EPUB and OCR assets.");

if (process.argv.includes("--package")) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const output = resolve("release", `mitotoReader-${pkg.version}-win32-x64`);
  if (existsSync(join(output, "mitoto-data")))
    throw new Error("Package directory contains reader data; choose a fresh output.");
  await cp("node_modules/electron/dist", output, { recursive: true });
  await rename(join(output, "electron.exe"), join(output, "mitotoReader.exe"));
  const { resedit } = await import("@electron/packager/resedit");
  await resedit(join(output, "mitotoReader.exe"), {
    iconPath: resolve("resources/icon.ico"),
    fileVersion: `${pkg.version.split("-")[0]}.0`,
    productVersion: `${pkg.version.split("-")[0]}.0`,
    productName: "mitotoReader",
    win32Metadata: {
      FileDescription: "mitotoReader",
      ProductName: "mitotoReader",
      OriginalFilename: "mitotoReader.exe",
      InternalName: "mitotoReader",
    },
  });
  prepareRuntime(output);
  const appDir = join(output, "resources/app");
  await mkdir(appDir, { recursive: true });
  await cp("app", join(appDir, "app"), { recursive: true });
  await cp("build", join(appDir, "build"), { recursive: true });
  await writeFile(
    join(appDir, "package.json"),
    JSON.stringify({
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      main: pkg.main,
      license: pkg.license,
    }),
  );
  await cp("LICENSE", join(output, "LICENSE-mitotoReader"));
  for (const name of ["README.md", "THIRD-PARTY.md", "TESTING.md"]) await cp(name, join(output, name));
  await cp("docs", join(output, "docs"), { recursive: true });
  await writeFile(join(output, "portable.txt"), "Settings are stored in mitoto-data beside this executable.\n");
  console.log(output);
}
