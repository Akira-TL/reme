import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";

const source = "/run/reme/relay.dev.vars";
const privateHome = "/tmp/wrangler-home";
const privateEnv = `${privateHome}/relay.dev.vars`;
const stateDirectory = "/var/lib/reme-relay";

mkdirSync(privateHome, { recursive: true, mode: 0o700 });
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
writeFileSync(privateEnv, readFileSync(source), { mode: 0o600 });
chmodSync(privateEnv, 0o600);

const child = spawn(
  "node",
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    "8787",
    "--persist-to",
    stateDirectory,
    "--env-file",
    privateEnv,
    "--log-level",
    "info",
    "--show-interactive-dev-session=false",
  ],
  {
    cwd: "/app",
    env: {
      ...process.env,
      HOME: privateHome,
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
