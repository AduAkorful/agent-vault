import path from "node:path";
import fs from "node:fs";
import { loadMotoko, disposeMotokoCompiler } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.ts";

const appRoot = process.cwd();
const sourcePath = path.resolve(appRoot, "test/memory_release.test.mo");
const compiler = await loadMotoko();
try {
  const packages = {
    core: path.resolve(appRoot, ".mops/_github/core#v2.6.0/src"),
    "neutron-capabilities": path.resolve(appRoot, "../../packages/neutron-motoko-capabilities/src"),
  };
  const prepared = await prepareMotokoProgram({ compiler, sourcePath, packages, allowDangerous: true });
  // Dump the bundled files for debugging
  const cacheDir = path.join(appRoot, ".mops-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const hash of fs.readdirSync(path.join(appRoot, "..", "..", "packages", "neutron-motoko-wasm", "cache")).filter((f) => f.endsWith(".mo"))) {
    const src = path.join(appRoot, "..", "..", "packages", "neutron-motoko-wasm", "cache", hash);
    const dest = path.join(cacheDir, hash);
    try { fs.copyFileSync(src, dest); } catch {}
  }
  await compiler.run(prepared.entryPath);
  console.log("Browser Motoko test passed: test/memory_release.test.mo");
} finally {
  await disposeMotokoCompiler();
}
