// Fail fast when node_modules was copied from a different operating system or CPU.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nativeDependencies = ["lightningcss", "@tailwindcss/oxide"];

for (const dependency of nativeDependencies) {
  try {
    require(dependency);
  } catch (error) {
    console.error(
      `check-native-deps: ${dependency} 与 ${process.platform}/${process.arch} 不兼容`,
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

console.log(`check-native-deps: ${process.platform}/${process.arch} OK`);
