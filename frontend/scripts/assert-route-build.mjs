import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const distRoot = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", distRoot), "utf8"));

const routeKeys = Object.freeze({
  home: "src/apps/home/HomeApp.jsx",
  family: "src/apps/family/FamilyApp.jsx",
  debug: "src/apps/debug/DebugApp.jsx",
});

function collectStaticClosure(entryKey, seen = new Set()) {
  if (seen.has(entryKey)) return seen;
  const entry = manifest[entryKey];
  assert.ok(entry, `missing manifest entry: ${entryKey}`);
  seen.add(entryKey);
  for (const importedKey of entry.imports || []) collectStaticClosure(importedKey, seen);
  return seen;
}

async function closureSource(entryKey) {
  const files = [...collectStaticClosure(entryKey)]
    .map((key) => manifest[key]?.file)
    .filter(Boolean);
  return (await Promise.all(files.map((file) => readFile(new URL(file, distRoot), "utf8")))).join("\n");
}

test("bootstrap keeps all three role surfaces behind dynamic route entries", () => {
  const bootstrap = Object.values(manifest).find((entry) => (
    entry.dynamicImports?.includes(routeKeys.home)
  ));
  assert.ok(bootstrap, "missing shared route bootstrap");
  assert.deepEqual(new Set(bootstrap.dynamicImports), new Set(Object.values(routeKeys)));
  for (const key of Object.values(routeKeys)) {
    assert.equal(manifest[key]?.isDynamicEntry, true, key);
  }
});

test("family initial chunk excludes home camera, monitor, and debug runtimes", async () => {
  const closure = collectStaticClosure(routeKeys.family);
  assert.equal([...closure].some((key) => key.includes("typical-demo")), false);

  const source = await closureSource(routeKeys.family);
  for (const forbidden of [
    "getUserMedia",
    "getDisplayMedia",
    "/api/monitor/claim",
    "/ws/monitor",
    "reme-monitor-v1",
    "RuntimeDebugPanel",
    "triggerDebugScenario",
    "useLiveVideoSource",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("product HTML does not preload a role surface before pathname resolution", async () => {
  const html = await readFile(new URL("index.html", distRoot), "utf8");
  for (const key of Object.values(routeKeys)) {
    const routeFile = manifest[key].file;
    assert.equal(html.includes(routeFile), false, routeFile);
  }
  assert.ok(frontendRoot.endsWith("/frontend/"));
});

test("production preview serves all three pathname entries through the SPA fallback", async (context) => {
  const server = await preview({
    root: frontendRoot,
    configFile: false,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  context.after(() => server.close());
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");

  for (const pathname of ["/home", "/family", "/debug"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(await response.text(), /<div id="root"><\/div>/, pathname);
  }
});
