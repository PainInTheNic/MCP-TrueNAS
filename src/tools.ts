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
import { TrueNasClient, TrueNasConfig, TrueNasError } from "./truenas-client.js";

interface ToolContext {
  config: TrueNasConfig;
  getClient: () => TrueNasClient;
}

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

/** Claude Code soft-caps MCP tool output around 25k tokens; stay well under it. */
const CHARACTER_LIMIT = 25_000;

// Closed domain: these tools query one known, owner-controlled NAS, not an
// open world of external entities — so openWorldHint is false.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

// Safe (reversible) writes. NEVER set readOnlyHint on a mutating tool — clients
// like Claude Code auto-approve read-only tools, which would let a write run
// unprompted. destructiveHint stays false because these are reversible.
const SAFE_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const responseFormat = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("markdown = compact human-readable summary; json = full structured data");

type TextBlock = { type: "text"; text: string };
type ToolResult = { content: TextBlock[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * Build a tool result.
 *
 * Contract (updated after the MCP spec audit): every tool declares an
 * outputSchema, and the MCP SDK then REQUIRES structuredContent on a successful
 * result — a text-only result fails output validation. So we ALWAYS attach
 * structuredContent (the schema-validated machine channel). The text block is a
 * human-facing rendering only: a compact markdown summary by default, or
 * pretty-printed JSON when response_format=json. Because structuredContent
 * carries the authoritative, complete data, an oversized text preview can be
 * safely shortened — in json mode we swap in a small valid-JSON notice rather
 * than slicing serialized JSON into something unparseable.
 */
function respond(
  structured: Record<string, unknown>,
  format: "markdown" | "json",
  markdown: () => string
): ToolResult {
  if (format === "markdown") {
    const text = markdown();
    const capped =
      text.length > CHARACTER_LIMIT
        ? text.slice(0, CHARACTER_LIMIT) +
          "\n\n[Preview truncated — the full result is in structuredContent; narrow with limit/offset or filters.]"
        : text;
    return { content: [{ type: "text", text: capped }], structuredContent: structured };
  }
  const json = JSON.stringify(structured, null, 2);
  const text =
    json.length > CHARACTER_LIMIT
      ? JSON.stringify(
          {
            truncated: true,
            note:
              "Text preview omitted for size; the full result is in structuredContent. " +
              "Narrow with limit/offset or filters for a smaller preview.",
            character_limit: CHARACTER_LIMIT,
            approx_size: json.length,
          },
          null,
          2
        )
      : json;
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/**
 * Append a structured audit line for a mutating tool call. Goes to stderr —
 * stdout carries the MCP protocol and must never be written to here.
 */
function auditLog(entry: { tool: string; method: string; target?: string; outcome: string }): void {
  const parts = [
    `[audit] ${new Date().toISOString()}`,
    `tool=${entry.tool}`,
    `method=${entry.method}`,
    entry.target ? `target=${entry.target}` : "",
    `outcome=${entry.outcome}`,
  ].filter(Boolean);
  console.error(parts.join(" "));
}

/**
 * Test-safety guard: when TRUENAS_TEST_DATASET is set, refuse any write whose
 * target is outside that dataset (or its children). Lets you point the server
 * at a disposable dataset during development so a mistake can't hit real data.
 */
function assertAllowedTarget(config: TrueNasConfig, target: string): void {
  const allowed = config.testDataset;
  if (!allowed) return;
  const dataset = target.split("@")[0]; // strip any snapshot suffix
  if (dataset === allowed || dataset.startsWith(allowed + "/")) return;
  throw new TrueNasError(
    `Refusing to write to '${target}': TRUENAS_TEST_DATASET='${allowed}' restricts writes to that dataset ` +
      `and its children (test-safety guard). Unset TRUENAS_TEST_DATASET for normal use.`
  );
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

/** Format a TrueNAS cron schedule object as a "m h dom month dow" string. */
function cronStr(
  s: { minute?: string; hour?: string; dom?: string; month?: string; dow?: string } | undefined | null
): string | null {
  if (!s) return null;
  const parts = [s.minute, s.hour, s.dom, s.month, s.dow];
  if (parts.every((p) => p == null)) return null;
  return parts.map((p) => (p == null ? "*" : p)).join(" ");
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
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        truenas_url: z.string(),
        api_key_present: z.boolean(),
        tls_verification: z.string(),
        api_mode: z.string().optional(),
        api_versions: z.array(z.string()).optional(),
        reachable: z.boolean().optional(),
        authenticated: z.boolean().optional(),
        truenas_version: z.string().nullable().optional(),
        hostname: z.string().nullable().optional(),
        uptime: z.string().nullable().optional(),
        probe_error: z.string().optional(),
        hint: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
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
      // Route through respond() so this tool honors the same result contract as
      // the others (never emit text AND structuredContent together — some
      // clients render the JSON in place of the summary).
      return respond(output, response_format, () =>
        [
          "# TrueNAS connection",
          "",
          `- **URL**: ${output.truenas_url}`,
          `- **API key present**: ${output.api_key_present ? "yes" : "no"}`,
          `- **TLS verification**: ${output.tls_verification}`,
          output.api_mode ? `- **API mode**: ${output.api_mode}` : null,
          output.reachable !== undefined ? `- **Reachable**: ${output.reachable ? "yes" : "no"}` : null,
          output.authenticated !== undefined
            ? `- **Authenticated**: ${output.authenticated ? "yes" : "no"}`
            : null,
          output.truenas_version ? `- **Version**: ${output.truenas_version}` : null,
          output.hostname ? `- **Hostname**: ${output.hostname}` : null,
          output.uptime ? `- **Uptime**: ${output.uptime}` : null,
          output.probe_error ? `- **Probe error**: ${output.probe_error}` : null,
          output.hint ? `\n_${output.hint}_` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n")
      );
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
      outputSchema: z.object({
        version: z.string().nullable(),
        hostname: z.string().nullable(),
        uptime: z.string().nullable(),
        cpu_model: z.string().nullable(),
        cores: z.number().nullable(),
        physical_cores: z.number().nullable(),
        memory: z.string(),
        memory_bytes: z.number().nullable(),
        loadavg: z.array(z.number()).nullable(),
        boottime: z.string().nullable(),
        timezone: z.string().nullable(),
        ecc_memory: z.boolean().nullable(),
      }),
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
      outputSchema: z.object({
        count: z.number(),
        pools: z.array(
          z.object({
            name: z.string().nullable(),
            status: z.string().nullable(),
            healthy: z.boolean().nullable(),
            warning: z.boolean().nullable(),
            status_detail: z.string().nullable(),
            size: z.string(),
            allocated: z.string(),
            free: z.string(),
            size_bytes: z.number().nullable(),
            allocated_bytes: z.number().nullable(),
            free_bytes: z.number().nullable(),
            usage_percent: z.number().nullable(),
            fragmentation_percent: z.string().nullable(),
            scan: z
              .object({ function: z.string().nullable(), percent: z.number().nullable() })
              .nullable(),
          })
        ),
      }),
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
      outputSchema: z.object({
        count: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        next_offset: z.number().nullable(),
        datasets: z.array(
          z.object({
            name: z.string().nullable(),
            pool: z.string().nullable(),
            type: z.string().nullable(),
            mountpoint: z.string().nullable(),
            encrypted: z.boolean(),
            locked: z.boolean(),
            used: z.string().nullable(),
            used_bytes: z.number().nullable(),
            available: z.string().nullable(),
            available_bytes: z.number().nullable(),
            used_by_snapshots: z.string().nullable(),
            quota: z.string().nullable(),
            compression: z.string().nullable(),
            compression_ratio: z.string().nullable(),
            readonly: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ pool, limit, offset, response_format }): Promise<ToolResult> => {
      try {
        // Fetch one extra row so has_more is accurate (a page that exactly
        // fills `limit` would otherwise falsely advertise another page).
        const raw = (await getClient().datasets({ pool, limit: limit + 1, offset })) as RawDataset[];
        const has_more = raw.length > limit;
        const page = has_more ? raw.slice(0, limit) : raw;
        const datasets = page.map((d) => ({
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
          has_more,
          next_offset: has_more ? offset + limit : null,
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
      outputSchema: z.object({
        count: z.number(),
        alerts: z.array(
          z.object({
            level: z.string().nullable(),
            text: z.string().nullable(),
            source: z.string().nullable(),
            first_seen: z.string().nullable(),
            last_occurrence: z.string().nullable(),
            dismissed: z.boolean(),
            uuid: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ include_dismissed, min_level, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().alerts()) as RawAlert[];
        const minIndex = min_level ? ALERT_LEVELS.indexOf(min_level) : 0;
        // An unrecognized/renamed severity must not vanish from the report:
        // clamp unknown levels to the INFO floor (0) instead of -1.
        const levelIndex = (level: string | undefined): number => {
          const i = ALERT_LEVELS.indexOf((level ?? "INFO") as AlertLevel);
          return i === -1 ? 0 : i;
        };
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
      outputSchema: z.object({
        count: z.number(),
        disks: z.array(
          z.object({
            name: z.string().nullable(),
            device: z.string().nullable(),
            model: z.string().nullable(),
            serial: z.string().nullable(),
            size: z.string(),
            size_bytes: z.number().nullable(),
            type: z.string().nullable(),
            rotation_rpm: z.number().nullable(),
            pool: z.string().nullable(),
            bus: z.string().nullable(),
            temperature_c: z.number().nullable().optional(),
          })
        ),
        temperature_error: z.string().optional(),
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
      outputSchema: z.object({
        count: z.number(),
        services: z.array(
          z.object({
            service: z.string().nullable(),
            state: z.string().nullable(),
            start_on_boot: z.boolean().nullable(),
          })
        ),
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
      outputSchema: z.object({
        count: z.number(),
        jobs: z.array(
          z.object({
            id: z.number().nullable(),
            method: z.string().nullable(),
            description: z.string().nullable(),
            state: z.string().nullable(),
            progress_percent: z.number().nullable(),
            progress_description: z.string().nullable(),
            error: z.string().nullable(),
            started: z.string().nullable(),
            finished: z.string().nullable(),
          })
        ),
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
      outputSchema: z.object({
        count: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        next_offset: z.number().nullable(),
        snapshots: z.array(
          z.object({
            id: z.string().nullable(),
            dataset: z.string().nullable(),
            name: z.string().nullable(),
            created: z.string().nullable(),
            used: z.string().nullable(),
            referenced: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ dataset, limit, offset, response_format }): Promise<ToolResult> => {
      try {
        // Fetch one extra row so has_more is accurate (see datasets tool).
        const raw = (await getClient().snapshots({ dataset, limit: limit + 1, offset })) as RawSnapshot[];
        const has_more = raw.length > limit;
        const page = has_more ? raw.slice(0, limit) : raw;
        const snapshots = page.map((s) => {
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
          has_more,
          next_offset: has_more ? offset + limit : null,
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
      outputSchema: z.object({
        update_available: z.boolean(),
        current_version: z.string().nullable(),
        train: z.string().nullable(),
        new_version: z.string().nullable(),
        release_notes_url: z.string().nullable(),
        reboot_required: z.boolean().nullable(),
        reboot_reasons: z.array(z.string()),
      }),
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

  // ---------------- apps ----------------
  server.registerTool(
    "truenas_list_apps",
    {
      title: "List Apps & Available Updates",
      description:
        "List installed TrueNAS apps (the Docker-based Apps catalog, 24.10+) with their running state, " +
        "current version, and — the key part — whether an app or catalog update is available " +
        "(upgrade_available / image_updates_available). Also reports the Docker backend's status. This is " +
        "the app-level counterpart to truenas_check_updates, which only covers the base OS.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        upgrades_available: z.number(),
        docker_status: z.string().nullable(),
        apps: z.array(
          z.object({
            name: z.string().nullable(),
            title: z.string().nullable(),
            state: z.string().nullable(),
            version: z.string().nullable(),
            latest_version: z.string().nullable(),
            upgrade_available: z.boolean(),
            image_updates_available: z.boolean(),
            custom_app: z.boolean(),
            train: z.string().nullable(),
            portals: z.record(z.string(), z.string()),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const raw = (await client.apps()) as Array<{
          name?: string;
          id?: string;
          state?: string;
          version?: string;
          human_version?: string;
          latest_version?: string;
          upgrade_available?: boolean;
          image_updates_available?: boolean;
          custom_app?: boolean;
          metadata?: { title?: string; train?: string };
          portals?: Record<string, string>;
        }>;
        let dockerStatus: string | null = null;
        try {
          const d = (await client.dockerStatus()) as { status?: string };
          dockerStatus = d?.status ?? null;
        } catch {
          // Docker status is context, not essential; ignore if unavailable.
        }
        const apps = raw.map((a) => ({
          name: a.name ?? a.id ?? null,
          title: a.metadata?.title ?? null,
          state: a.state ?? null,
          version: a.human_version ?? a.version ?? null,
          latest_version: a.latest_version ?? null,
          upgrade_available: a.upgrade_available ?? false,
          image_updates_available: a.image_updates_available ?? false,
          custom_app: a.custom_app ?? false,
          train: a.metadata?.train ?? null,
          portals: a.portals ?? {},
        }));
        const upgrades = apps.filter((a) => a.upgrade_available || a.image_updates_available).length;
        const structured = {
          count: apps.length,
          upgrades_available: upgrades,
          docker_status: dockerStatus,
          apps,
        };
        return respond(structured, response_format, () => {
          const header =
            `**${upgrades}** of **${apps.length}** app(s) have updates available` +
            (dockerStatus ? ` · Docker: ${dockerStatus}` : "") +
            ".\n\n";
          if (apps.length === 0) return header + "No apps installed.";
          return (
            header +
            mdTable(
              ["App", "State", "Version", "Latest", "Update"],
              apps.map((a) => [
                a.name,
                a.state,
                a.version,
                a.latest_version,
                a.upgrade_available ? "yes" : a.image_updates_available ? "image only" : "no",
              ])
            )
          );
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- replication tasks ----------------
  server.registerTool(
    "truenas_list_replication_tasks",
    {
      title: "List Replication Tasks",
      description:
        "List configured ZFS replication tasks (backup jobs that send snapshots to another dataset or a " +
        "remote box) with direction, transport, whether they're enabled, and last-run state. Unlike " +
        "truenas_list_jobs, this shows the task CONFIGURATION even when nothing is running.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        tasks: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            direction: z.string().nullable(),
            transport: z.string().nullable(),
            enabled: z.boolean().nullable(),
            auto: z.boolean().nullable(),
            source_datasets: z.array(z.string()),
            target_dataset: z.string().nullable(),
            state: z.string().nullable(),
            last_run: z.string().nullable(),
            last_error: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().replicationTasks()) as Array<{
          id?: number;
          name?: string;
          direction?: string;
          transport?: string;
          enabled?: boolean;
          auto?: boolean;
          source_datasets?: string[];
          target_dataset?: string;
          state?: { state?: string; last_error?: string | null; datetime?: string };
        }>;
        const tasks = raw.map((t) => ({
          id: t.id ?? null,
          name: t.name ?? null,
          direction: t.direction ?? null,
          transport: t.transport ?? null,
          enabled: t.enabled ?? null,
          auto: t.auto ?? null,
          source_datasets: t.source_datasets ?? [],
          target_dataset: t.target_dataset ?? null,
          state: t.state?.state ?? null,
          last_run: t.state?.datetime ?? null,
          last_error: t.state?.last_error ?? null,
        }));
        const structured = { count: tasks.length, tasks };
        return respond(structured, response_format, () =>
          tasks.length === 0
            ? "No replication tasks configured."
            : mdTable(
                ["Name", "Direction", "Transport", "Enabled", "Target", "Last state"],
                tasks.map((t) => [
                  t.name,
                  t.direction,
                  t.transport,
                  t.enabled === null ? null : t.enabled ? "yes" : "no",
                  t.target_dataset,
                  t.state,
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- cloud sync tasks ----------------
  server.registerTool(
    "truenas_list_cloudsync_tasks",
    {
      title: "List Cloud Sync Tasks",
      description:
        "List configured cloud sync tasks (backups to/from S3, Google Drive, Backblaze, etc.) with local " +
        "path, direction, provider, schedule, and last-run state. Credentials, tokens, and secrets are " +
        "deliberately never included.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        tasks: z.array(
          z.object({
            id: z.number().nullable(),
            description: z.string().nullable(),
            path: z.string().nullable(),
            direction: z.string().nullable(),
            transfer_mode: z.string().nullable(),
            enabled: z.boolean().nullable(),
            provider: z.string().nullable(),
            credential_name: z.string().nullable(),
            schedule: z.string().nullable(),
            include_rules: z.number(),
            last_run_state: z.string().nullable(),
            last_run_finished: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        // NOTE: cloudsync.query returns full provider credentials (client_secret,
        // OAuth access/refresh tokens). We read ONLY non-sensitive fields — never
        // credentials.provider secrets or the token blob.
        const raw = (await getClient().cloudsyncTasks()) as Array<{
          id?: number;
          description?: string;
          path?: string;
          direction?: string;
          transfer_mode?: string;
          enabled?: boolean;
          include?: string[];
          credentials?: { name?: string; provider?: { type?: string } };
          schedule?: { minute?: string; hour?: string; dom?: string; month?: string; dow?: string };
          job?: { state?: string; time_finished?: string } | null;
        }>;
        const tasks = raw.map((t) => ({
          id: t.id ?? null,
          description: t.description ?? null,
          path: t.path ?? null,
          direction: t.direction ?? null,
          transfer_mode: t.transfer_mode ?? null,
          enabled: t.enabled ?? null,
          provider: t.credentials?.provider?.type ?? null,
          credential_name: t.credentials?.name ?? null,
          schedule: cronStr(t.schedule),
          include_rules: Array.isArray(t.include) ? t.include.length : 0,
          last_run_state: t.job?.state ?? null,
          last_run_finished: t.job?.time_finished ?? null,
        }));
        const structured = { count: tasks.length, tasks };
        return respond(structured, response_format, () =>
          tasks.length === 0
            ? "No cloud sync tasks configured."
            : mdTable(
                ["Description", "Provider", "Direction", "Path", "Enabled", "Last state"],
                tasks.map((t) => [
                  t.description,
                  t.provider,
                  t.direction,
                  t.path,
                  t.enabled === null ? null : t.enabled ? "yes" : "no",
                  t.last_run_state,
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- shares (SMB / NFS / iSCSI) ----------------
  server.registerTool(
    "truenas_list_shares",
    {
      title: "List Shares (SMB / NFS / iSCSI)",
      description:
        "List all configured file and block shares in one call: SMB shares, NFS exports, and iSCSI targets, " +
        "each with their name/path and enabled state. Answers 'what is this NAS actually serving?'.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        smb: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            path: z.string().nullable(),
            enabled: z.boolean().nullable(),
            purpose: z.string().nullable(),
            comment: z.string().nullable(),
            readonly: z.boolean().nullable(),
            browsable: z.boolean().nullable(),
            locked: z.boolean().nullable(),
          })
        ),
        nfs: z.array(
          z.object({
            id: z.number().nullable(),
            path: z.string().nullable(),
            enabled: z.boolean().nullable(),
            comment: z.string().nullable(),
            networks: z.array(z.string()),
            hosts: z.array(z.string()),
            readonly: z.boolean().nullable(),
          })
        ),
        iscsi: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            alias: z.string().nullable(),
            mode: z.string().nullable(),
          })
        ),
        errors: z.record(z.string(), z.string()).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      const client = getClient();
      const errors: Record<string, string> = {};
      const grab = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
        try {
          return await fn();
        } catch (error) {
          errors[label] = error instanceof Error ? error.message : String(error);
          return [];
        }
      };
      const [smbRaw, nfsRaw, iscsiRaw] = await Promise.all([
        grab("smb", () =>
          client.smbShares() as Promise<
            Array<{
              id?: number;
              name?: string;
              path?: string;
              enabled?: boolean;
              purpose?: string;
              comment?: string;
              readonly?: boolean;
              browsable?: boolean;
              locked?: boolean;
            }>
          >
        ),
        grab("nfs", () =>
          client.nfsShares() as Promise<
            Array<{
              id?: number;
              path?: string;
              paths?: string[];
              enabled?: boolean;
              comment?: string;
              networks?: string[];
              hosts?: string[];
              ro?: boolean;
            }>
          >
        ),
        grab("iscsi", () =>
          client.iscsiTargets() as Promise<
            Array<{ id?: number; name?: string; alias?: string | null; mode?: string }>
          >
        ),
      ]);
      const smb = smbRaw.map((s) => ({
        id: s.id ?? null,
        name: s.name ?? null,
        path: s.path ?? null,
        enabled: s.enabled ?? null,
        purpose: s.purpose ?? null,
        comment: s.comment ?? null,
        readonly: s.readonly ?? null,
        browsable: s.browsable ?? null,
        locked: s.locked ?? null,
      }));
      const nfs = nfsRaw.map((s) => ({
        id: s.id ?? null,
        path: s.path ?? (Array.isArray(s.paths) ? s.paths.join(", ") : null),
        enabled: s.enabled ?? null,
        comment: s.comment ?? null,
        networks: s.networks ?? [],
        hosts: s.hosts ?? [],
        readonly: s.ro ?? null,
      }));
      const iscsi = iscsiRaw.map((t) => ({
        id: t.id ?? null,
        name: t.name ?? null,
        alias: t.alias ?? null,
        mode: t.mode ?? null,
      }));
      const structured = {
        smb,
        nfs,
        iscsi,
        ...(Object.keys(errors).length ? { errors } : {}),
      };
      return respond(structured, response_format, () => {
        const lines = [
          `**SMB**: ${smb.length} · **NFS**: ${nfs.length} · **iSCSI targets**: ${iscsi.length}`,
          "",
        ];
        if (smb.length)
          lines.push(
            "### SMB",
            mdTable(
              ["Name", "Path", "Enabled", "Read-only"],
              smb.map((s) => [
                s.name,
                s.path,
                s.enabled === null ? null : s.enabled ? "yes" : "no",
                s.readonly === null ? null : s.readonly ? "yes" : "no",
              ])
            ),
            ""
          );
        if (nfs.length)
          lines.push(
            "### NFS",
            mdTable(
              ["Path", "Enabled", "Networks"],
              nfs.map((s) => [s.path, s.enabled === null ? null : s.enabled ? "yes" : "no", s.networks.join(", ")])
            ),
            ""
          );
        if (iscsi.length)
          lines.push(
            "### iSCSI",
            mdTable(
              ["Name", "Alias", "Mode"],
              iscsi.map((t) => [t.name, t.alias, t.mode])
            ),
            ""
          );
        if (Object.keys(errors).length)
          lines.push(`_Some share types could not be read: ${JSON.stringify(errors)}_`);
        return lines.join("\n");
      });
    }
  );

  // ---------------- network ----------------
  server.registerTool(
    "truenas_list_network",
    {
      title: "Network Status",
      description:
        "Compact network health view: a summary of IP addresses per interface, default routes, and DNS " +
        "nameservers, plus per-interface type, link state, MAC, addresses, and MTU. The first stop for " +
        "'is the NAS's networking okay?' or diagnosing a down NIC.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        summary: z.object({
          default_routes: z.array(z.string()),
          nameservers: z.array(z.string()),
          ips: z.record(z.string(), z.unknown()),
        }),
        interfaces: z.array(
          z.object({
            name: z.string().nullable(),
            type: z.string().nullable(),
            link_state: z.string().nullable(),
            mac: z.string().nullable(),
            addresses: z.array(z.string()),
            dhcp: z.boolean().nullable(),
            mtu: z.number().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const summaryRaw = (await client.networkSummary()) as {
          ips?: Record<string, unknown>;
          default_routes?: string[];
          nameservers?: string[];
        };
        const raw = (await client.interfaces()) as Array<{
          id?: string;
          name?: string;
          type?: string;
          mtu?: number | null;
          ipv4_dhcp?: boolean;
          aliases?: Array<{ type?: string; address?: string; netmask?: number }>;
          state?: {
            link_state?: string;
            link_address?: string;
            aliases?: Array<{ type?: string; address?: string; netmask?: number }>;
          };
        }>;
        const interfaces = raw.map((i) => {
          const aliases = (i.aliases && i.aliases.length ? i.aliases : i.state?.aliases) ?? [];
          const addresses = aliases
            .filter((a) => a.type === "INET" || a.type === "INET6")
            .map((a) => `${a.address}${a.netmask != null ? "/" + a.netmask : ""}`);
          return {
            name: i.name ?? i.id ?? null,
            type: i.type ?? null,
            link_state: i.state?.link_state ?? null,
            mac: i.state?.link_address ?? null,
            addresses,
            dhcp: i.ipv4_dhcp ?? null,
            mtu: i.mtu ?? null,
          };
        });
        const structured = {
          summary: {
            default_routes: summaryRaw.default_routes ?? [],
            nameservers: summaryRaw.nameservers ?? [],
            ips: summaryRaw.ips ?? {},
          },
          interfaces,
        };
        return respond(structured, response_format, () =>
          [
            `**Default routes**: ${structured.summary.default_routes.join(", ") || "—"}`,
            `**Nameservers**: ${structured.summary.nameservers.join(", ") || "—"}`,
            "",
            mdTable(
              ["Interface", "Type", "Link", "Addresses", "MTU"],
              interfaces.map((i) => [i.name, i.type, i.link_state, i.addresses.join(", "), i.mtu])
            ),
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- snapshot tasks ----------------
  server.registerTool(
    "truenas_list_snapshot_tasks",
    {
      title: "List Periodic Snapshot Tasks",
      description:
        "List configured periodic (automatic) snapshot tasks with their dataset, retention policy, schedule, " +
        "and whether they're enabled. truenas_list_snapshots shows the snapshots that EXIST; this shows " +
        "whether an automatic snapshot POLICY is actually running.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        tasks: z.array(
          z.object({
            id: z.number().nullable(),
            dataset: z.string().nullable(),
            recursive: z.boolean().nullable(),
            enabled: z.boolean().nullable(),
            retention: z.string().nullable(),
            naming_schema: z.string().nullable(),
            schedule: z.string().nullable(),
            last_state: z.string().nullable(),
            last_snapshot: z.string().nullable(),
            last_run: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().snapshotTasks()) as Array<{
          id?: number;
          dataset?: string;
          recursive?: boolean;
          enabled?: boolean;
          lifetime_value?: number;
          lifetime_unit?: string;
          naming_schema?: string;
          schedule?: { minute?: string; hour?: string; dom?: string; month?: string; dow?: string };
          state?: { state?: string; datetime?: string; last_snapshot?: string };
        }>;
        const tasks = raw.map((t) => ({
          id: t.id ?? null,
          dataset: t.dataset ?? null,
          recursive: t.recursive ?? null,
          enabled: t.enabled ?? null,
          retention:
            t.lifetime_value != null ? `${t.lifetime_value} ${t.lifetime_unit ?? ""}`.trim() : null,
          naming_schema: t.naming_schema ?? null,
          schedule: cronStr(t.schedule),
          last_state: t.state?.state ?? null,
          last_snapshot: t.state?.last_snapshot ?? null,
          last_run: t.state?.datetime ?? null,
        }));
        const structured = { count: tasks.length, tasks };
        return respond(structured, response_format, () =>
          tasks.length === 0
            ? "No periodic snapshot tasks configured."
            : mdTable(
                ["Dataset", "Recursive", "Retention", "Schedule", "Enabled", "Last snapshot"],
                tasks.map((t) => [
                  t.dataset,
                  t.recursive === null ? null : t.recursive ? "yes" : "no",
                  t.retention,
                  t.schedule,
                  t.enabled === null ? null : t.enabled ? "yes" : "no",
                  t.last_snapshot,
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- scrub tasks ----------------
  server.registerTool(
    "truenas_list_scrub_tasks",
    {
      title: "List Scheduled Scrub Tasks",
      description:
        "List scheduled pool scrub tasks with their pool, schedule, threshold (minimum days between scrubs), " +
        "and enabled state. Complements truenas_list_pools, which shows a scrub only while it's running.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        tasks: z.array(
          z.object({
            id: z.number().nullable(),
            pool: z.string().nullable(),
            threshold_days: z.number().nullable(),
            enabled: z.boolean().nullable(),
            schedule: z.string().nullable(),
            description: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().scrubTasks()) as Array<{
          id?: number;
          pool_name?: string;
          threshold?: number;
          description?: string;
          enabled?: boolean;
          schedule?: { minute?: string; hour?: string; dom?: string; month?: string; dow?: string };
        }>;
        const tasks = raw.map((t) => ({
          id: t.id ?? null,
          pool: t.pool_name ?? null,
          threshold_days: t.threshold ?? null,
          enabled: t.enabled ?? null,
          schedule: cronStr(t.schedule),
          description: t.description ?? null,
        }));
        const structured = { count: tasks.length, tasks };
        return respond(structured, response_format, () =>
          tasks.length === 0
            ? "No scheduled scrub tasks configured."
            : mdTable(
                ["Pool", "Schedule", "Threshold (days)", "Enabled"],
                tasks.map((t) => [
                  t.pool,
                  t.schedule,
                  t.threshold_days,
                  t.enabled === null ? null : t.enabled ? "yes" : "no",
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- virtual machines ----------------
  server.registerTool(
    "truenas_list_vms",
    {
      title: "List Virtual Machines",
      description:
        "List virtual machines with their run state, autostart, vCPU/memory allocation, bootloader, and a " +
        "device summary (disk/NIC counts, whether a display is attached). Device details, including any VNC " +
        "display password, are deliberately omitted.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        vms: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            description: z.string().nullable(),
            state: z.string().nullable(),
            autostart: z.boolean().nullable(),
            vcpus: z.number().nullable(),
            cores: z.number().nullable(),
            threads: z.number().nullable(),
            memory_mib: z.number().nullable(),
            bootloader: z.string().nullable(),
            disks: z.number(),
            nics: z.number(),
            has_display: z.boolean(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        // NOTE: vm.query returns device attributes including a VNC DISPLAY
        // password in cleartext. We summarize devices by type only and never
        // surface their attributes.
        const raw = (await getClient().vms()) as Array<{
          id?: number;
          name?: string;
          description?: string;
          vcpus?: number;
          cores?: number;
          threads?: number;
          memory?: number;
          autostart?: boolean;
          bootloader?: string;
          status?: { state?: string };
          devices?: Array<{ attributes?: { dtype?: string } }>;
        }>;
        const vms = raw.map((v) => {
          const devs = v.devices ?? [];
          const countType = (t: string) => devs.filter((d) => d.attributes?.dtype === t).length;
          return {
            id: v.id ?? null,
            name: v.name ?? null,
            description: v.description ?? null,
            state: v.status?.state ?? null,
            autostart: v.autostart ?? null,
            vcpus: v.vcpus ?? null,
            cores: v.cores ?? null,
            threads: v.threads ?? null,
            memory_mib: v.memory ?? null,
            bootloader: v.bootloader ?? null,
            disks: countType("DISK"),
            nics: countType("NIC"),
            has_display: countType("DISPLAY") > 0,
          };
        });
        const structured = { count: vms.length, vms };
        return respond(structured, response_format, () =>
          vms.length === 0
            ? "No virtual machines configured."
            : mdTable(
                ["Name", "State", "Autostart", "vCPUs", "Memory (MiB)", "Disks", "NICs"],
                vms.map((v) => [
                  v.name,
                  v.state,
                  v.autostart === null ? null : v.autostart ? "yes" : "no",
                  v.vcpus,
                  v.memory_mib,
                  v.disks,
                  v.nics,
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ================================================================
  // Safe writes (Tier W) — registered ONLY when TRUENAS_ENABLE_WRITE=1.
  // Reversible mutations; never set readOnlyHint. Every call is audit-logged to
  // stderr, and when TRUENAS_TEST_DATASET is set, restricted to that dataset.
  // ================================================================
  if (config.enableWrite) {
    // ---------------- create snapshot ----------------
    server.registerTool(
      "truenas_create_snapshot",
      {
        title: "Create ZFS Snapshot",
        description:
          "Create a ZFS snapshot of a dataset (optionally recursive). A safe, reversible write — the snapshot " +
          "can be listed and later deleted. Ideal for 'take a snapshot before I change X'. Only available when " +
          "the server was started with TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Dataset to snapshot, e.g. 'tank/appdata'"),
          name: z.string().describe("Snapshot name — the part after '@', e.g. 'manual-2026-08-08'"),
          recursive: z.boolean().default(false).describe("Also snapshot child datasets"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({
          created: z.boolean(),
          snapshot: z.string(),
          dataset: z.string(),
          name: z.string(),
          recursive: z.boolean(),
        }),
        annotations: SAFE_WRITE,
      },
      async ({ dataset, name, recursive, response_format }): Promise<ToolResult> => {
        const snapId = `${dataset}@${name}`;
        try {
          assertAllowedTarget(config, dataset);
          const raw = (await getClient().createSnapshot({ dataset, name, recursive })) as {
            id?: string;
            name?: string;
          };
          const created = raw?.id ?? raw?.name ?? snapId;
          auditLog({
            tool: "truenas_create_snapshot",
            method: "pool.snapshot.create",
            target: created,
            outcome: "success",
          });
          const structured = { created: true, snapshot: created, dataset, name, recursive };
          return respond(
            structured,
            response_format,
            () => `Created snapshot **${created}**${recursive ? " (recursive)" : ""}.`
          );
        } catch (error) {
          auditLog({
            tool: "truenas_create_snapshot",
            method: "pool.snapshot.create",
            target: snapId,
            outcome: `error: ${error instanceof Error ? error.message : String(error)}`,
          });
          return errorResult(error);
        }
      }
    );

    // ---------------- update dataset properties ----------------
    server.registerTool(
      "truenas_update_dataset",
      {
        title: "Update Dataset Properties",
        description:
          "Update properties of an EXISTING ZFS dataset (comment, compression, readonly, atime, sync, or " +
          "quota). A reversible write: it changes settings only — it does NOT create or delete datasets or " +
          "modify their data. Supply only the properties you want to change. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Dataset ID / full path, e.g. 'tank/appdata'"),
          comments: z.string().optional().describe("Free-text comment on the dataset"),
          compression: z
            .enum(["INHERIT", "OFF", "LZ4", "ZSTD", "GZIP", "ON"])
            .optional()
            .describe("Compression algorithm"),
          readonly: z.enum(["ON", "OFF", "INHERIT"]).optional().describe("Make the dataset read-only"),
          atime: z.enum(["ON", "OFF", "INHERIT"]).optional().describe("Update access times on read"),
          sync: z
            .enum(["STANDARD", "ALWAYS", "DISABLED", "INHERIT"])
            .optional()
            .describe("Synchronous write behavior"),
          quota_bytes: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Dataset quota in bytes (0 removes the quota; the minimum non-zero quota is 1 GiB)"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({
          updated: z.boolean(),
          dataset: z.string(),
          applied: z.record(z.string(), z.unknown()),
        }),
        annotations: SAFE_WRITE,
      },
      async ({
        dataset,
        comments,
        compression,
        readonly,
        atime,
        sync,
        quota_bytes,
        response_format,
      }): Promise<ToolResult> => {
        try {
          assertAllowedTarget(config, dataset);
          const data: Record<string, unknown> = {};
          if (comments !== undefined) data.comments = comments;
          if (compression !== undefined) data.compression = compression;
          if (readonly !== undefined) data.readonly = readonly;
          if (atime !== undefined) data.atime = atime;
          if (sync !== undefined) data.sync = sync;
          if (quota_bytes !== undefined) data.quota = quota_bytes;
          if (Object.keys(data).length === 0) {
            throw new TrueNasError(
              "No properties supplied — set at least one of comments/compression/readonly/atime/sync/quota_bytes."
            );
          }
          await getClient().updateDataset(dataset, data);
          auditLog({ tool: "truenas_update_dataset", method: "pool.dataset.update", target: dataset, outcome: "success" });
          const structured = { updated: true, dataset, applied: data };
          return respond(structured, response_format, () =>
            `Updated **${dataset}**: ${Object.entries(data)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(", ")}.`
          );
        } catch (error) {
          auditLog({
            tool: "truenas_update_dataset",
            method: "pool.dataset.update",
            target: dataset,
            outcome: `error: ${error instanceof Error ? error.message : String(error)}`,
          });
          return errorResult(error);
        }
      }
    );

    // ---------------- control a service ----------------
    server.registerTool(
      "truenas_control_service",
      {
        title: "Start / Stop / Restart a Service",
        description:
          "Start, stop, restart, or reload a TrueNAS service (e.g. smb, nfs, ssh, iscsitarget). STOP interrupts " +
          "availability for anything using that service, but is reversible — start it again. Runs as a job; the " +
          "result reports the final state. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          service: z.string().describe("Service name, e.g. 'smb', 'nfs', 'ssh', 'iscsitarget'"),
          action: z.enum(["START", "STOP", "RESTART", "RELOAD"]).describe("What to do to the service"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({
          service: z.string(),
          action: z.string(),
          job_id: z.number().nullable(),
          state: z.string(),
          error: z.string().nullable(),
        }),
        annotations: SAFE_WRITE,
      },
      async ({ service, action, response_format }): Promise<ToolResult> => {
        try {
          const out = await getClient().controlService(action, service);
          auditLog({
            tool: "truenas_control_service",
            method: "service.control",
            target: `${action} ${service}`,
            outcome: out.error ? `error: ${out.error}` : out.state,
          });
          const structured = { service, action, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error
              ? `Service **${service}** ${action} failed: ${out.error}`
              : `Service **${service}**: ${action} → **${out.state}**${out.jobId ? ` (job ${out.jobId})` : ""}.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_control_service", method: "service.control", target: `${action} ${service}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- service start-on-boot ----------------
    server.registerTool(
      "truenas_set_service_boot",
      {
        title: "Set Service Start-on-Boot",
        description:
          "Enable or disable whether a service starts automatically at boot. This does NOT start or stop it now " +
          "(use truenas_control_service for that). Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          service: z.string().describe("Service name, e.g. 'smb'"),
          start_on_boot: z.boolean().describe("Whether the service should start on boot"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ service: z.string(), start_on_boot: z.boolean() }),
        annotations: SAFE_WRITE,
      },
      async ({ service, start_on_boot, response_format }): Promise<ToolResult> => {
        try {
          await getClient().setServiceBoot(service, start_on_boot);
          auditLog({ tool: "truenas_set_service_boot", method: "service.update", target: service, outcome: "success" });
          const structured = { service, start_on_boot };
          return respond(
            structured,
            response_format,
            () => `Service **${service}** start-on-boot **${start_on_boot ? "enabled" : "disabled"}**.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_set_service_boot", method: "service.update", target: service, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- app lifecycle ----------------
    server.registerTool(
      "truenas_manage_app",
      {
        title: "Manage an App (start/stop/redeploy/upgrade/rollback)",
        description:
          "Control an installed app's lifecycle. 'stop' interrupts the app (reversible with 'start'); 'redeploy' " +
          "pulls latest images and restarts; 'upgrade' moves to a newer catalog version; 'rollback' returns to a " +
          "prior version (requires app_version). Runs as a job. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          app: z.string().describe("App name, e.g. 'prometheus' (see truenas_list_apps)"),
          action: z
            .enum(["start", "stop", "redeploy", "upgrade", "rollback"])
            .describe("Lifecycle action to perform"),
          app_version: z
            .string()
            .optional()
            .describe("Target version — REQUIRED for rollback; optional for upgrade (defaults to latest)"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({
          app: z.string(),
          action: z.string(),
          job_id: z.number().nullable(),
          state: z.string(),
          error: z.string().nullable(),
        }),
        annotations: SAFE_WRITE,
      },
      async ({ app, action, app_version, response_format }): Promise<ToolResult> => {
        try {
          if (action === "rollback" && !app_version) {
            throw new TrueNasError("Rollback requires app_version — the target version to roll back to.");
          }
          const out = await getClient().appAction(action, app, app_version);
          auditLog({
            tool: "truenas_manage_app",
            method: `app.${action}`,
            target: app,
            outcome: out.error ? `error: ${out.error}` : out.state,
          });
          const structured = { app, action, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error
              ? `App **${app}** ${action} failed: ${out.error}`
              : `App **${app}**: ${action} → **${out.state}**${out.jobId ? ` (job ${out.jobId})` : ""}.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_manage_app", method: `app.${action}`, target: app, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- vm lifecycle ----------------
    server.registerTool(
      "truenas_manage_vm",
      {
        title: "Manage a VM (start/stop/restart/suspend/resume)",
        description:
          "Control a virtual machine's run state by id. 'stop' asks the guest to shut down gracefully (reversible " +
          "with 'start'); 'restart' reboots it; 'suspend'/'resume' pause and continue it. Requires " +
          "TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("VM id (see truenas_list_vms)"),
          action: z.enum(["start", "stop", "restart", "suspend", "resume"]).describe("Lifecycle action"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({
          id: z.number(),
          action: z.string(),
          job_id: z.number().nullable(),
          state: z.string(),
          error: z.string().nullable(),
        }),
        annotations: SAFE_WRITE,
      },
      async ({ id, action, response_format }): Promise<ToolResult> => {
        try {
          const out = await getClient().vmAction(action, id);
          auditLog({
            tool: "truenas_manage_vm",
            method: `vm.${action}`,
            target: `vm:${id}`,
            outcome: out.error ? `error: ${out.error}` : out.state,
          });
          const structured = { id, action, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error
              ? `VM ${id} ${action} failed: ${out.error}`
              : `VM **${id}**: ${action} → **${out.state}**${out.jobId ? ` (job ${out.jobId})` : ""}.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_manage_vm", method: `vm.${action}`, target: `vm:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- run a scrub ----------------
    server.registerTool(
      "truenas_run_scrub",
      {
        title: "Run a Pool Scrub",
        description:
          "Start a manual ZFS scrub on a pool (a read-only integrity check of stored data — safe, and it can be " +
          "left to run). Optionally only start if the last scrub was more than threshold_days ago. Requires " +
          "TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          pool: z.string().describe("Pool name, e.g. 'tank'"),
          threshold_days: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Only start if the last scrub was more than this many days ago (default 35)"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ started: z.boolean(), pool: z.string(), threshold_days: z.number().nullable() }),
        annotations: SAFE_WRITE,
      },
      async ({ pool, threshold_days, response_format }): Promise<ToolResult> => {
        try {
          await getClient().runScrub(pool, threshold_days);
          auditLog({ tool: "truenas_run_scrub", method: "pool.scrub.run", target: pool, outcome: "success" });
          const structured = { started: true, pool, threshold_days: threshold_days ?? null };
          return respond(structured, response_format, () => `Started a scrub on pool **${pool}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_run_scrub", method: "pool.scrub.run", target: pool, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );
  }
}
