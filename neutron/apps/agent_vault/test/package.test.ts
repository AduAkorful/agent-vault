import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);

// Every public method the manifest declares, with the surface it belongs to.
// query = read panels + agent read tools; update = proposals, approvals, admin.
const QUERY_METHODS = ["getVaultState", "getActivityHistory", "getPendingApprovals"];
const UPDATE_METHODS = [
  "syncBalance",
  "proposeTransfer",
  "proposeSwap",
  "approveTicket",
  "rejectTicket",
  "setDexConfig",
  "recoverSettlementLock",
  "setPolicy",
  "setCircuitBreaker",
];

// The updates that await settlement/sync over the backend_calls capability are
// generated as `async*`; the remaining updates stay synchronous. mogen strips
// the async* from the generated *_Output aliases, but the manifest records it on
// the func entry, so the manifest assertion below splits on this set.
const ASYNC_UPDATE_METHODS = new Set([
  "syncBalance",
  "proposeTransfer",
  "proposeSwap",
  "approveTicket",
]);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

async function readBackend(): Promise<string> {
  return readFile(backendUrl, "utf8");
}

test("agent_vault manifest validates and declares the vault surface", async () => {
  const manifest = await readManifest();
  const result = validate_neutron_conf(manifest);

  expect(result.valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "agent_vault",
    version: 100,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    tiles: [
      {
        id: "dashboard",
        title: "Agent Vault",
        path: "index.html",
        icon: "static/icon.png",
      },
    ],
  });
  // The backend takes no install argument — state comes from the managed
  // memory schema, seeded by its own init().
  expect(manifest).not.toHaveProperty("init_arg");

  for (const method of QUERY_METHODS) {
    expect(manifest.func?.[method]).toMatchObject({ type: "query", async: false });
  }
  for (const method of UPDATE_METHODS) {
    const expectedAsync = ASYNC_UPDATE_METHODS.has(method) ? "async*" : false;
    expect(manifest.func?.[method]).toMatchObject({ type: "update", async: expectedAsync });
  }
});

test("agent_vault emits a build-time schema for every declared method", async () => {
  const manifest = await readManifest();
  const backend = await readBackend();
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);

  expect(artifact.app).toMatchObject({
    id: "agent_vault",
    name: "Agent Vault",
    version: 100,
  });

  // The whole point of the wire-type relocation: every method resolves to a
  // concrete input/output schema (no unresolvable generic or cross-module type).
  for (const method of QUERY_METHODS) {
    expect(artifact.methods[method]?.type).toBe("query");
    expect(artifact.methods[method]?.input).toBeTypeOf("object");
    expect(artifact.methods[method]?.output).toBeTypeOf("object");
  }
  for (const method of UPDATE_METHODS) {
    expect(artifact.methods[method]?.type).toBe("update");
    expect(artifact.methods[method]?.input).toBeTypeOf("object");
    expect(artifact.methods[method]?.output).toBeTypeOf("object");
  }
  expect(Object.keys(artifact.methods).sort()).toEqual(
    [...QUERY_METHODS, ...UPDATE_METHODS].sort()
  );
});

import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";

const packageUrl = new URL("../agent_vault.v0.1.0.neutron", import.meta.url);

test("agent_vault package contains dashboard, service, schema, and Motoko roots", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  expect(Object.keys(unpacked)).toEqual(
    expect.arrayContaining([
      "neutron.json",
      "schema.json",
      "web/index.html",
      "web/main.css",
      "web/main.js",
      "web/service.html",
      "web/service.js",
      "web/static/icon.png",
    ]),
  );

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.manifest.background?.path).toBe("service.html");
  expect(prepared.manifest.capabilities?.backend_calls).toBeDefined();
  expect(prepared.manifest.capabilities?.agent_entrypoints?.entrypoints).toEqual([
    "get_vault_state",
    "get_activity_history",
    "sync_balance",
    "propose_transfer",
  ]);
  expect(prepared.files.some((file) => file.path.startsWith("mo/"))).toBe(true);
});
