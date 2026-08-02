import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL(
  "../../examples/decision/voice_presets/fall_check_in.m4a",
  import.meta.url,
));
const targetDirectory = fileURLToPath(new URL("../public/voice/", import.meta.url));
const target = fileURLToPath(new URL("../public/voice/fall_check_in.m4a", import.meta.url));

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
