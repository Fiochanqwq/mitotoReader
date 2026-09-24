import { build, Platform, Arch } from "electron-builder";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const prepackaged = resolve("release", `mitotoReader-${pkg.version}-win32-x64`);
await access(resolve(prepackaged, "mitotoReader.exe"));
await build({
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  prepackaged,
  publish: "never",
  config: {
    appId: "io.github.fiochanqwq.mitotoreader",
    productName: "mitotoReader",
    directories: { output: "release/installers", buildResources: "resources" },
    artifactName: "mitotoReader-${version}-Setup.${ext}",
    win: { icon: "resources/icon.ico", signAndEditExecutable: false },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "mitotoReader",
      uninstallDisplayName: "mitotoReader",
      deleteAppDataOnUninstall: false,
      include: "resources/installer.nsh",
      installerLanguages: ["zh_CN", "en_US"],
      displayLanguageSelector: true,
      license: "LICENSE",
    },
  },
});
