// 把 LiteRT.js runtime 从 node_modules 拷到 public/，手机端推理不依赖 CDN。
// predev/prebuild 自动执行；团队自训练的 .tflite 权重作为版本化资产单独入库。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "@litertjs", "core", "wasm");
const target = join(root, "public", "litert", "wasm");

if (!existsSync(source)) {
  console.error("copy-litert: 未找到 @litertjs/core，请先 npm install");
  process.exit(1);
}
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`copy-litert: wasm 已就位 -> ${target}`);
