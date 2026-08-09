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

// --- Phase 3: provisioning (storage + sharing) ---

test("createDataset defaults type=FILESYSTEM and includes only provided optionals", async () => {
  const { client, calls } = stubClient();
  await client.createDataset({ name: "tank/appdata", comments: "app data" });
  assert.equal(calls[0].method, "pool.dataset.create");
  assert.deepEqual(calls[0].params, [{ name: "tank/appdata", type: "FILESYSTEM", comments: "app data" }]);
});

test("createDataset for a zvol includes volsize", async () => {
  const { client, calls } = stubClient();
  await client.createDataset({ name: "tank/vol", type: "VOLUME", volsize: 1073741824 });
  assert.deepEqual(calls[0].params, [{ name: "tank/vol", type: "VOLUME", volsize: 1073741824 }]);
});

test("renameDataset sends pool.dataset.rename with [id, {new_name}]", async () => {
  const { client, calls } = stubClient();
  await client.renameDataset("tank/old", "tank/new", true);
  assert.equal(calls[0].method, "pool.dataset.rename");
  assert.deepEqual(calls[0].params, ["tank/old", { new_name: "tank/new", recursive: true }]);
});

test("createSmbShare sends sharing.smb.create with path+name and provided optionals", async () => {
  const { client, calls } = stubClient();
  await client.createSmbShare({ path: "/mnt/tank/media", name: "media", readonly: true });
  assert.equal(calls[0].method, "sharing.smb.create");
  assert.deepEqual(calls[0].params, [{ path: "/mnt/tank/media", name: "media", readonly: true }]);
});

test("createNfsShare maps readonly to ro and includes networks", async () => {
  const { client, calls } = stubClient();
  await client.createNfsShare({ path: "/mnt/tank/backups", ro: true, networks: ["192.168.0.0/24"] });
  assert.equal(calls[0].method, "sharing.nfs.create");
  assert.deepEqual(calls[0].params, [{ path: "/mnt/tank/backups", networks: ["192.168.0.0/24"], ro: true }]);
});

// --- Phase 3: provisioning (identity + scheduling) ---

test("createUser sends user.create with username/full_name/password/group_create", async () => {
  const { client, calls } = stubClient();
  await client.createUser({ username: "svc", full_name: "Service", password: "s3cret", group_create: true });
  assert.equal(calls[0].method, "user.create");
  assert.deepEqual(calls[0].params, [{ username: "svc", full_name: "Service", password: "s3cret", group_create: true }]);
});

test("setUserPassword sends user.set_password keyed by username", async () => {
  const { client, calls } = stubClient();
  await client.setUserPassword("svc", "n3wpass");
  assert.equal(calls[0].method, "user.set_password");
  assert.deepEqual(calls[0].params, [{ username: "svc", new_password: "n3wpass" }]);
});

test("createGroup sends group.create with name (+optionals)", async () => {
  const { client, calls } = stubClient();
  await client.createGroup({ name: "media", smb: true });
  assert.equal(calls[0].method, "group.create");
  assert.deepEqual(calls[0].params, [{ name: "media", smb: true }]);
});

test("createSnapshotTask sends pool.snapshottask.create with lifetime + schedule", async () => {
  const { client, calls } = stubClient();
  await client.createSnapshotTask({
    dataset: "tank/appdata",
    lifetime_value: 2,
    lifetime_unit: "WEEK",
    schedule: { minute: "0", hour: "0", dom: "*", month: "*", dow: "*" },
  });
  assert.equal(calls[0].method, "pool.snapshottask.create");
  assert.deepEqual(calls[0].params, [
    { dataset: "tank/appdata", lifetime_value: 2, lifetime_unit: "WEEK", schedule: { minute: "0", hour: "0", dom: "*", month: "*", dow: "*" } },
  ]);
});

test("createScrubTask sends pool.scrub.create with numeric pool id", async () => {
  const { client, calls } = stubClient();
  await client.createScrubTask({ pool: 1, threshold: 35, schedule: { minute: "0", hour: "0", dom: "1", month: "*", dow: "*" } });
  assert.equal(calls[0].method, "pool.scrub.create");
  assert.deepEqual(calls[0].params, [
    { pool: 1, threshold: 35, schedule: { minute: "0", hour: "0", dom: "1", month: "*", dow: "*" } },
  ]);
});

// --- Phases 4-5: destructive client methods (method + params only) ---

test("deleteSnapshot sends pool.snapshot.delete", async () => {
  const { client, calls } = stubClient();
  await client.deleteSnapshot("tank/data@s", true);
  assert.equal(calls[0].method, "pool.snapshot.delete");
  assert.deepEqual(calls[0].params, ["tank/data@s", { recursive: true }]);
});

test("deleteDataset sends pool.dataset.delete with options", async () => {
  const { client, calls } = stubClient();
  await client.deleteDataset("tank/old", true, false);
  assert.equal(calls[0].method, "pool.dataset.delete");
  assert.deepEqual(calls[0].params, ["tank/old", { recursive: true, force: false }]);
});

test("rollbackSnapshot sends pool.snapshot.rollback", async () => {
  const { client, calls } = stubClient();
  await client.rollbackSnapshot("tank/data@good", true);
  assert.equal(calls[0].method, "pool.snapshot.rollback");
  assert.deepEqual(calls[0].params, ["tank/data@good", { recursive: true }]);
});

test("deleteUser sends user.delete with delete_group option", async () => {
  const { client, calls } = stubClient();
  await client.deleteUser(5, true);
  assert.equal(calls[0].method, "user.delete");
  assert.deepEqual(calls[0].params, [5, { delete_group: true }]);
});

test("deleteApp sends app.delete with remove_ix_volumes", async () => {
  const { client, calls } = stubClient();
  await client.deleteApp("prometheus", true);
  assert.equal(calls[0].method, "app.delete");
  assert.deepEqual(calls[0].params, ["prometheus", { remove_ix_volumes: true }]);
});
