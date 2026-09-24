const fs = require("node:fs/promises");
const path = require("node:path");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function assetHandler(root) {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "mitoto:" || url.host !== "app") return new Response("Not found", { status: 404 });
      const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(":"))
        return new Response("Forbidden", { status: 403 });
      // Read packaged assets directly so the renderer's offline filter never intercepts an internal file request.
      return new Response(await fs.readFile(file), {
        headers: {
          "Content-Type": types[path.extname(file)] || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return new Response("Asset unavailable", { status: error.code === "ENOENT" ? 404 : 400 });
    }
  };
}

module.exports = { assetHandler };
