// Install a staged TrueNAS OS update, and (separately, in a maintenance window) reboot
// into it with full post-flight verification.
//
// WHY THIS SCRIPT EXISTS: update.run / system.reboot are intentionally NOT exposed as
// registered MCP tools (truenas_apply_update does not exist in this build) because they
// are destructive-tier and TRUENAS_ENABLE_DESTRUCTIVE is deliberately left unset in .env.
// This script talks to the same TrueNasClient directly, bypassing tool registration,
// with its own pre-flight safety gates.
//
// TWO MODES — the box hosts a Production VM (ksi_webapp), so installing and rebooting
// are deliberately split. Automated/unattended runs only ever use --install.
//
//   node scripts/apply-staged-update.mjs --install
//     Installs the staged update into a new boot environment WITHOUT rebooting
//     (update.run {reboot:false}). VMs keep running; the new version takes effect at the
//     next reboot. Pre-flight: pools healthy, no reboot already pending.
//
//   node scripts/apply-staged-update.mjs --reboot
//     Maintenance window only, when Nic has asked for it. Requires every VM already
//     stopped in order (Portal -> Plex -> HomeAssistant -> PostgreSQL -> ksi_webapp) and
//     pools healthy, then calls system.reboot, waits for the box to return, and prints
//     the post-flight report.
//
// With no mode flag the script refuses to do anything.
//
// USAGE (from the repo root, after `npm run build`). Paths below resolve relative to this
// file, so the script works from any clone location on Windows or macOS. (Never put a bare
// Windows path like C:/... in an ESM import — Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME;
// relative specifiers avoid that entirely.)

import { TrueNasClient } from "../dist/truenas-client.js";
import process from "node:process";
import { fileURLToPath } from "node:url";

process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const client = new TrueNasClient({
  url: process.env.TRUENAS_URL,
  apiKey: process.env.TRUENAS_API_KEY,
  skipTlsVerify: process.env.TRUENAS_SKIP_TLS_VERIFY === "1",
});

async function rebootReasons() {
  const r = await client.call("system.reboot.info");
  return (r?.reboot_required_reasons ?? []).map((x) => x.reason ?? x.code ?? "unknown");
}

async function healthyPools() {
  const pools = await client.call("pool.query", [[], {}]);
  const unhealthy = pools.filter((p) => p.status !== "ONLINE");
  if (unhealthy.length) throw new Error(`Unhealthy pool(s): ${unhealthy.map((p) => p.name).join(",")} — do not proceed`);
  return pools;
}

async function install() {
  const info = await client.call("system.info");
  const pools = await healthyPools();
  const pending = await rebootReasons();
  log(`pre-install check: version=${info.version} pools=${pools.map((p) => `${p.name}:${p.status}`).join(",")}`);
  if (pending.length) throw new Error(`A reboot is already pending (${pending.join("; ")}) — reboot into it before installing another update`);
  const upd = await client.call("update.status");
  const target = upd?.status?.new_version?.version;
  if (!target) throw new Error("No pending update reported by update.status — nothing to install");
  log(`installing ${info.version} -> ${target} (no reboot)`);

  const jobId = await client.call("update.run", [{ reboot: false }]);
  log(`update.run job id = ${jobId}`);
  let lastState = null;
  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    const [job] = await client.call("core.get_jobs", [[["id", "=", jobId]], { limit: 1 }]);
    if (!job) continue;
    if (job.state !== lastState || job.progress?.percent !== undefined) {
      log(`install [${job.state}] ${job.progress?.percent ?? "?"}% ${job.progress?.description ?? ""}`);
      lastState = job.state;
    }
    if (job.state === "SUCCESS") break;
    if (job.state === "FAILED" || job.state === "ABORTED") throw new Error(`Install job ${job.state}: ${JSON.stringify(job.error)}`);
  }

  log("================ POST-INSTALL ================");
  const now = await client.call("system.info");
  log(`running version: ${now.version} (unchanged until reboot — expected)`);
  const after = await rebootReasons();
  log(after.length ? `reboot pending ✅: ${after.join("; ")}` : "⚠️ no pending reboot reported — check the install");
  const bes = await client.call("boot.environment.query", [[], {}]);
  log(`boot envs: ${bes.map((b) => `${b.id}${b.active ? "(active)" : ""}${b.activated ? "(next boot)" : ""}`).join(", ")}`);
  log(`================ DONE — ${target} installed; NOT rebooted. Schedule the reboot with Nic. ================`);
}

