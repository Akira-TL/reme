// 把 MediaPipe 的 wasm 从 node_modules 拷到 public/，姿态推理零 CDN 依赖。
// predev/prebuild 自动执行；模型 .task 文件已直接入库（npm 拿不到它）。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const target = join(root, "public", "mediapipe", "wasm");

if (!existsSync(source)) {
  console.error("copy-mediapipe: 未找到 @mediapipe/tasks-vision，请先 npm install");
  process.exit(1);
}
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`copy-mediapipe: wasm 已就位 -> ${target}`);
