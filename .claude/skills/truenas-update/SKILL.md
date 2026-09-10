---
name: truenas-update
description: Check for and apply TrueNAS SCALE OS + app updates, with ordered VM shutdown, verification, and change-management documentation. Use when the user asks to check for TrueNAS/app updates, apply an update, or run the update cycle on the truenas box (192.168.0.253).
user-invocable: true
---

# /truenas-update — TrueNAS Update Cycle (OS + Apps)

Runs the full, repeatable update procedure for Nic's TrueNAS SCALE box: check what's
pending, apply app updates, apply the OS update (staged download → ordered VM
shutdown → apply+reboot → verify), and file a Change Management record in Google
Drive for every change made — no change is too minor to document (see
`feedback-document-every-change` memory).

This skill exists so the procedure is **mechanical, not re-derived**. Every command
shape, tool-param name, and gotcha below was hard-won across real runs (2026-08-13,
2026-09-02) — follow it exactly rather than improvising from first principles.

Arguments passed: `$ARGUMENTS`

## Dispatch on arguments

- **No args / "full" / "update"** → run the complete cycle below: check, apply apps,
  apply OS if pending, verify, document.
- **"check" / "status" / "dry-run"** → Step 1 only. Report what's pending. Make no
  changes, file no CM doc.
- **"apps" / "apps-only"** → Step 1 + Step 2 only. Skip the OS update even if one is
  pending (report it as still pending).
- **"os" / "os-only"** → Step 1 + Step 3 only (skip app updates even if pending).

---

## Step 1 — Check what's pending

```
truenas_check_updates            (OS: current version, new version if any, reboot_required)
truenas_list_apps                (apps: upgrade_available per app)
```

If both report nothing pending: tell Nic the system is fully current and stop. No CM
doc for "nothing happened."

## Step 2 — Apply app updates (do this before the OS update — lower risk, isolates failures)

For each app with `upgrade_available: true`:

```
truenas_manage_app app=<name> action=upgrade
```

This runs as a job (TrueNAS auto-snapshots the app first). Poll with
`truenas_list_jobs` or re-check `truenas_get_app app=<name>` until `state=RUNNING`
and `upgrade_available=false`. A brief `DEPLOYING` state between `STOPPED`→`RUNNING`
is normal — don't report failure on that alone; check again a few seconds later.

File a CM doc for each app updated (template at the bottom of this file) before
moving to Step 3.

## Step 3 — Apply the OS update (if one is pending)

### 3a. Stage it (non-destructive, no reboot)

```
truenas_download_update
```

### 3b. Pre-flight gate — do NOT proceed unless all of these are clean

```
truenas_list_pools                          → both SSD and HDD: status=ONLINE, healthy=true
truenas_list_alerts min_level=WARNING       → count: 0
truenas_list_jobs state=RUNNING             → count: 0  (never reboot mid-scrub/replication)
```

If any of these fail the gate, **stop and tell Nic** — don't reboot into an unhealthy
state.

### 3c. Shut down VMs — exact order, verify STOPPED before each next step

**Portal → Plex → HomeAssistant → PostgreSQL** (dependents first, database last — a
clean guest shutdown lets Postgres checkpoint; never force-kill it).

VM ids on this box: `portal=14, plex=3, homeassistant=1, postgresql=11` (confirm with
`truenas_list_vms` if this ever changes).

```
truenas_manage_vm id=14 action=stop   → poll truenas_list_vms until portal STOPPED
truenas_manage_vm id=3  action=stop   → poll until plex STOPPED (can take up to ~90s, that's normal)
truenas_manage_vm id=1  action=stop   → poll until homeassistant STOPPED
truenas_manage_vm id=11 action=stop   → poll until postgresql STOPPED
```

If a VM won't reach `STOPPED` within ~2 minutes, **halt and investigate** — do not
force-kill, especially not PostgreSQL.

### 3d. Apply + reboot — use the script, not a nonexistent tool

**`truenas_apply_update` does not exist as an MCP tool, on purpose.** `update.run` is
destructive-tier (it reboots the host) and `TRUENAS_ENABLE_DESTRUCTIVE` is
intentionally left unset in `.env` so no destructive tool ever registers. Do not
search for it, do not try to flip the env flag and reconnect — use the script:

```bash
cd "C:\Users\Nic\Documents\Claude\Code\MCP-TrueNAS"
node scripts/apply-staged-update.mjs
```

Run this via the Bash tool with `run_in_background: true` and `timeout: 600000` — it
blocks through the full apply → reboot → post-flight cycle (typically 5–8 minutes).
Do one early read of the task's output file a few seconds in, just to confirm
pre-flight passed and the job submitted (`apply [RUNNING] ...`). After that, **wait
for the background-task completion notification** — do not poll with repeated short
sleeps (the Bash tool blocks `sleep 90`-then-check patterns for exactly this reason;
use a single short check or just wait).

