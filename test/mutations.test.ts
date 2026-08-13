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

// ---------------- Phase 2: data-protection actions ----------------

test("cloneSnapshot sends pool.snapshot.clone with {snapshot, dataset_dst}", async () => {
  const { client, calls } = stubClient();
  await client.cloneSnapshot("HDD/data@snap1", "HDD/restore-view");
  assert.equal(calls[0].method, "pool.snapshot.clone");
  assert.deepEqual(calls[0].params, [{ snapshot: "HDD/data@snap1", dataset_dst: "HDD/restore-view" }]);
});

test("runCloudsyncTask / runReplicationTask / runRsyncTask send the right job method with [id]", async () => {
  const { client, calls } = stubClient();
  await client.runCloudsyncTask(2);
  await client.runReplicationTask(3);
  await client.runRsyncTask(4);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["cloudsync.sync", [2]],
    ["replication.run", [3]],
    ["rsynctask.run", [4]],
  ]);
});

test("createRsyncTask includes only provided fields and passes schedule through", async () => {
  const { client, calls } = stubClient();
  await client.createRsyncTask({
    path: "/mnt/HDD/backups",
    user: "root",
    mode: "SSH",
    direction: "PUSH",
    remotehost: "othernas",
    remotepath: "/mnt/tank/in",
    ssh_credentials: 1,
    schedule: { minute: "0", hour: "2", dom: "*", month: "*", dow: "*" },
  });
  assert.equal(calls[0].method, "rsynctask.create");
  assert.deepEqual(calls[0].params, [
    {
      path: "/mnt/HDD/backups",
      user: "root",
      mode: "SSH",
      direction: "PUSH",
      remotehost: "othernas",
      remotepath: "/mnt/tank/in",
      ssh_credentials: 1,
      schedule: { minute: "0", hour: "2", dom: "*", month: "*", dow: "*" },
    },
  ]);
});

test("createRsyncTask omits undefined optionals entirely", async () => {
  const { client, calls } = stubClient();
  await client.createRsyncTask({ path: "/mnt/HDD/x", user: "backup" });
  assert.deepEqual(calls[0].params, [{ path: "/mnt/HDD/x", user: "backup" }]);
});

test("updateRsyncTask sends rsynctask.update with [id, partial-data]", async () => {
  const { client, calls } = stubClient();
  await client.updateRsyncTask(7, { enabled: false });
  assert.equal(calls[0].method, "rsynctask.update");
  assert.deepEqual(calls[0].params, [7, { enabled: false }]);
});

test("deleteRsyncTask / deleteCloudsyncTask / deleteReplicationTask send delete with [id]", async () => {
  const { client, calls } = stubClient({ enableDestructive: true });
  await client.deleteRsyncTask(1);
  await client.deleteCloudsyncTask(2);
  await client.deleteReplicationTask(3);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["rsynctask.delete", [1]],
    ["cloudsync.delete", [2]],
    ["replication.delete", [3]],
  ]);
});

// ---------------- Phase 3: app & VM provisioning ----------------

test("createApp sends app.create with app_name+catalog_app and only provided optionals", async () => {
  const { client, calls } = stubClient();
  await client.createApp({ app_name: "pp", catalog_app: "photoprism", train: "stable", values: { x: 1 } });
  assert.equal(calls[0].method, "app.create");
  assert.deepEqual(calls[0].params, [{ app_name: "pp", catalog_app: "photoprism", train: "stable", values: { x: 1 } }]);
});

test("createApp omits train/version/values when not provided", async () => {
  const { client, calls } = stubClient();
  await client.createApp({ app_name: "pp", catalog_app: "photoprism" });
  assert.deepEqual(calls[0].params, [{ app_name: "pp", catalog_app: "photoprism" }]);
});

test("updateApp sends app.update with [name, {values}]", async () => {
  const { client, calls } = stubClient();
  await client.updateApp("grafana", { foo: "bar" });
  assert.equal(calls[0].method, "app.update");
  assert.deepEqual(calls[0].params, ["grafana", { values: { foo: "bar" } }]);
});

test("createVm sends vm.create including only provided fields", async () => {
  const { client, calls } = stubClient();
  await client.createVm({ name: "testvm", memory: 2048, vcpus: 2, autostart: false });
  assert.equal(calls[0].method, "vm.create");
  assert.deepEqual(calls[0].params, [{ name: "testvm", memory: 2048, vcpus: 2, autostart: false }]);
});

test("updateVm sends vm.update with [id, partial-data]", async () => {
  const { client, calls } = stubClient();
  await client.updateVm(17, { vcpus: 4, description: "hi" });
  assert.equal(calls[0].method, "vm.update");
  assert.deepEqual(calls[0].params, [17, { vcpus: 4, description: "hi" }]);
});

// ---------------- Phase 4: storage & encryption depth ----------------

