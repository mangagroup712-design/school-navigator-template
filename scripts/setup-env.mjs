import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(projectRoot, "env");
const destination = join(projectRoot, "public", "env");

// Windows + Node 24 では非ASCIIパスで cpSync({ recursive: true }) がクラッシュするため手動で再帰コピーする
function copyMissing(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      copyMissing(join(from, entry), join(to, entry));
    }
  } else if (!existsSync(to)) {
    copyFileSync(from, to);
  }
}

copyMissing(source, destination);
