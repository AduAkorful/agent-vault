import { disposeMotokoCompiler } from "neutron-motoko-wasm";
import { packageMotoko } from "neutron-scripts/src/mopack.ts";

try {
  await packageMotoko({
    cwd: process.cwd(),
    packages: {
      core: ".mops/_github/core#v2.6.0/src",
      "neutron-capabilities": "../../packages/neutron-motoko-capabilities/src",
    },
  });
} finally {
  await disposeMotokoCompiler();
}