test("unlockDataset nests the secret under datasets[] and passes recursive", async () => {
  const { client, calls } = stubClient();
  await client.unlockDataset("SSD/PostgreSQL", { passphrase: "s3cr3t", recursive: true });
  assert.equal(calls[0].method, "pool.dataset.unlock");
  assert.deepEqual(calls[0].params, [
    "SSD/PostgreSQL",
    { datasets: [{ name: "SSD/PostgreSQL", passphrase: "s3cr3t" }], recursive: true },
  ]);
});

test("unlockDataset uses key when given instead of passphrase", async () => {
  const { client, calls } = stubClient();
  await client.unlockDataset("SSD", { key: "deadbeef" });
  assert.deepEqual(calls[0].params, ["SSD", { datasets: [{ name: "SSD", key: "deadbeef" }] }]);
});

test("changeDatasetKey sends pool.dataset.change_key with only provided options", async () => {
  const { client, calls } = stubClient();
  await client.changeDatasetKey("SSD", { generate_key: true });
  assert.equal(calls[0].method, "pool.dataset.change_key");
  assert.deepEqual(calls[0].params, ["SSD", { generate_key: true }]);
});

test("encryptionSummary sends pool.dataset.encryption_summary with [id]", async () => {
  const { client, calls } = stubClient();
  await client.encryptionSummary("SSD");
  assert.equal(calls[0].method, "pool.dataset.encryption_summary");
  assert.deepEqual(calls[0].params, ["SSD"]);
});

test("promoteDataset / holdSnapshot / releaseSnapshot send their method with [id]", async () => {
  const { client, calls } = stubClient();
  await client.promoteDataset("HDD/clone");
  await client.holdSnapshot("HDD@keep");
  await client.releaseSnapshot("HDD@keep");
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["pool.dataset.promote", ["HDD/clone"]],
    ["pool.snapshot.hold", ["HDD@keep"]],
    ["pool.snapshot.release", ["HDD@keep"]],
  ]);
});

// ---------------- Phase 5: iSCSI + NVMe-oF provisioning ----------------

test("createIscsiPortal wraps listen IPs as [{ip}]", async () => {
  const { client, calls } = stubClient();
  await client.createIscsiPortal({ listen: ["0.0.0.0", "10.0.0.1"], comment: "c" });
  assert.equal(calls[0].method, "iscsi.portal.create");
  assert.deepEqual(calls[0].params, [{ listen: [{ ip: "0.0.0.0" }, { ip: "10.0.0.1" }], comment: "c" }]);
});

test("createIscsiTarget builds a group only when a portal is given", async () => {
  const { client, calls } = stubClient();
  await client.createIscsiTarget({ name: "t1" });
  assert.deepEqual(calls[0].params, [{ name: "t1" }]);
  await client.createIscsiTarget({ name: "t2", portal: 3 });
  assert.deepEqual(calls[1].params, [{ name: "t2", groups: [{ portal: 3, initiator: null, auth: null, authmethod: "NONE" }] }]);
});

test("createIscsiExtent defaults type=DISK and passes disk", async () => {
  const { client, calls } = stubClient();
  await client.createIscsiExtent({ name: "e1", disk: "zvol/SSD/lun0" });
  assert.equal(calls[0].method, "iscsi.extent.create");
  assert.deepEqual(calls[0].params, [{ name: "e1", type: "DISK", disk: "zvol/SSD/lun0" }]);
});

test("createIscsiTargetExtent sends target+extent (+lunid)", async () => {
  const { client, calls } = stubClient();
  await client.createIscsiTargetExtent({ target: 1, extent: 2, lunid: 0 });
  assert.deepEqual(calls[0].params, [{ target: 1, extent: 2, lunid: 0 }]);
});

test("deleteIscsi maps resource -> method and rejects unknown", async () => {
  const { client, calls } = stubClient({ enableDestructive: true });
  await client.deleteIscsi("targetextent", 5);
  await client.deleteIscsi("portal", 2);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["iscsi.targetextent.delete", [5]],
    ["iscsi.portal.delete", [2]],
  ]);
  await assert.rejects(() => client.deleteIscsi("bogus", 1));
});

test("createNvmeNamespace sends subsys_id/device_type/device_path", async () => {
  const { client, calls } = stubClient();
  await client.createNvmeNamespace({ subsys_id: 1, device_type: "ZVOL", device_path: "zvol/SSD/ns0" });
  assert.equal(calls[0].method, "nvmet.namespace.create");
  assert.deepEqual(calls[0].params, [{ subsys_id: 1, device_type: "ZVOL", device_path: "zvol/SSD/ns0" }]);
});

test("createNvmePortSubsys links port+subsys", async () => {
  const { client, calls } = stubClient();
  await client.createNvmePortSubsys({ port_id: 1, subsys_id: 2 });
  assert.deepEqual(calls[0].params, [{ port_id: 1, subsys_id: 2 }]);
});