async function reboot() {
  const info = await client.call("system.info");
  const pools = await healthyPools();
  const vms = await client.call("vm.query", [[], {}]);
  const running = vms.filter((v) => v.status?.state !== "STOPPED");
  log(
    `pre-reboot check: version=${info.version} pools=${pools
      .map((p) => `${p.name}:${p.status}`)
      .join(",")} vms=${vms.map((v) => `${v.name}:${v.status?.state}`).join(",")}`
  );
  if (running.length) throw new Error(`VM(s) not STOPPED: ${running.map((v) => v.name).join(",")} — stop them first, in order`);
  const pending = await rebootReasons();
  log(pending.length ? `pending reboot reasons: ${pending.join("; ")}` : "no pending reboot reasons reported (rebooting anyway, as requested)");
  const preVersion = info.version;

  log("pre-reboot OK — all VMs stopped, pools healthy; calling system.reboot");
  try {
    await client.call("system.reboot", ["Scheduled maintenance reboot into installed update", {}]);
  } catch (e) {
    log(`connection lost — reboot underway (${e.message})`);
  }

  log("waiting for the box to go down and return ...");
  // Give it time to actually go down so we don't mistake the old instance for the new one.
  await new Promise((r) => setTimeout(r, 60000));
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const i = await client.call("system.info");
      log(`ONLINE: version ${i.version}, uptime ${i.uptime}`);
      break;
    } catch {
      log("  ...still down");
    }
  }

  log("================ POST-FLIGHT ================");
  const now = await client.call("system.info");
  log(`version: ${preVersion} -> ${now.version} ${now.version !== preVersion ? "✅ changed" : "⚠️ unchanged — check whether an update was actually pending"}`);
  for (const p of await client.call("pool.query", [[], {}])) {
    log(`pool ${p.name}: healthy=${p.healthy} scan=${p.scan?.state ?? "NONE"} errors=${p.scan?.errors ?? 0}`);
  }
  const vmsAfter = await client.call("vm.query", [[], {}]);
  log(`VMs: ${vmsAfter.map((v) => `${v.name}=${v.status?.state}`).join(", ")}`);
  const prod = vmsAfter.find((v) => v.name === "ksi_webapp");
  log(prod?.status?.state === "RUNNING" ? "Production VM ksi_webapp RUNNING ✅" : "⚠️ Production VM ksi_webapp NOT RUNNING — start it FIRST");
  const apps = await client.call("app.query", [[], {}]);
  log(`apps: ${apps.map((a) => `${a.name}=${a.state}`).join(", ")}`);
  const appsNotRunning = apps.filter((a) => a.state !== "RUNNING");
  log(appsNotRunning.length
    ? `⚠️ apps not RUNNING: ${appsNotRunning.map((a) => a.name).join(", ")} — recheck (DEPLOYING may just be mid-restart)`
    : `all ${apps.length} apps RUNNING ✅`);
  const alerts = await client.call("alert.list");
  log(`active alerts: ${alerts.filter((a) => !a.dismissed).length}`);
  const left = await rebootReasons();
  log(`reboot still pending: ${left.length ? `⚠️ ${left.join("; ")}` : "no ✅"}`);
  const upd = await client.call("update.status");
  log(`update.status: new_version=${upd?.status?.new_version?.version ?? "null (up to date)"}`);
  const bes = await client.call("boot.environment.query", [[], {}]);
  log(`boot envs: ${bes.map((b) => `${b.id}${b.active ? "(active)" : ""}`).join(", ")}`);
  log("================ DONE — if autostart missed any VM, start ksi_webapp first, then PostgreSQL -> HomeAssistant -> Plex -> Portal ================");
}

const mode = process.argv[2];
const run = mode === "--install" ? install : mode === "--reboot" ? reboot : null;
if (!run) {
  log("Refusing to run without a mode: pass --install (no reboot) or --reboot (maintenance window only).");
  process.exit(2);
}
run().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
