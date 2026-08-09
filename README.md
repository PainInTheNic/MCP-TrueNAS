# MCP-TrueNAS

An MCP (Model Context Protocol) server that lets Claude monitor and manage a
TrueNAS box in plain English: *"any alerts on the NAS?"*, *"how full is tank?"*,
*"list snapshots of appdata"*.

**Read-only by default** — the server observes and never mutates unless you opt
in. Safe, reversible writes are enabled with `TRUENAS_ENABLE_WRITE=1`;
destructive operations are separately gated and human-confirmed. See
[Write support & safety](#write-support--safety).

## How it works

```
┌─────────────────  your Windows PC  ─────────────────┐
│                                                     │
│  Claude Code  ◄── stdio (MCP JSON-RPC) ──►  this    │        ┌─────────┐
│  (you chat here)                            server ─┼──────► │ TrueNAS │
│                                                     │  HTTPS/ │  (LAN)  │
└─────────────────────────────────────────────────────┘  WSS    └─────────┘
```

- **This server runs on your PC, not on the NAS.** Claude Code launches it
  automatically as a background child process when a session starts (that's
  what `.mcp.json` configures) and talks to it over stdin/stdout.
- The server talks to TrueNAS over its network API, authenticating with an
  API key you generate in the TrueNAS UI.
- **stdout is sacred**: it carries the MCP protocol. All logging goes to
  stderr (`console.error`), never `console.log`.

### Which TrueNAS API? Both.

TrueNAS changed APIs across versions, so the client auto-detects at runtime:

| Your TrueNAS | API used | How |
|---|---|---|
| 25.04 "Fangtooth" and newer (incl. 26+) | WebSocket JSON-RPC 2.0 at `wss://HOST/api/current` | `GET /api/versions` answers with a JSON array → WebSocket mode |
| SCALE ≤ 24.10, CORE 13.x | REST v2.0 at `https://HOST/api/v2.0` | `/api/versions` doesn't exist → REST mode |

Version quirks handled for you: the snapshot API rename in 25.10
(`zfs.snapshot.query` → `pool.snapshot.query`), `{"$date": …}` timestamp
objects, and the login-method change coming in TrueNAS 27
(`TRUENAS_USERNAME` covers it).

## File tour

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Bootstrap: loads config from `.env`, creates the `McpServer`, connects the stdio transport. Small on purpose. |
| [src/truenas-client.ts](src/truenas-client.ts) | Everything TrueNAS: API detection, WebSocket JSON-RPC with reconnect + login, REST fallback, and translation of raw network errors into actionable messages. |
| [src/tools.ts](src/tools.ts) | The MCP surface — every `registerTool()` call. **To add a capability, you edit this file** (and maybe add one method to the client). |
| [.mcp.json](.mcp.json) | Tells Claude Code how to launch this server (project-scoped registration). |
| [.env](.env.example) | Your secrets. Gitignored. `.env.example` is the committable template. |

## The tools

All read-only (`readOnlyHint: true`), all paginate or filter where data can be
large. Each accepts `response_format`: `markdown` (default, compact summary) or
`json` (full structured data). Every tool also declares an `outputSchema`, so
the structured result is machine-validated by the MCP client.

**System & storage**
- `truenas_connection_status` — diagnose config/reachability/auth; start here when something fails
- `truenas_get_system_info` — version, hostname, uptime, CPU, RAM, load
- `truenas_check_updates` — whether a base-OS update is available, plus reboot-required state
- `truenas_list_pools` — pool health, capacity, usage %, fragmentation, scrub activity
- `truenas_list_datasets` — space used/available, quotas, compression (filter by pool, paginated)
- `truenas_list_disks` — model, serial, size, pool membership, optional temperatures
- `truenas_list_snapshots` — snapshots with creation time and space (filter by dataset, paginated)

**Health & activity**
- `truenas_list_alerts` — active alerts, filterable by severity
- `truenas_list_services` — SMB/NFS/SSH/… state and boot setting
- `truenas_list_jobs` — background jobs: scrubs, replications, failures

**Apps, sharing, backups & VMs** — require TrueNAS 25.04+ (WebSocket API)
- `truenas_list_apps` — installed apps and whether an app/image **update is available**, plus Docker status
- `truenas_list_shares` — SMB shares, NFS exports, and iSCSI targets in one call
- `truenas_list_network` — IP addresses, default routes, DNS, and per-interface link state
- `truenas_list_replication_tasks` — configured ZFS replication (backup) tasks and last-run state
- `truenas_list_cloudsync_tasks` — cloud backup tasks (S3/Drive/B2/…); credentials never shown
- `truenas_list_snapshot_tasks` — periodic (automatic) snapshot policy and retention
- `truenas_list_scrub_tasks` — scheduled pool scrub tasks
- `truenas_list_vms` — virtual machines, run state, and resource allocation

**Writes (opt-in — set `TRUENAS_ENABLE_WRITE=1`)** — reversible, non-destructive; never marked read-only (so a client won't auto-run them); every call is audit-logged to stderr:
- `truenas_create_snapshot` — take a ZFS snapshot of a dataset (optionally recursive)
- `truenas_update_dataset` — change dataset properties (comment, compression, readonly, atime, sync, quota)
- `truenas_control_service` — start / stop / restart / reload a service (smb, nfs, ssh, …)
- `truenas_set_service_boot` — enable/disable a service starting on boot
- `truenas_manage_app` — start / stop / redeploy / upgrade / rollback an installed app
- `truenas_manage_vm` — start / stop / restart / suspend / resume a VM
- `truenas_run_scrub` — start a manual pool scrub
- `truenas_create_dataset` / `truenas_rename_dataset` — create a dataset or zvol; rename a dataset
- `truenas_create_smb_share` / `truenas_update_smb_share` — SMB shares
- `truenas_create_nfs_share` / `truenas_update_nfs_share` — NFS exports
- `truenas_create_user` / `truenas_update_user` / `truenas_set_user_password` — local users (passwords never logged)
- `truenas_create_group` / `truenas_update_group` — local groups
- `truenas_create_snapshot_task` / `truenas_update_snapshot_task` — automatic snapshot schedules
- `truenas_create_scrub_task` / `truenas_update_scrub_task` — scheduled scrubs

## Write support & safety

The server is **read-only until you opt in**, in tiers:

| Tier | Enable with | Gate |
|---|---|---|
| **Read** (default) | always on | none |
| **Safe write** (reversible) | `TRUENAS_ENABLE_WRITE=1` | not registered unless enabled; audit-logged; never marked read-only |
| **Destructive** (delete / rollback / reboot) | `TRUENAS_ENABLE_DESTRUCTIVE=1` | the above **plus** a human elicitation confirmation, and **fail-closed** if the client can't prompt |

> **Status:** safe writes ship now (`truenas_create_snapshot`, `truenas_update_dataset`). The destructive tier's flag and gating design exist, but **no destructive tool is registered yet** — those land in a later phase.

Being honest about enforcement: MCP has **no protocol-level way to force** human
confirmation, so the guarantees that actually hold are the ones a client cannot
bypass — destructive tools are **absent from the tool list** unless the operator
sets the flag, and they **refuse to run** when a human can't be prompted.
Elicitation prompts and Claude Code `ask`/`deny` permission rules add
defense-in-depth but are bypassable (`--dangerously-skip-permissions`,
auto-accepting clients). The most dangerous operations — `disk.wipe`,
`pool.create` (formats disks), `pool.export` with destroy — are deliberately
**not implemented**; do those in the TrueNAS UI.

**Testing writes safely:** set `TRUENAS_TEST_DATASET=tank/mcp-test` to restrict
*every* write to that dataset and its children, so a mistake can't reach real
data — or point the server at a throwaway TrueNAS VM for write development.

## Setup

### 1. Create an API key on TrueNAS

In the TrueNAS web UI: **user icon (top right) → My API Keys → Add**.
Copy the whole `<id>-<secret>` string — **it is shown exactly once**.

An API key inherits the privileges of the user it's linked to. For a
belt-and-braces read-only setup, create a dedicated user whose group has only
the `READONLY_ADMIN` privilege (**Credentials → Groups/Privileges**) and link
the key to that user — then even a leaked key can't change anything.

> API keys are password-equivalent and bypass 2FA. TrueNAS auto-revokes keys
> that ever travel over plain HTTP — always use `https://`.

### 2. Configure

```bash
copy .env.example .env
```

Edit `.env`: set `TRUENAS_URL` and `TRUENAS_API_KEY`; set
`TRUENAS_SKIP_TLS_VERIFY=1` if the NAS uses its default self-signed
certificate.

### 3. Build

```bash
npm install
```

```bash
npm run build
```

### 4. Register with Claude Code

This repo ships a project-scoped [.mcp.json](.mcp.json) that launches the
server via a **relative** path (`dist/index.js`). Once you've built it, Claude
Code asks to approve the server the first time you open a session in this
folder, then launches it automatically thereafter.

To use it from *any* folder, register it user-wide with the absolute path to
your clone:

```bash
claude mcp add --scope user --transport stdio truenas -- node /absolute/path/to/MCP-TrueNAS/dist/index.js
```

Check it connected with `claude mcp list` (or `/mcp` inside a session).

### 5. Use it

Just ask Claude things like:

- "How healthy are my pools?"
- "Anything above WARNING in the NAS alerts?"
- "Which disks are hottest right now?"
- "Are any jobs failing? Show the errors."

## Testing without Claude

MCP Inspector is a debugging client. Two flavors:

```bash
npm run inspect
```

opens a web UI (browse tools, call them, see raw protocol traffic), or the
scriptable CLI:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name truenas_list_pools
```

## Extending: anatomy of a tool

Every tool in [src/tools.ts](src/tools.ts) follows one pattern:

```ts
server.registerTool(
  "truenas_list_pools",                    // snake_case, service-prefixed
  {
    title: "List Storage Pools",
    description: "…written FOR the model: what it returns, when to use it…",
    inputSchema: z.object({                 // zod validates before your code runs
      pool: z.string().optional().describe("shown to the model too"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ pool }) => {
    try {
      const data = await getClient().pools();      // client hides WS-vs-REST
      return respond(structured, format, () => markdown);
    } catch (error) {
      return errorResult(error);                   // actionable, never a crash
    }
  }
);
```

To add a **write** tool later (start a scrub, take a snapshot): add a client
method for the API call, register the tool with honest annotations
(`readOnlyHint: false`, `destructiveHint` as appropriate) — Claude Code will
then treat it with matching caution. Rebuild (`npm run build`) and restart
the session; Claude picks up the new tool automatically.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Any tool errors | Ask Claude to run `truenas_connection_status` — it diagnoses config, reachability, API mode, and auth in one shot |
| "TLS certificate verification failed" | Self-signed cert on the NAS → `TRUENAS_SKIP_TLS_VERIFY=1` in `.env` |
| "Cannot reach …" | Wrong `TRUENAS_URL`, NAS off, or firewall |
| "TrueNAS rejected the API key" | Key mistyped/revoked — regenerate; copy the whole `<id>-<secret>` string |
| Key suddenly stopped working | Was it ever sent over `http://`? TrueNAS auto-revokes such keys — make a new one, use `https://` |
| Tools missing in Claude | `.mcp.json` not approved yet, or server not rebuilt after edits — `claude mcp list` shows connection state |

## Security notes

- The API key lives only in `.env` (gitignored) or the MCP client's env
  config — never in source, never in chat.
- v1 tools are read-only by design; the key's user can enforce the same
  server-side via `READONLY_ADMIN`.
- Plain-HTTP URLs are refused unless `TRUENAS_ALLOW_HTTP=1`, because TrueNAS
  revokes keys observed on unencrypted transport.
- TLS verification is on unless you explicitly disable it for a self-signed
  cert.
- Some TrueNAS read APIs return secrets (cloud-sync OAuth tokens, a VM's VNC
  password). The tools that touch those — `truenas_list_cloudsync_tasks` and
  `truenas_list_vms` — deliberately project only non-sensitive fields, so no
  tokens, secrets, or passwords are ever surfaced to the model.

## License

[MIT](LICENSE) © PainInTheNic
