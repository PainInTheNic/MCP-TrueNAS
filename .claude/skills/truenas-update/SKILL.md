---
name: truenas-update
description: Check for and apply TrueNAS SCALE OS + app updates, with ordered VM shutdown, verification, and change-management documentation. Use when the user asks to check for TrueNAS/app updates, apply an update, run the update cycle, or perform the scheduled maintenance reboot on the truenas box (192.168.0.253).
user-invocable: true
---

# /truenas-update — TrueNAS Update Cycle (OS + Apps)

Runs the full, repeatable update procedure for Nic's TrueNAS SCALE box: check what's
pending, apply app updates, **install** the OS update without rebooting, notify Nic,
and — only when Nic asks, in a maintenance window — do the ordered VM shutdown →
reboot → verify. A Change Management record goes into Google Drive for every change
made — no change is too minor to document (see `feedback-document-every-change`
memory).

> **The box hosts a Production VM (`ksi_webapp`, id 18) since 2026-10-01. The host
> is NEVER rebooted automatically.** Routine/unattended runs stop after installing the
> OS update and tell Nic a reboot is pending. The reboot (Step 4) runs only when Nic
> explicitly asks for it in this conversation or schedules it directly.

This skill exists so the procedure is **mechanical, not re-derived**. Every command
shape, tool-param name, and gotcha below was hard-won across real runs (2026-08-13,
2026-09-02) — follow it exactly rather than improvising from first principles.

Arguments passed: `$ARGUMENTS`

## Dispatch on arguments

- **No args / "full" / "update"** → Steps 1–3 and 5–6: check, apply apps, install OS
  update if pending (no reboot), document, notify. **Never Step 4.**
- **"check" / "status" / "dry-run"** → Step 1 only. Report what's pending (including
  a pending reboot). Make no changes, file no CM doc.
- **"apps" / "apps-only"** → Step 1 + Step 2 only. Skip the OS update even if one is
  pending (report it as still pending).
- **"os" / "os-only"** → Step 1 + Step 3 only (skip app updates even if pending).
- **"reboot" / "maintenance"** → Step 4 only (plus its CM doc and report). Only when
  Nic has asked for the reboot. Never inferred from a routine/scheduled prompt that
  merely says "install updates".

---

## Step 1 — Check what's pending

```
truenas_check_updates            (OS: current version, new version if any, reboot_required)
truenas_list_apps                (apps: upgrade_available per app)
```

- If `reboot_required: true` — a previously installed update is still waiting on its
  reboot. Do **not** install another OS update on top of it (the script refuses anyway).
  Include "reboot still pending since <date of the install CM doc>" in the report to
  Nic every run until it's done.
- If nothing is pending and no reboot is pending: tell Nic the system is fully current
  and stop. No CM doc for "nothing happened."

Installed apps on this box (as of 2026-10-05): `komodo`, `open-speed-test`,
`tailscale`, `grafana`. This list is informational only — `truenas_list_apps` is the
source of truth. **Update every app it returns, including new or unlisted ones**
(Nic's standing instruction, 2026-10-05); never skip or hold an app because it isn't
named here. If the list differs, still apply the updates, then mention the
difference in the report so this line can be refreshed.

VMs on this box (as of 2026-10-01): `homeassistant=1, plex=3, postgresql=11,
portal=14, ksi_webapp=18` (Production). Same rule — if `truenas_list_vms` shows a VM
not listed here, mention it to Nic and **don't run Step 4** until its place in the
shutdown order is known.

## Step 2 — Apply app updates (do this before the OS update — lower risk, isolates failures)

App upgrades restart only that app's containers, not the host or any VM, so they stay
automatic. For **every** app with `upgrade_available: true` (whether or not it's in
the list above):

```
truenas_manage_app app=<name> action=upgrade
```

This runs as a job (TrueNAS auto-snapshots the app first). Poll with
`truenas_list_jobs` or re-check `truenas_get_app app=<name>` until `state=RUNNING`
and `upgrade_available=false`. A brief `DEPLOYING` state between `STOPPED`→`RUNNING`
is normal — don't report failure on that alone; check again a few seconds later.

File a CM doc for each app updated (template at the bottom of this file) before
moving to Step 3.

## Step 3 — Install the OS update (if one is pending) — NO reboot

### 3a. Stage it (non-destructive)

```
truenas_download_update
```

### 3b. Pre-flight gate — do NOT proceed unless all of these are clean

```
truenas_list_pools                          → both SSD and HDD: status=ONLINE, healthy=true
truenas_list_alerts min_level=WARNING       → count: 0
truenas_list_jobs state=RUNNING             → count: 0
```

If any of these fail the gate, **stop and tell Nic**.

### 3c. Install into a new boot environment (VMs keep running)

```bash
node scripts/apply-staged-update.mjs --install
```

Invoke it as that **exact bare command — no `cd` prefix, no wrapper, no other flag**.
The session's working directory is already the repo root, and the permission
allowlist entry is exactly `Bash(node scripts/apply-staged-update.mjs --install)`;
anything else stalls an unattended run on a prompt. (`--reboot` is deliberately *not*
allowlisted — see Step 4.) Run it via Bash with `timeout: 600000`; it usually finishes
in a few minutes.

The script: checks pools are healthy and no reboot is already pending, runs
`update.run({reboot:false})` and polls the job to `SUCCESS`, then confirms
`system.reboot.info` now reports a pending reboot and lists boot environments.
Running version stays unchanged until reboot — that's expected.

Note the consequence: from here on, **any** reboot (power blip, manual, crash) boots
into the new version. That's accepted — it's the point of installing ahead of the
window, and the prior BE stays available for rollback.

### 3d. Notify Nic

File the install CM doc (Status: `Installed - reboot pending`), then make the report
lead with: **"OS <old> → <new> installed, reboot pending — tell me when to run the
maintenance reboot."** Stop there. Don't stop VMs, don't reboot, don't create a
scheduled task for the reboot unless Nic asks.

## Step 4 — Maintenance reboot (ONLY when Nic asks)

Run this only on Nic's explicit request (e.g. "do the TrueNAS reboot now", or a
one-time scheduled task Nic asked you to create for a specific window).

