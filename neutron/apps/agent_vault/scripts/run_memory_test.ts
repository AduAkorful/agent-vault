import path from "node:path";
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
  await compiler.run(prepared.entryPath);
  console.log("Browser Motoko test passed: test/memory_release.test.mo");
} finally {
  await disposeMotokoCompiler();
}
