// Apply a TrueNAS OS update that has already been staged (truenas_download_update /
// System > Update > Download), and monitor it through the reboot.
//
// WHY THIS SCRIPT EXISTS: update.run is intentionally NOT exposed as a registered MCP
// tool (truenas_apply_update does not exist in this build) because it is destructive-tier
// (reboots the box) and TRUENAS_ENABLE_DESTRUCTIVE is deliberately left unset in .env.
// This script talks to the same TrueNasClient directly, bypassing tool registration,
// with its own pre-flight safety gate. See docs/TrueNAS-OS-Update-Runbook.md Part 3.
//
// PRE-REQUISITE: all VMs must already be stopped in the documented order
// (Portal -> Plex -> HomeAssistant -> PostgreSQL) before running this. The script's
// pre-flight will refuse to proceed if any VM is still RUNNING or any pool is unhealthy.
//
// USAGE (from the repo root, after `npm run build`):
//   node scripts/apply-staged-update.mjs
//
// Paths below resolve relative to this file, so the script works from any clone location
// on Windows or macOS. (Never put a bare Windows path like C:/... in an ESM import — Node
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME; relative specifiers avoid that entirely.)

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

async function preflight() {
  const info = await client.call("system.info");
  const pools = await client.call("pool.query", [[], {}]);
  const vms = await client.call("vm.query", [[], {}]);
  const unhealthy = pools.filter((p) => p.status !== "ONLINE");
  const running = vms.filter((v) => v.status?.state === "RUNNING");
  log(
    `pre-fire check: version=${info.version} pools=${pools
      .map((p) => `${p.name}:${p.status}`)
      .join(",")} vms=${vms.map((v) => `${v.name}:${v.status?.state}`).join(",")}`
  );
  if (unhealthy.length) throw new Error(`Unhealthy pool(s): ${unhealthy.map((p) => p.name).join(",")} — do not proceed`);
  if (running.length) throw new Error(`VM(s) still running: ${running.map((v) => v.name).join(",")} — stop them first, in order`);
  return info.version;
}

async function applyAndMonitor() {
  const preVersion = await preflight();
  log("pre-fire OK — all VMs stopped, pools healthy");

  const jobId = await client.call("update.run", [{ reboot: true }]);
  log(`update.run job id = ${jobId}`);

  let lastState = null;
  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    let job;
    try {
      const jobs = await client.call("core.get_jobs", [[["id", "=", jobId]], { limit: 1 }]);
      job = jobs[0];
    } catch (e) {
      log(`connection lost — reboot underway (${e.message})`);
      break;
    }
    if (!job) continue;
    if (job.state !== lastState || job.progress?.percent !== undefined) {
      log(`apply [${job.state}] ${job.progress?.percent ?? "?"}% ${job.progress?.description ?? ""}`);
      lastState = job.state;
    }
    if (job.state === "SUCCESS" || job.state === "FAILED" || job.state === "ABORTED") {
      if (job.state !== "SUCCESS") throw new Error(`Update job ${job.state}: ${JSON.stringify(job.error)}`);
      break;
    }
  }

  log("waiting for the box to reboot and return ...");
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const info = await client.call("system.info");
      log(`ONLINE: version ${info.version}, uptime ${info.uptime}`);
      break;
    } catch {
      log("  ...still down");
    }
  }

  log("================ POST-FLIGHT ================");
  const info = await client.call("system.info");
  log(`version: ${preVersion} -> ${info.version} ${info.version !== preVersion ? "✅ changed" : "⚠️ unchanged — check for failure"}`);
  const pools = await client.call("pool.query", [[], {}]);
  for (const p of pools) {
    log(`pool ${p.name}: healthy=${p.healthy} scan=${p.scan?.state ?? "NONE"} errors=${p.scan?.errors ?? 0}`);
  }
  const vms = await client.call("vm.query", [[], {}]);
  log(`VMs: ${vms.map((v) => `${v.name}=${v.status?.state}`).join(", ")}`);
  const apps = await client.call("app.query", [[], {}]);
  log(`apps: ${apps.map((a) => `${a.name}=${a.state}`).join(", ")}`);
  const appsNotRunning = apps.filter((a) => a.state !== "RUNNING");
  log(appsNotRunning.length
    ? `⚠️ apps not RUNNING: ${appsNotRunning.map((a) => a.name).join(", ")} — recheck (DEPLOYING may just be mid-restart)`
    : `all ${apps.length} apps RUNNING ✅`);
  const alerts = await client.call("alert.list");
  const active = alerts.filter((a) => !a.dismissed);
  log(`active alerts: ${active.length}`);
  const upd = await client.call("update.status");
  log(`update.status: new_version=${upd?.status?.new_version?.version ?? "null (up to date)"}`);
  const bes = await client.call("boot.environment.query", [[], {}]);
  log(`boot envs: ${bes.map((b) => `${b.id}${b.active ? "(active)" : ""}`).join(", ")}`);
  log("================ DONE — remember to start VMs in reverse order (PostgreSQL -> HomeAssistant -> Plex -> Portal) if autostart didn't ================");
}

applyAndMonitor().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