### 4a. Pre-flight gate

Same three checks as 3b (pools, alerts, running jobs — never reboot mid-scrub or
mid-replication), plus `truenas_check_updates` → `reboot_required: true` (if not,
confirm with Nic that a plain reboot is still wanted). If anything fails, stop and tell
Nic.

### 4b. Shut down VMs — exact order, verify STOPPED before each next step

**Portal → Plex → HomeAssistant → PostgreSQL → ksi_webapp (Production, last)**.
Dependents go before PostgreSQL so it can checkpoint cleanly; ksi_webapp runs its own
dependencies and goes last to minimize Production downtime.

```
truenas_manage_vm id=14 action=stop   → poll truenas_list_vms until portal STOPPED
truenas_manage_vm id=3  action=stop   → poll until plex STOPPED (can take up to ~90s, that's normal)
truenas_manage_vm id=1  action=stop   → poll until homeassistant STOPPED
truenas_manage_vm id=11 action=stop   → poll until postgresql STOPPED
truenas_manage_vm id=18 action=stop   → poll until ksi_webapp STOPPED   ← start of Production downtime
```

If a VM won't reach `STOPPED` within ~2 minutes, **halt and investigate** — do not
force-kill, especially not PostgreSQL or ksi_webapp. If you halt after some VMs are
down, restart them (ksi_webapp first) so nothing stays down while you wait on Nic.

### 4c. Reboot

```bash
node scripts/apply-staged-update.mjs --reboot
```

