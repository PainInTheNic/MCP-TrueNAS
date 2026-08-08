/**
 * Tool definitions — the MCP surface of this server.
 *
 * Patterns every tool here follows:
 *  - Name prefixed "truenas_" so it can't collide with other MCP servers.
 *  - Description written FOR the model: what it returns, when to use it.
 *  - zod inputSchema: validated before the handler runs; .describe() text on
 *    each parameter is also shown to the model.
 *  - annotations.readOnlyHint: true — every v1 tool only reads.
 *  - response_format=markdown returns a text summary; json returns structured
 *    data (see respond() for why we never send both at once).
 *  - All failures come back as isError results with actionable messages,
 *    never as protocol crashes.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TrueNasClient, TrueNasConfig } from "./truenas-client.js";

interface ToolContext {
  config: TrueNasConfig;
  getClient: () => TrueNasClient;
}

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

/** Claude Code soft-caps MCP tool output around 25k tokens; stay well under it. */
const CHARACTER_LIMIT = 25_000;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("markdown = compact human-readable summary; json = full structured data");

type TextBlock = { type: "text"; text: string };
type ToolResult = { content: TextBlock[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * Build a tool result. A wrinkle discovered in review: some MCP clients
 * (Claude Code among them) show the model JSON.stringify(structuredContent)
 * INSTEAD of the text block whenever structuredContent is present — so
 * returning both would bypass our markdown summaries AND our size guard.
 * Therefore: markdown format returns text only (the summary IS the payload);
 * json format returns the data as text plus structuredContent, dropping
 * structuredContent when it would blow the client's ~25k-token result cap.
 */
function respond(
  structured: Record<string, unknown>,
  format: "markdown" | "json",
  markdown: () => string
): ToolResult {
  const truncate = (text: string): string =>
    text.slice(0, CHARACTER_LIMIT) +
    "\n\n[Truncated — use limit/offset parameters or filters to narrow the result.]";
  if (format === "markdown") {
    const text = markdown();
    return { content: [{ type: "text", text: text.length > CHARACTER_LIMIT ? truncate(text) : text }] };
  }
  const json = JSON.stringify(structured, null, 2);
  const oversized = json.length > CHARACTER_LIMIT;
  return {
    content: [{ type: "text", text: oversized ? truncate(json) : json }],
    ...(oversized ? {} : { structuredContent: structured }),
  };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

function humanBytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function mdTable(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const line = (cells: (string | number | boolean | null | undefined)[]) =>
    "| " + cells.map((c) => (c === null || c === undefined || c === "" ? "—" : String(c))).join(" | ") + " |";
  return [line(headers), "|" + headers.map(() => "---").join("|") + "|", ...rows.map(line)].join("\n");
}

/** ZFS properties arrive wrapped: {parsed: 123, value: "123K", ...}. Unwrap both views. */
interface RawZfsProp {
  parsed?: unknown;
  value?: unknown;
}
function propNum(p: RawZfsProp | undefined): number | null {
  return typeof p?.parsed === "number" ? p.parsed : null;
}
function propStr(p: RawZfsProp | undefined): string | null {
  return p?.value === null || p?.value === undefined ? null : String(p.value);
}

// ------------------------------------------------------------------
// Raw API shapes (only the fields we actually read; everything optional
// because two API generations and many versions feed this)
// ------------------------------------------------------------------

interface RawPool {
  name?: string;
  status?: string;
  healthy?: boolean;
  warning?: boolean;
  status_detail?: string | null;
  size?: number | null;
  allocated?: number | null;
  free?: number | null;
  size_str?: string | null;
  allocated_str?: string | null;
  free_str?: string | null;
  fragmentation?: string | null;
  is_upgraded?: boolean;
  scan?: { function?: string; state?: string; percentage?: number | null } | null;
}

interface RawDataset {
  id?: string;
  pool?: string;
  type?: string;
  mountpoint?: string | null;
  encrypted?: boolean;
  locked?: boolean;
  used?: RawZfsProp;
  available?: RawZfsProp;
  usedbysnapshots?: RawZfsProp;
  quota?: RawZfsProp;
  compression?: RawZfsProp;
  compressratio?: RawZfsProp;
  readonly?: RawZfsProp;
}

const ALERT_LEVELS = ["INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"] as const;
type AlertLevel = (typeof ALERT_LEVELS)[number];

interface RawAlert {
  uuid?: string;
  klass?: string;
  level?: string;
  text?: string;
  formatted?: string | null;
  datetime?: string;
  last_occurrence?: string;
  dismissed?: boolean;
  one_shot?: boolean;
  node?: string;
}

interface RawDisk {
  name?: string;
  devname?: string;
  serial?: string;
  model?: string | null;
  size?: number | null;
  type?: string | null;
  rotationrate?: number | null;
  pool?: string | null;
  zfs_guid?: string | null;
  bus?: string;
}

interface RawService {
  id?: number;
  service?: string;
  enable?: boolean;
  state?: string;
}

interface RawJob {
  id?: number;
  method?: string;
  description?: string | null;
  state?: string;
  progress?: { percent?: number | null; description?: string | null } | null;
  error?: string | null;
  time_started?: string | null;
  time_finished?: string | null;
}

interface RawSnapshot {
  id?: string;
  dataset?: string;
  snapshot_name?: string;
  name?: string;
  properties?: { creation?: RawZfsProp; used?: RawZfsProp; referenced?: RawZfsProp };
  createtxg?: string;
}

// ------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { config, getClient } = ctx;

  // ---------------- connection status ----------------
  server.registerTool(
    "truenas_connection_status",
    {
      title: "TrueNAS Connection Status",
      description:
        "Diagnose the connection to TrueNAS: shows the configured URL, whether an API key is present " +
        "(never the key itself), which API generation was detected (WebSocket JSON-RPC vs legacy REST), " +
        "and whether authentication succeeded. Call this first when any other truenas_ tool fails.",
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const output: Record<string, unknown> = {
        truenas_url: config.url || "(not set — define TRUENAS_URL in .env)",
        api_key_present: Boolean(config.apiKey),
        tls_verification: config.skipTlsVerify ? "disabled (self-signed certificate mode)" : "enabled",
      };
      if (config.url && config.apiKey) {
        try {
          const client = getClient();
          const det = await client.detect();
          output.api_mode = det.mode;
          if (det.apiVersions.length > 0) output.api_versions = det.apiVersions;
          const info = await client.systemInfo();
          output.reachable = true;
          output.authenticated = true;
          output.truenas_version = info.version ?? null;
          output.hostname = info.hostname ?? null;
          output.uptime = info.uptime ?? null;
        } catch (error) {
          output.probe_error = error instanceof Error ? error.message : String(error);
        }
      } else {
        output.hint = "Set TRUENAS_URL and TRUENAS_API_KEY in the .env file next to package.json, then retry.";
      }
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    }
  );

  // ---------------- system info ----------------
  server.registerTool(
    "truenas_get_system_info",
    {
      title: "Get TrueNAS System Info",
      description:
        "Get system information from TrueNAS: product version, hostname, uptime, CPU model and core count, " +
        "physical memory, load averages, boot time, and timezone.",
      inputSchema: z.object({ response_format: responseFormat }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const info = await getClient().systemInfo();
        const structured = {
          version: info.version ?? null,
          hostname: info.hostname ?? null,
          uptime: info.uptime ?? null,
          cpu_model: info.model ?? null,
          cores: info.cores ?? null,
          physical_cores: info.physical_cores ?? null,
          memory: humanBytes(info.physmem),
          memory_bytes: info.physmem ?? null,
          loadavg: info.loadavg ?? null,
          boottime: info.boottime ?? null,
          timezone: info.timezone ?? null,
          ecc_memory: info.ecc_memory ?? null,
        };
        return respond(structured, response_format, () =>
          [
            `# ${structured.hostname ?? "TrueNAS"}`,
            "",
            `- **Version**: ${structured.version ?? "—"}`,
            `- **Uptime**: ${structured.uptime ?? "—"}`,
            `- **CPU**: ${structured.cpu_model ?? "—"} (${structured.cores ?? "?"} threads, ${structured.physical_cores ?? "?"} cores)`,
            `- **Memory**: ${structured.memory}${structured.ecc_memory ? " (ECC)" : ""}`,
            `- **Load average**: ${Array.isArray(structured.loadavg) ? structured.loadavg.join(", ") : "—"}`,
            `- **Timezone**: ${structured.timezone ?? "—"}`,
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- pools ----------------
  server.registerTool(
    "truenas_list_pools",
    {
      title: "List Storage Pools",
      description:
        "List all ZFS storage pools with health status (ONLINE/DEGRADED/FAULTED), capacity (size, " +
        "allocated, free, usage %), fragmentation, and any running scrub/resilver. The first stop for " +
        "'how are my pools?' or 'how full is my NAS?'.",
      inputSchema: z.object({ response_format: responseFormat }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().pools()) as RawPool[];
        const pools = raw.map((p) => {
          const usagePercent =
            typeof p.allocated === "number" && typeof p.size === "number" && p.size > 0
              ? Math.round((p.allocated / p.size) * 100)
              : null;
          return {
            name: p.name ?? null,
            status: p.status ?? null,
            healthy: p.healthy ?? null,
            warning: p.warning ?? null,
            status_detail: p.status_detail ?? null,
            size: p.size_str ?? humanBytes(p.size),
            allocated: p.allocated_str ?? humanBytes(p.allocated),
            free: p.free_str ?? humanBytes(p.free),
            size_bytes: p.size ?? null,
            allocated_bytes: p.allocated ?? null,
            free_bytes: p.free ?? null,
            usage_percent: usagePercent,
            fragmentation_percent: p.fragmentation ?? null,
            scan:
              p.scan && p.scan.state === "SCANNING"
                ? { function: p.scan.function ?? null, percent: p.scan.percentage ?? null }
                : null,
          };
        });
        const structured = { count: pools.length, pools };
        return respond(structured, response_format, () =>
          mdTable(
            ["Pool", "Status", "Used / Total", "Usage", "Frag", "Activity"],
            pools.map((p) => [
              p.name,
              `${p.status}${p.healthy === false ? " ⚠" : ""}`,
              `${p.allocated} / ${p.size}`,
              p.usage_percent === null ? null : `${p.usage_percent}%`,
              p.fragmentation_percent === null ? null : `${p.fragmentation_percent}%`,
              p.scan ? `${p.scan.function} ${p.scan.percent ?? "?"}%` : "idle",
            ])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- datasets ----------------
  server.registerTool(
    "truenas_list_datasets",
    {
      title: "List Datasets",
      description:
        "List ZFS datasets (filesystems and zvols) with space used/available, snapshot usage, quota, " +
        "compression, and mountpoint. Filter by pool and paginate for large systems.",
      inputSchema: z.object({
        pool: z.string().optional().describe("Only list datasets in this pool (e.g. 'tank')"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum datasets to return"),
        offset: z.number().int().min(0).default(0).describe("Datasets to skip, for pagination"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ pool, limit, offset, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().datasets({ pool, limit, offset })) as RawDataset[];
        const datasets = raw.map((d) => ({
          name: d.id ?? null,
          pool: d.pool ?? null,
          type: d.type ?? null,
          mountpoint: d.mountpoint ?? null,
          encrypted: d.encrypted ?? false,
          locked: d.locked ?? false,
          used: propStr(d.used),
          used_bytes: propNum(d.used),
          available: propStr(d.available),
          available_bytes: propNum(d.available),
          used_by_snapshots: propStr(d.usedbysnapshots),
          quota: propStr(d.quota),
          compression: propStr(d.compression),
          compression_ratio: propStr(d.compressratio),
          readonly: propStr(d.readonly),
        }));
        const structured = {
          count: datasets.length,
          offset,
          has_more: datasets.length === limit,
          next_offset: datasets.length === limit ? offset + limit : null,
          datasets,
        };
        return respond(structured, response_format, () =>
          mdTable(
            ["Dataset", "Type", "Used", "Available", "Snap use", "Mountpoint"],
            datasets.map((d) => [
              `${d.name}${d.locked ? " 🔒" : ""}`,
              d.type,
              d.used,
              d.available,
              d.used_by_snapshots,
              d.mountpoint,
            ])
          ) + (structured.has_more ? `\n\n_More available — call again with offset=${structured.next_offset}._` : "")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- alerts ----------------
  server.registerTool(
    "truenas_list_alerts",
    {
      title: "List Alerts",
      description:
        "List current TrueNAS alerts (warnings, errors, hardware problems, update notices). By default " +
        "hides alerts the user already dismissed. Use min_level to only see serious ones.",
      inputSchema: z.object({
        include_dismissed: z.boolean().default(false).describe("Also include alerts the user dismissed"),
        min_level: z
          .enum(ALERT_LEVELS)
          .optional()
          .describe("Only alerts at or above this severity (INFO < NOTICE < WARNING < ERROR < CRITICAL < ALERT < EMERGENCY)"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ include_dismissed, min_level, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().alerts()) as RawAlert[];
        const minIndex = min_level ? ALERT_LEVELS.indexOf(min_level) : 0;
        const levelIndex = (level: string | undefined): number =>
          ALERT_LEVELS.indexOf((level ?? "INFO") as AlertLevel);
        const alerts = raw
          .filter((a) => include_dismissed || !a.dismissed)
          .filter((a) => levelIndex(a.level) >= minIndex)
          .sort((a, b) => levelIndex(b.level) - levelIndex(a.level))
          .map((a) => ({
            level: a.level ?? null,
            text: a.text ?? null,
            source: a.klass ?? null,
            first_seen: a.datetime ?? null,
            last_occurrence: a.last_occurrence ?? null,
            dismissed: a.dismissed ?? false,
            uuid: a.uuid ?? null,
          }));
        const structured = { count: alerts.length, alerts };
        return respond(structured, response_format, () =>
          alerts.length === 0
            ? "No active alerts — the NAS reports a clean bill of health."
            : alerts
                .map(
                  (a) =>
                    `- **[${a.level}]** ${a.text}${a.dismissed ? " _(dismissed)_" : ""} — since ${a.first_seen ?? "?"}`
                )
                .join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- disks ----------------
  server.registerTool(
    "truenas_list_disks",
    {
      title: "List Physical Disks",
      description:
        "List physical disks with model, serial number, size, type (HDD/SSD), which pool each belongs to, " +
        "and optionally the current temperature in °C (readings are cached ~5 minutes by TrueNAS).",
      inputSchema: z.object({
        include_temperatures: z.boolean().default(false).describe("Also fetch current disk temperatures"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ include_temperatures, response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const raw = (await client.disks()) as RawDisk[];
        let temps: Record<string, number | null> = {};
        let tempError: string | null = null;
        if (include_temperatures) {
          try {
            temps = await client.diskTemperatures();
          } catch (error) {
            tempError = error instanceof Error ? error.message : String(error);
          }
        }
        const disks = raw.map((d) => ({
          name: d.name ?? null,
          device: d.devname ?? null,
          model: d.model ?? null,
          serial: d.serial ?? null,
          size: humanBytes(d.size),
          size_bytes: d.size ?? null,
          type: d.type ?? null,
          rotation_rpm: d.rotationrate ?? null,
          pool: d.pool ?? null,
          bus: d.bus ?? null,
          ...(include_temperatures ? { temperature_c: d.name ? temps[d.name] ?? null : null } : {}),
        }));
        const structured: Record<string, unknown> = { count: disks.length, disks };
        if (tempError) structured.temperature_error = tempError;
        return respond(structured, response_format, () =>
          mdTable(
            ["Disk", "Model", "Serial", "Size", "Type", "Pool", ...(include_temperatures ? ["Temp"] : [])],
            disks.map((d) => [
              d.name,
              d.model,
              d.serial,
              d.size,
              d.type,
              d.pool,
              ...(include_temperatures
                ? [d.temperature_c === null || d.temperature_c === undefined ? "—" : `${d.temperature_c}°C`]
                : []),
            ])
          ) + (tempError ? `\n\n_Temperatures unavailable: ${tempError}_` : "")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- services ----------------
  server.registerTool(
    "truenas_list_services",
    {
      title: "List Services",
      description:
        "List TrueNAS services (SMB, NFS, SSH, iSCSI, ...) with running state and whether they start on boot.",
      inputSchema: z.object({
        state: z.enum(["RUNNING", "STOPPED"]).optional().describe("Only services in this state"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ state, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().services()) as RawService[];
        const services = raw
          .filter((s) => !state || s.state === state)
          .map((s) => ({
            service: s.service ?? null,
            state: s.state ?? null,
            start_on_boot: s.enable ?? null,
          }))
          .sort((a, b) => String(a.service).localeCompare(String(b.service)));
        const structured = { count: services.length, services };
        return respond(structured, response_format, () =>
          mdTable(
            ["Service", "State", "Start on boot"],
            services.map((s) => [s.service, s.state, s.start_on_boot === null ? null : s.start_on_boot ? "yes" : "no"])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- jobs ----------------
  server.registerTool(
    "truenas_list_jobs",
    {
      title: "List Background Jobs",
      description:
        "List TrueNAS background jobs (scrubs, replications, updates, ...), most recent first, with state " +
        "(WAITING/RUNNING/SUCCESS/FAILED/ABORTED), progress percent, and errors. Use state=RUNNING to see " +
        "what the NAS is doing right now, state=FAILED to find recent failures.",
      inputSchema: z.object({
        state: z.enum(["WAITING", "RUNNING", "SUCCESS", "FAILED", "ABORTED"]).optional().describe("Only jobs in this state"),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum jobs to return"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ state, limit, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().jobs({ state, limit })) as RawJob[];
        const jobs = raw.map((j) => ({
          id: j.id ?? null,
          method: j.method ?? null,
          description: j.description ?? null,
          state: j.state ?? null,
          progress_percent: j.progress?.percent ?? null,
          progress_description: j.progress?.description ?? null,
          error: j.error ?? null,
          started: j.time_started ?? null,
          finished: j.time_finished ?? null,
        }));
        const structured = { count: jobs.length, jobs };
        return respond(structured, response_format, () =>
          jobs.length === 0
            ? "No jobs match."
            : mdTable(
                ["ID", "Job", "State", "Progress", "Started", "Error"],
                jobs.map((j) => [
                  j.id,
                  j.method,
                  j.state,
                  j.progress_percent === null ? null : `${j.progress_percent}%`,
                  j.started,
                  j.error,
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- snapshots ----------------
  server.registerTool(
    "truenas_list_snapshots",
    {
      title: "List ZFS Snapshots",
      description:
        "List ZFS snapshots with creation time and space used. Systems often have thousands of snapshots — " +
        "filter by dataset and paginate. Works across TrueNAS versions (the underlying API differs; this " +
        "tool picks the right one automatically).",
      inputSchema: z.object({
        dataset: z.string().optional().describe("Only snapshots of this dataset (e.g. 'tank/appdata')"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum snapshots to return"),
        offset: z.number().int().min(0).default(0).describe("Snapshots to skip, for pagination"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ dataset, limit, offset, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().snapshots({ dataset, limit, offset })) as RawSnapshot[];
        const snapshots = raw.map((s) => {
          const id = s.id ?? "";
          const atIndex = id.indexOf("@");
          return {
            id: s.id ?? null,
            dataset: s.dataset ?? (atIndex > 0 ? id.slice(0, atIndex) : null),
            name: s.snapshot_name ?? (atIndex > 0 ? id.slice(atIndex + 1) : s.name ?? null),
            created: propStr(s.properties?.creation),
            used: propStr(s.properties?.used),
            referenced: propStr(s.properties?.referenced),
          };
        });
        const structured = {
          count: snapshots.length,
          offset,
          has_more: snapshots.length === limit,
          next_offset: snapshots.length === limit ? offset + limit : null,
          snapshots,
        };
        return respond(structured, response_format, () =>
          (snapshots.length === 0
            ? "No snapshots match."
            : mdTable(
                ["Dataset", "Snapshot", "Created", "Used", "Referenced"],
                snapshots.map((s) => [s.dataset, s.name, s.created, s.used, s.referenced])
              )) + (structured.has_more ? `\n\n_More available — call again with offset=${structured.next_offset}._` : "")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- updates ----------------
  server.registerTool(
    "truenas_check_updates",
    {
      title: "Check for System Updates",
      description:
        "Check whether a TrueNAS base-OS (system) update is available, and whether the system is waiting on " +
        "a reboot. Reports the current version and, if an update exists, the candidate version and release " +
        "notes. Note: this covers the TrueNAS OS only — it does NOT check for app/catalog updates.",
      inputSchema: z.object({ response_format: responseFormat }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const u = await getClient().updateCheck();
        const structured = {
          update_available: u.available,
          current_version: u.current_version,
          train: u.train,
          new_version: u.new_version,
          release_notes_url: u.release_notes_url,
          reboot_required: u.reboot_required,
          reboot_reasons: u.reboot_reasons,
        };
        return respond(structured, response_format, () => {
          const trainSuffix = u.train ? ` (train ${u.train})` : "";
          const rebootLine =
            u.reboot_required === true
              ? `\n\n⚠ **Reboot required**${u.reboot_reasons.length ? `: ${u.reboot_reasons.join("; ")}` : ""}`
              : "";
          if (!u.available) {
            return `# System is up to date\n\n- **Current version**: ${u.current_version ?? "—"}${trainSuffix}${rebootLine}`;
          }
          return (
            "# Update available\n\n" +
            `- **Current version**: ${u.current_version ?? "—"}${trainSuffix}\n` +
            `- **New version**: ${u.new_version ?? "—"}` +
            (u.release_notes_url ? `\n- **Release notes**: ${u.release_notes_url}` : "") +
            rebootLine
          );
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
