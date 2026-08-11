import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJsonPath = path.join(frontendRoot, "package.json");
const publicRoot = path.join(frontendRoot, "public");
const sourceRoot = path.join(frontendRoot, "src");

const forbiddenDependencyNames = [
  "@mediapipe/tasks-vision",
  "@tensorflow-models/pose-detection",
  "@tensorflow/tfjs",
  "@tensorflow/tfjs-backend-webgl",
  "@tensorflow/tfjs-backend-webgpu",
];

const forbiddenAssetExtensions = new Set([".task", ".tflite", ".wasm"]);
const forbiddenPublicDirectories = new Set(["litert", "mediapipe"]);
const forbiddenSourcePatterns = [
  [/@mediapipe\/tasks-vision/u, "MediaPipe browser runtime import"],
  [/@tensorflow-models\/pose-detection/u, "TensorFlow pose runtime import"],
  [/\b(?:PoseLandmarker|FilesetResolver|detectForVideo|estimatePoses)\b/u, "browser pose inference API"],
  [/\blandmarks_frame\b/u, "browser-authored landmarks input"],
];

async function collectFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const declaredDependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
  ...packageJson.optionalDependencies,
};
const violations = [];

for (const dependency of forbiddenDependencyNames) {
  if (Object.hasOwn(declaredDependencies, dependency)) {
    violations.push(`package.json declares ${dependency}`);
  }
}

for (const entry of await readdir(publicRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && forbiddenPublicDirectories.has(entry.name)) {
    violations.push(`public/${entry.name}/ is a legacy browser model directory`);
  }
}

for (const assetPath of await collectFiles(publicRoot)) {
  if (forbiddenAssetExtensions.has(path.extname(assetPath).toLowerCase())) {
    violations.push(`${path.relative(frontendRoot, assetPath)} is a browser model/runtime asset`);
  }
}

for (const sourcePath of await collectFiles(sourceRoot)) {
  if (!/\.[cm]?[jt]sx?$/u.test(sourcePath) || sourcePath.endsWith(".test.js")) continue;
  const source = await readFile(sourcePath, "utf8");
  for (const [pattern, description] of forbiddenSourcePatterns) {
    if (pattern.test(source)) {
      violations.push(`${path.relative(frontendRoot, sourcePath)} contains ${description}`);
    }
  }
}

if (violations.length > 0) {
  console.error("browser-pose-boundary: frontend must capture/transport/render only");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("browser-pose-boundary: no browser pose inference code or assets");