Same bare-command rule as 3c. It is not allowlisted, so it prompts in an interactive
session (Nic is present — that's the confirmation). If Nic asked for an **unattended**
scheduled reboot, add `Bash(node scripts/apply-staged-update.mjs --reboot)` to
`.claude/settings.local.json` for that window and remove it again in the post-reboot
run.

Run via Bash with `run_in_background: true` and `timeout: 600000` (typically 5–8
minutes). Do one early read of the output a few seconds in to confirm pre-flight
passed, then **wait for the completion notification** — don't poll with repeated
sleeps.

The script refuses unless every VM is `STOPPED` and pools are healthy, calls
`system.reboot`, treats the dropped WebSocket as "reboot underway", waits up to 15 min
for `system.info` to answer, then prints the post-flight report.

### 4d. Post-flight verification

- [ ] **ksi_webapp `RUNNING` first** — the script flags it. If it isn't running,
      start it immediately (`truenas_manage_vm id=18 action=start`) before anything
      else.
- [ ] Version changed to the target (`⚠️ unchanged` = failure needing investigation).
- [ ] Both pools healthy, 0 scan errors.
- [ ] All 5 VMs `RUNNING` — all have `autostart=true`, and TrueNAS starts them
      together, so normally nothing to do. If any still need a manual start after a
      couple of minutes: **ksi_webapp first**, then PostgreSQL → HomeAssistant →
      Plex → Portal.
- [ ] All apps `RUNNING` (every app `truenas_list_apps` returns — currently `komodo`,
      `open-speed-test`, `tailscale`, `grafana`). A
      `DEPLOYING` blip is normal — recheck with `truenas_get_app`.
- [ ] 0 active alerts; no reboot still pending; `update.status` fully current.

## Step 5 — File Change Management records

**Every change gets its own CM doc** — each app upgrade, the OS install, and the
maintenance reboot are separate records (the reboot record references the install
record's CHG number). No skipping "minor" ones (see `feedback-document-every-change`
memory — this was corrected once already, don't repeat it).

Use the Google Drive MCP `create_file` tool. **Exact parameter names** (a past
attempt failed twice by guessing `name`/`content` instead of the real schema):

```
title:            "<CHG-YYYY.MM.DD-NNN description>"   (also embed the same as an H1 inside textContent)
parentId:         1YcAyiuJxiTKkr_uLY6sfTn0WuOPY52o5     (2026 CM folder — if the
                   calendar year has rolled over, find/confirm the current year's
                   folder under the CM root before using this id blindly)
contentMimeType:  text/markdown
textContent:      <the CM doc body, markdown — see template below>
```

Number sequentially per day: `-001`, `-002`, ... across *all* changes made that day
(apps, OS install and reboot share the same daily counter — check what's already in
the folder for that date if picking up a partial day).

### CM doc template

```markdown
# CHG-YYYY.MM.DD-NNN: <short title>

Date: YYYY-MM-DD Category: Infrastructure Risk Level: <Low|Medium> Status: <Completed - verified | Installed - reboot pending>
Performed By: Claude Code (AI Agent) via mcp-truenas Approved By: Nic

## 1. Description and Background
<why this change happened — routine check, what was found pending; for a reboot, the install CHG it completes>

## 2. Changes Made
| Item | Before | After | Result |
|---|---|---|---|
| ... | ... | ... | Success |

## 3. Commands Executed (MCP-Style)
<the actual tool calls / script invocation, in sequence>

## 4. Verification and Validation
<what was checked post-change and what it showed; for reboots, Production (ksi_webapp) downtime window>

## 5. Regression Risk and Rollback Plan
<risk level and why; rollback steps — for OS updates, the retained prior boot environment>

---
Document generated by Claude Code - YYYY-MM-DD
```

## Step 6 — Report back to Nic

Concise summary: what was checked, what was updated (before → after versions), that
verification passed, and links to the CM doc(s) filed. If an OS update is installed
and awaiting reboot, say so first. Mention explicitly if anything needed manual
intervention (a VM that didn't autostart, an app that didn't settle, etc.) even if it
was resolved.

---

## Standing safety rules (apply throughout, not just during updates)

- **Never reboot the host outside Step 4**, and never run Step 4 without Nic's
  explicit request. This includes not enabling `TRUENAS_ENABLE_DESTRUCTIVE` to reach
  `truenas_apply_update` (which reboots unconditionally).
- **Never dump `.env` raw** (`cat`, `grep` without airtight redaction) to check a
  value — a redaction pattern failing silently leaked the live TrueNAS API key into
  a conversation once already. Check presence/length only:
  `node -e "process.loadEnvFile('.env'); console.log(!!process.env.KEY)"`.
- **If TrueNAS connectivity drops mid-operation**, don't assume the host is down.
  Check `truenas_connection_status`, and if that also fails, ping `192.168.0.253`
  directly. If the *user's own machine* is on Tailscale, ask if that's routing
  around the LAN path first — this caused a false "host is down" alarm once. Only
  escalate to "check the physical machine" if ping also fails and the user isn't on
  a VPN that could explain it.
- **Never force-kill a VM**, especially PostgreSQL or ksi_webapp — halt and ask if
  graceful shutdown stalls.
- **If a pool is unhealthy, there are active alerts, or a job is running** at a
  pre-flight gate, stop and report.
- **Pushing repo changes** (if this script or skill itself is edited) uses the
  `PainInTheNic` GitHub account, which is the only `gh` login and is wired into git
  via `gh auth setup-git` — a plain `git push origin main` works. `gh` lives at
  `/opt/homebrew/bin/gh`, which may not be on the shell's PATH.
- **Rollback** (OS only): the prior version stays as a boot environment. Reboot,
  select it at the boot menu, reactivate if desired via System → Boot → Boot
  Environments. No data restore needed. Before the reboot has happened, an installed
  update can be backed out by re-activating the current BE in that same screen.
  Full detail in `TrueNAS-OS-Update-Runbook.md` Part 5.

## Reference files

- `TrueNAS-OS-Update-Runbook.md` (repo-adjacent; lived in `C:\Users\Nic\Documents\Claude\`
  on the old Windows PC — not yet copied to this Mac) — the longer-form narrative
  runbook this skill is distilled from. Predates the no-auto-reboot rule; where they
  differ, this skill wins.
- `scripts/apply-staged-update.mjs` — `--install` / `--reboot` script, committed to
  this repo. Fix bugs in place rather than reconstructing the call sequence from
  scratch if TrueNAS's API shape ever changes.
