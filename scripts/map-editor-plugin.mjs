import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const envDir = join(projectRoot, "env");
const publicEnvDir = join(projectRoot, "public", "env");
const PREFIX = "/__map-editor";

/**
 * 地図エディタ (editor.html) 用の開発サーバー API。
 * `vite` 実行時のみ有効で、ビルド成果物には含まれない。
 * @returns {import("vite").Plugin}
 */
export default function mapEditorPlugin() {
  return {
    name: "map-editor",
    apply: "serve",
    // env/ の変更で Vite が全ページをリロードすると、編集中のエディタの状態（undo 履歴など）が消える。
    // 既定のリロードを止め、アプリ本体（src/main.ts）だけが受け取るイベントを送る。
    hotUpdate({ file }) {
      const watched = [envDir, publicEnvDir].map((dir) => normalizePath(dir) + "/");
      if (!watched.some((dir) => file.startsWith(dir))) return;
      if (this.environment.name === "client") {
        this.environment.hot.send({ type: "custom", event: "map-editor:env-changed" });
      }
      return [];
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith(PREFIX)) return next();
        const route = url.pathname.slice(PREFIX.length);
        try {
          if (req.method === "GET" && route === "/mapinfo") {
            // モジュールとして読み込むとファイル保存時にエディタがリロードされるため、生テキストで返す
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            return res.end(readFileSync(join(envDir, "mapinfo.js")));
          }
          if (req.method === "POST" && route === "/mapinfo") {
            // 開発サーバーは /env/mapinfo.js を public/env のコピーから配信するため、両方に書く
            const text = await readBody(req);
            for (const dir of [envDir, publicEnvDir]) {
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, "mapinfo.js"), text);
            }
            return sendJson(res, 200, { ok: true });
          }
          if (req.method === "GET" && route === "/svgs") {
            const dir = join(envDir, "map");
            const files = existsSync(dir)
              ? readdirSync(dir).filter((f) => /\.svg$/i.test(f)).sort()
              : [];
            return sendJson(res, 200, files.map((f) => `map/${f}`));
          }
          if (req.method === "GET" && route.startsWith("/file/map/")) {
            const name = safeSvgName(decodeURIComponent(route.slice("/file/map/".length)));
            const path = join(envDir, "map", name);
            if (!existsSync(path)) return sendJson(res, 404, { error: "not found" });
            res.setHeader("Content-Type", "image/svg+xml");
            res.setHeader("Cache-Control", "no-store");
            return res.end(readFileSync(path));
          }
          if (req.method === "POST" && route === "/svg") {
            const name = safeSvgName(url.searchParams.get("name") ?? "");
            const text = await readBody(req);
            for (const dir of [join(envDir, "map"), join(publicEnvDir, "map")]) {
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, name), text);
            }
            return sendJson(res, 200, { ok: true, floorFile: `map/${name}` });
          }
          sendJson(res, 404, { error: "unknown route" });
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
      });
    },
  };
}

/** @param {string} name */
function safeSvgName(name) {
  const file = basename(name);
  if (!/^[\w.-]+\.svg$/i.test(file)) throw new Error(`不正なファイル名: ${name}`);
  return file;
}

/** @param {import("node:http").IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
