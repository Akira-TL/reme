import { access, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL(
  "../../examples/decision/voice_presets/fall_check_in.m4a",
  import.meta.url,
));
const targetDirectory = fileURLToPath(new URL("../public/voice/", import.meta.url));
const target = fileURLToPath(new URL("../public/voice/fall_check_in.m4a", import.meta.url));

await mkdir(targetDirectory, { recursive: true });
try {
  await copyFile(source, target);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  try {
    await access(target);
  } catch {
    throw error;
  }
  console.log(`copy-demo-assets: 源仓库不可见，复用已打包资产 -> ${target}`);
}
