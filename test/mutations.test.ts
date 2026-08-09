/**
 * Unit tests for the write client methods. These assert the EXACT JSON-RPC
 * method name and params each mutation would send, using a stubbed transport —
 * no real connection is made and nothing is ever sent to a live NAS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TrueNasClient, TrueNasConfig } from "../src/truenas-client.js";

interface Call {
  method: string;
  params: unknown[];
}

function stubClient(overrides: Partial<TrueNasConfig> = {}): { client: TrueNasClient; calls: Call[] } {
  const cfg: TrueNasConfig = {
    url: "https://nas.test",
    apiKey: "1-teststststststststststststststststststststststststststststst",
    skipTlsVerify: true,
    allowHttp: false,
    enableWrite: true,
    enableDestructive: false,
    ...overrides,
  };
  const client = new TrueNasClient(cfg);
  const calls: Call[] = [];
  // Bypass real transport detection + the socket entirely.
  (client as unknown as { detect: () => Promise<unknown> }).detect = async () => ({
    mode: "websocket",
    apiVersions: [],
    maxVersion: null,
  });
  (client as unknown as { call: (m: string, p: unknown[]) => Promise<unknown> }).call = async (
    method: string,
    params: unknown[]
  ) => {
    calls.push({ method, params });
    return { id: `${method}-result` };
  };
  return { client, calls };
}

test("createSnapshot sends pool.snapshot.create with exactly {dataset,name,recursive}", async () => {
  const { client, calls } = stubClient();
  await client.createSnapshot({ dataset: "tank/data", name: "manual-1", recursive: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "pool.snapshot.create");
  assert.deepEqual(calls[0].params, [{ dataset: "tank/data", name: "manual-1", recursive: true }]);
});

test("createSnapshot defaults recursive to false and omits empty properties", async () => {
  const { client, calls } = stubClient();
  await client.createSnapshot({ dataset: "tank/data", name: "snap" });
  assert.deepEqual(calls[0].params, [{ dataset: "tank/data", name: "snap", recursive: false }]);
});

test("createSnapshot includes properties only when provided", async () => {
  const { client, calls } = stubClient();
  await client.createSnapshot({ dataset: "tank/data", name: "snap", properties: { "com.test:x": "1" } });
  assert.deepEqual(calls[0].params, [
    { dataset: "tank/data", name: "snap", recursive: false, properties: { "com.test:x": "1" } },
  ]);
});

test("updateDataset sends pool.dataset.update with [id, data]", async () => {
  const { client, calls } = stubClient();
  await client.updateDataset("tank/data", { comments: "hi", readonly: "ON" });
  assert.equal(calls[0].method, "pool.dataset.update");
  assert.deepEqual(calls[0].params, ["tank/data", { comments: "hi", readonly: "ON" }]);
});

// --- Phase 2: reactive lifecycle ---

test("controlService sends service.control with [verb, name, {}]", async () => {
  const { client, calls } = stubClient();
  await client.controlService("STOP", "smb");
  assert.equal(calls[0].method, "service.control");
  assert.deepEqual(calls[0].params, ["STOP", "smb", {}]);
});

test("setServiceBoot sends service.update with [name, {enable}]", async () => {
  const { client, calls } = stubClient();
  await client.setServiceBoot("smb", true);
  assert.equal(calls[0].method, "service.update");
  assert.deepEqual(calls[0].params, ["smb", { enable: true }]);
});

test("appAction start/stop map to app.<action> with [app_name]", async () => {
  const { client, calls } = stubClient();
  await client.appAction("stop", "prometheus");
  assert.equal(calls[0].method, "app.stop");
  assert.deepEqual(calls[0].params, ["prometheus"]);
});

test("appAction upgrade sends app.upgrade with default app_version=latest", async () => {
  const { client, calls } = stubClient();
  await client.appAction("upgrade", "prometheus");
  assert.equal(calls[0].method, "app.upgrade");
  assert.deepEqual(calls[0].params, ["prometheus", { app_version: "latest" }]);
});

test("appAction rollback sends app.rollback with the given app_version", async () => {
  const { client, calls } = stubClient();
  await client.appAction("rollback", "prometheus", "1.4.13");
  assert.equal(calls[0].method, "app.rollback");
  assert.deepEqual(calls[0].params, ["prometheus", { app_version: "1.4.13" }]);
});

test("vmAction maps to vm.<action> with [id]", async () => {
  const { client, calls } = stubClient();
  await client.vmAction("restart", 3);
  assert.equal(calls[0].method, "vm.restart");
  assert.deepEqual(calls[0].params, [3]);
});

test("runScrub sends pool.scrub.run with [pool] or [pool, threshold]", async () => {
  const a = stubClient();
  await a.client.runScrub("tank");
  assert.deepEqual(a.calls[0].params, ["tank"]);
  const b = stubClient();
  await b.client.runScrub("tank", 7);
  assert.deepEqual(b.calls[0].params, ["tank", 7]);
});