test("deleteNvme maps resource -> method and rejects unknown", async () => {
  const { client, calls } = stubClient({ enableDestructive: true });
  await client.deleteNvme("port_subsys", 9);
  await client.deleteNvme("subsys", 1);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["nvmet.port_subsys.delete", [9]],
    ["nvmet.subsys.delete", [1]],
  ]);
  await assert.rejects(() => client.deleteNvme("bogus", 1));
});

// ---------------- Phase 6: identity, access & certificates ----------------

test("users/groups pass a local filter only when localOnly is true", async () => {
  const { client, calls } = stubClient();
  await client.users(true);
  await client.users(false);
  await client.groups(true);
  assert.deepEqual(calls[0], { method: "user.query", params: [[["local", "=", true]], {}] });
  assert.deepEqual(calls[1], { method: "user.query", params: [[], {}] });
  assert.deepEqual(calls[2], { method: "group.query", params: [[["local", "=", true]], {}] });
});

test("createApiKey sends api_key.create with {name, username}", async () => {
  const { client, calls } = stubClient();
  await client.createApiKey("automation", "truenas_admin");
  assert.equal(calls[0].method, "api_key.create");
  assert.deepEqual(calls[0].params, [{ name: "automation", username: "truenas_admin" }]);
});

test("updateApiKey / deleteApiKey send the right method", async () => {
  const { client, calls } = stubClient({ enableDestructive: true });
  await client.updateApiKey(3, { reset: true });
  await client.deleteApiKey(3);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["api_key.update", [3, { reset: true }]],
    ["api_key.delete", [3]],
  ]);
});

test("createCertificate keeps create_type and only provided fields", async () => {
  const { client, calls } = stubClient();
  await client.createCertificate({ name: "web", create_type: "CERTIFICATE_CREATE_IMPORTED", certificate: "PEM", privatekey: "KEY" });
  assert.equal(calls[0].method, "certificate.create");
  assert.deepEqual(calls[0].params, [{ name: "web", create_type: "CERTIFICATE_CREATE_IMPORTED", certificate: "PEM", privatekey: "KEY" }]);
});

// ---------------- Phase 7: non-network config mutation ----------------

test("config singleton updaters target the right method with [data]", async () => {
  const { client, calls } = stubClient();
  await client.updateSystemGeneral({ timezone: "UTC" });
  await client.updateSystemAdvanced({ motd: "hi" });
  await client.updateEmail({ fromname: "NAS" });
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["system.general.update", [{ timezone: "UTC" }]],
    ["system.advanced.update", [{ motd: "hi" }]],
    ["mail.update", [{ fromname: "NAS" }]],
  ]);
});

test("init/ntp/cron create+update target their methods with [data] / [id, data]", async () => {
  const { client, calls } = stubClient();
  await client.createInitScript({ type: "COMMAND", when: "POSTINIT", command: "true" });
  await client.updateInitScript(1, { enabled: false });
  await client.createNtpServer({ address: "pool.ntp.org" });
  await client.updateNtpServer(2, { prefer: true });
  await client.createCronJob({ command: "true", user: "root" });
  await client.updateCronJob(3, { enabled: false });
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["initshutdownscript.create", [{ type: "COMMAND", when: "POSTINIT", command: "true" }]],
    ["initshutdownscript.update", [1, { enabled: false }]],
    ["system.ntpserver.create", [{ address: "pool.ntp.org" }]],
    ["system.ntpserver.update", [2, { prefer: true }]],
    ["cronjob.create", [{ command: "true", user: "root" }]],
    ["cronjob.update", [3, { enabled: false }]],
  ]);
});

test("tunable create/update use tunable.* (as jobs)", async () => {
  const { client, calls } = stubClient();
  await client.createTunable({ type: "SYSCTL", var: "vm.swappiness", value: "60" });
  await client.updateTunable(1, { value: "50" });
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["tunable.create", [{ type: "SYSCTL", var: "vm.swappiness", value: "60" }]],
    ["tunable.update", [1, { value: "50" }]],
  ]);
});

test("deleteConfig maps resource -> method and rejects unknown", async () => {
  const { client, calls } = stubClient({ enableDestructive: true });
  await client.deleteConfig("init_script", 7);
  await client.deleteConfig("ntp_server", 4);
  await client.deleteConfig("cron_job", 1);
  await client.deleteConfig("tunable", 2);
  assert.deepEqual(calls.map((c) => [c.method, c.params]), [
    ["initshutdownscript.delete", [7]],
    ["system.ntpserver.delete", [4]],
    ["cronjob.delete", [1]],
    ["tunable.delete", [2]],
  ]);
  await assert.rejects(() => client.deleteConfig("bogus", 1));
});

test("downloadUpdate submits update.download with no params (download-only, as a job)", async () => {
  const { client, calls } = stubClient();
  await client.downloadUpdate();
  assert.equal(calls[0].method, "update.download");
  assert.deepEqual(calls[0].params, []);
});