The script itself:
- Refuses to run if any pool is unhealthy or any VM is still `RUNNING` (its own
  pre-flight, independent of 3b/3c above).
- Submits `update.run({reboot:true})`, polls the job to `SUCCESS`.
- A dropped WebSocket connection during this phase is **expected** (the reboot itself)
  — the script treats it as "reboot underway," not a failure.
- Waits (up to 15 min) for `system.info` to answer again, then prints a full
  post-flight report: version, both pools' health, all VM states, all app states,
  active alert count, `update.status`, and the boot-environment list.

**If the script's own `import` line is ever copied elsewhere:** Node's ESM loader
rejects a bare Windows path (`C:/...`) with `ERR_UNSUPPORTED_ESM_URL_SCHEME` — it
must be a `file:///C:/...` URL. The committed script already has this right; this is
only relevant if writing a new one-off variant.

### 3e. Post-flight verification

Read the script's completed output for:
- [ ] Version changed to the target (script flags `⚠️ unchanged` if not — treat that
      as a failure needing investigation, not a pass).
- [ ] Both pools healthy, 0 scan errors.
- [ ] All 4 VMs `RUNNING` — they have `autostart=true` so this is normally automatic.
      If any VM is not `RUNNING` a couple minutes after the box comes back, start it
      manually with `truenas_manage_vm id=<id> action=start`, in the **reverse**
      shutdown order (PostgreSQL → HomeAssistant → Plex → Portal) if more than one
      needs a manual nudge.
- [ ] Both apps `RUNNING` (a `DEPLOYING` blip during the reboot-driven app restart is
      normal — recheck with `truenas_get_app` if the script's snapshot caught it
      mid-transition).
- [ ] 0 active alerts.
- [ ] `update.status` reports fully current.

## Step 4 — File Change Management records

**Every change gets its own CM doc — apps and OS are separate records, even in the
same session.** No skipping "minor" ones (see `feedback-document-every-change`
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
(apps and OS share the same daily counter — check what's already in the folder for
that date if picking up a partial day).

### CM doc template

```markdown
# CHG-YYYY.MM.DD-NNN: <short title>

Date: YYYY-MM-DD Category: Infrastructure Risk Level: <Low|Medium> Status: Completed - verified
Performed By: Claude Code (AI Agent) via mcp-truenas Approved By: Nic

## 1. Description and Background
<why this change happened — routine check, what was found pending>

## 2. Changes Made
| Item | Before | After | Result |
|---|---|---|---|
| ... | ... | ... | Success |

## 3. Commands Executed (MCP-Style)
<the actual tool calls / script invocation, in sequence>

## 4. Verification and Validation
<what was checked post-change and what it showed>

## 5. Regression Risk and Rollback Plan
<risk level and why; rollback steps — for OS updates, the retained prior boot environment>

---
Document generated by Claude Code - YYYY-MM-DD
```

## Step 5 — Report back to Nic

Concise summary: what was checked, what was updated (before → after versions), that
verification passed, and links to the CM doc(s) filed. Mention explicitly if
anything needed manual intervention (a VM that didn't autostart, an app that didn't
settle, etc.) even if it was resolved.

---

## Standing safety rules (apply throughout, not just during updates)

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
- **Never force-kill a VM**, especially PostgreSQL — halt and ask if graceful
  shutdown stalls.
- **If a pool is unhealthy, there are active alerts, or a job is running** at the 3b
  pre-flight gate, stop and report — don't reboot through it.
- **Pushing repo changes** (if this script or skill itself is edited) needs the
  `gh` account switched to `PainInTheNic` first (`gh auth switch --user
  PainInTheNic`), then switched back to `Cabinet-Compass` after
  (`gh auth switch --user Cabinet-Compass`) — the default active account can't push
  to this repo.
- **Rollback** (OS only): the prior version stays as a boot environment. Reboot,
  select it at the boot menu, reactivate if desired via System → Boot → Boot
  Environments. No data restore needed. Full detail in
  `TrueNAS-OS-Update-Runbook.md` Part 5.

## Reference files

- `TrueNAS-OS-Update-Runbook.md` (repo-adjacent, in `C:\Users\Nic\Documents\Claude\`)
  — the longer-form narrative runbook this skill is distilled from. Consult it for
  anything this skill doesn't cover (e.g. full rollback walkthrough, IPMI recovery).
- `scripts/apply-staged-update.mjs` — the apply+reboot script itself, committed to
  this repo. Fix bugs in place rather than reconstructing the call sequence from
  scratch if TrueNAS's API shape ever changes.
