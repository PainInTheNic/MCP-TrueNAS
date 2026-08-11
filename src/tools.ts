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
import { inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TrueNasClient, TrueNasConfig, TrueNasError } from "./truenas-client.js";
import type { JobOutcome, RsyncTaskOptions, VmOptions } from "./truenas-client.js";

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

// Destructive (irreversible / availability-loss) writes. destructiveHint nudges
// clients to prompt, but the real gate is the env flag + the elicitation
// confirmation in confirmDestructive() (annotations are only advisory hints).
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GateArgs = Record<string, any>;
type GateResult = { proceed: true } | { halt: ToolResult | ReturnType<typeof inputRequired> };

/**
 * Human-confirmation gate for destructive ops, via MCP elicitation:
 *  - no elicitation capability on the client  -> refuse (fail closed);
 *  - first call                                -> return an elicitation asking to confirm;
 *  - retry with explicit confirm=true (accept) -> proceed;
 *  - declined / cancelled / absent answer      -> refuse.
 * The env flag (TRUENAS_ENABLE_DESTRUCTIVE) already keeps these tools out of
 * tools/list entirely unless the operator opted in; this is the second gate.
 */
function confirmDestructive(server: McpServer, ctx: unknown, action: string): GateResult {
  const caps = (
    server as unknown as { server?: { getClientCapabilities?: () => { elicitation?: unknown } | undefined } }
  ).server?.getClientCapabilities?.();
  if (!caps?.elicitation) {
    return {
      halt: errorResult(
        new TrueNasError(
          `Refusing "${action}": destructive operations require a client that can prompt for human confirmation ` +
            `(MCP elicitation), and this client did not advertise that capability. Do it in the TrueNAS UI, or use ` +
            `an elicitation-capable client.`
        )
      ),
    };
  }
  const responses = (ctx as { mcpReq?: { inputResponses?: Record<string, unknown> } } | undefined)?.mcpReq
    ?.inputResponses;
  const accepted = acceptedContent<{ confirm?: boolean }>(responses ?? {}, "confirm");
  if (accepted?.confirm === true) return { proceed: true };
  const answered = !!responses && Object.prototype.hasOwnProperty.call(responses, "confirm");
  if (answered) {
    return { halt: errorResult(new TrueNasError(`"${action}" was not confirmed — no changes made.`)) };
  }
  return {
    halt: inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: `Confirm destructive action: ${action}. This cannot be undone.`,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: { type: "boolean", title: "Confirm", description: `Proceed with: ${action}?` },
            },
            required: ["confirm"],
          },
        }),
      },
    }),
  };
}

interface DestructiveSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  method: string;
  action: (args: GateArgs) => string;
  target: (args: GateArgs) => string;
  /** Dataset path to check against TRUENAS_TEST_DATASET, if any. */
  guardTarget?: (args: GateArgs) => string | undefined;
  run: (client: TrueNasClient, args: GateArgs) => Promise<unknown>;
  summary: (args: GateArgs) => string;
}

/** Register a destructive tool: env-gated (by the caller) + elicitation-gated + audit-logged. */
function registerDestructive(
  server: McpServer,
  config: TrueNasConfig,
  getClient: () => TrueNasClient,
  spec: DestructiveSpec
): void {
  server.registerTool(
    spec.name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { title: spec.title, description: spec.description, inputSchema: spec.inputSchema as any, annotations: DESTRUCTIVE },
    async (args: GateArgs, ctx: unknown) => {
      const label = spec.action(args);
      const gate = confirmDestructive(server, ctx, label);
      if ("halt" in gate) return gate.halt;
      try {
        const guard = spec.guardTarget?.(args);
        if (guard) assertAllowedTarget(config, guard);
        await spec.run(getClient(), args);
        auditLog({ tool: spec.name, method: spec.method, target: spec.target(args), outcome: "success" });
        const format = (args.response_format ?? "markdown") as "markdown" | "json";
        return respond({ done: true, action: label }, format, () => spec.summary(args));
      } catch (error) {
        auditLog({
          tool: spec.name,
          method: spec.method,
          target: spec.target(args),
          outcome: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
        return errorResult(error);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }
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
  // Phase 1: config & inventory reads (always on)
  // ================================================================

  // ---------------- system config ----------------
  server.registerTool(
    "truenas_system_config",
    {
      title: "System Configuration",
      description:
        "Read core system settings: state, general (timezone, web UI bind/port/HTTPS), advanced (console/serial/" +
        "syslog/kernel), security (FIPS/STIG/password policy), and which pool holds the system dataset. Secrets " +
        "(the UI certificate body) are omitted.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        state: z.string().nullable(),
        general: z.record(z.string(), z.unknown()),
        advanced: z.record(z.string(), z.unknown()),
        security: z.record(z.string(), z.unknown()),
        system_dataset: z.record(z.string(), z.unknown()),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const general = { ...(await client.systemGeneralConfig()) };
        const cert = general.ui_certificate as { id?: unknown; name?: unknown } | undefined;
        if (cert && typeof cert === "object") general.ui_certificate = { id: cert.id ?? null, name: cert.name ?? null };
        const advanced = { ...(await client.systemAdvancedConfig()) };
        delete advanced.anonstats_token;
        const security = await client.systemSecurityConfig();
        const systemDataset = await client.systemDatasetConfig();
        const state = (await client.systemState()) as string;
        const structured = { state, general, advanced, security, system_dataset: systemDataset };
        return respond(structured, response_format, () =>
          [
            `**State**: ${state}`,
            `**Timezone**: ${general.timezone ?? "—"}`,
            `**System dataset pool**: ${systemDataset.pool ?? "—"}`,
            `**FIPS**: ${security.enable_fips ? "on" : "off"} · **STIG**: ${security.enable_gpos_stig ? "on" : "off"}`,
            `**Boot scrub interval**: ${advanced.boot_scrub ?? "—"} days`,
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- init/shutdown scripts ----------------
  server.registerTool(
    "truenas_list_init_scripts",
    {
      title: "List Init/Shutdown Scripts",
      description:
        "List custom Init/Shutdown scripts and commands (System → Advanced → Init/Shutdown Scripts): each with its " +
        "type (command or script), the command/path, when it runs (PREINIT/POSTINIT/SHUTDOWN), enabled state, and " +
        "timeout.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        scripts: z.array(
          z.object({
            id: z.number().nullable(),
            type: z.string().nullable(),
            command: z.string().nullable(),
            script: z.string().nullable(),
            when: z.string().nullable(),
            enabled: z.boolean().nullable(),
            timeout: z.number().nullable(),
            comment: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().initScripts()) as Array<Record<string, unknown>>;
        const scripts = raw.map((s) => ({
          id: (s.id as number) ?? null,
          type: (s.type as string) ?? null,
          command: (s.command as string) ?? null,
          script: (s.script as string) ?? null,
          when: (s.when as string) ?? null,
          enabled: (s.enabled as boolean) ?? null,
          timeout: (s.timeout as number) ?? null,
          comment: (s.comment as string) ?? null,
        }));
        return respond({ count: scripts.length, scripts }, response_format, () =>
          scripts.length === 0
            ? "No custom Init/Shutdown scripts configured."
            : mdTable(
                ["When", "Type", "Command / Script", "Enabled", "Comment"],
                scripts.map((s) => [
                  s.when,
                  s.type,
                  s.type === "COMMAND" ? s.command : s.script,
                  s.enabled === null ? null : s.enabled ? "yes" : "no",
                  s.comment,
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- cron jobs ----------------
  server.registerTool(
    "truenas_list_cron_jobs",
    {
      title: "List Cron Jobs",
      description: "List scheduled cron jobs (System → Advanced → Cron Jobs) with their command, user, schedule, and enabled state.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({ count: z.number(), jobs: z.array(z.record(z.string(), z.unknown())) }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const jobs = (await getClient().cronJobs()) as Array<Record<string, unknown>>;
        return respond({ count: jobs.length, jobs }, response_format, () =>
          jobs.length === 0
            ? "No cron jobs configured."
            : mdTable(
                ["Command", "User", "Schedule", "Enabled"],
                jobs.map((j) => [
                  j.command as string,
                  j.user as string,
                  cronStr(j.schedule as Parameters<typeof cronStr>[0]),
                  j.enabled === undefined ? null : j.enabled ? "yes" : "no",
                ])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- tunables ----------------
  server.registerTool(
    "truenas_list_tunables",
    {
      title: "List Tunables",
      description: "List system tunables (sysctl / udev / init) configured under System → Advanced → Sysctl.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({ count: z.number(), tunables: z.array(z.record(z.string(), z.unknown())) }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const tunables = (await getClient().tunables()) as Array<Record<string, unknown>>;
        return respond({ count: tunables.length, tunables }, response_format, () =>
          tunables.length === 0
            ? "No tunables configured."
            : mdTable(
                ["Type", "Variable", "Value", "Enabled"],
                tunables.map((t) => [t.type as string, t.var as string, t.value as string, t.enabled ? "yes" : "no"])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- NTP servers ----------------
  server.registerTool(
    "truenas_list_ntp_servers",
    {
      title: "List NTP Time Servers",
      description: "List the configured NTP time sources with their poll settings.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        servers: z.array(
          z.object({
            id: z.number().nullable(),
            address: z.string().nullable(),
            burst: z.boolean().nullable(),
            iburst: z.boolean().nullable(),
            prefer: z.boolean().nullable(),
            minpoll: z.number().nullable(),
            maxpoll: z.number().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().ntpServers()) as Array<Record<string, unknown>>;
        const servers = raw.map((s) => ({
          id: (s.id as number) ?? null,
          address: (s.address as string) ?? null,
          burst: (s.burst as boolean) ?? null,
          iburst: (s.iburst as boolean) ?? null,
          prefer: (s.prefer as boolean) ?? null,
          minpoll: (s.minpoll as number) ?? null,
          maxpoll: (s.maxpoll as number) ?? null,
        }));
        return respond({ count: servers.length, servers }, response_format, () =>
          mdTable(
            ["Address", "iburst", "prefer", "minpoll", "maxpoll"],
            servers.map((s) => [s.address, s.iburst ? "yes" : "no", s.prefer ? "yes" : "no", s.minpoll, s.maxpoll])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- boot status ----------------
  server.registerTool(
    "truenas_boot_status",
    {
      title: "Boot Pool & Environments",
      description:
        "Report boot-pool health (status, capacity, last scrub) and the list of boot environments — the OS " +
        "snapshots you can roll back to after a bad update. The active environment is flagged.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        boot_pool: z.object({
          status: z.string().nullable(),
          healthy: z.boolean().nullable(),
          size_bytes: z.number().nullable(),
          allocated_bytes: z.number().nullable(),
          free_bytes: z.number().nullable(),
          fragmentation: z.string().nullable(),
          last_scrub_errors: z.number().nullable(),
        }),
        environments: z.array(
          z.object({
            id: z.string().nullable(),
            active: z.boolean().nullable(),
            activated: z.boolean().nullable(),
            created: z.string().nullable(),
            used: z.string().nullable(),
            keep: z.boolean().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const bs = (await client.bootState()) as Record<string, unknown>;
        const scan = bs.scan as { errors?: number } | undefined;
        const boot_pool = {
          status: (bs.status as string) ?? null,
          healthy: (bs.healthy as boolean) ?? null,
          size_bytes: (bs.size as number) ?? null,
          allocated_bytes: (bs.allocated as number) ?? null,
          free_bytes: (bs.free as number) ?? null,
          fragmentation: (bs.fragmentation as string) ?? null,
          last_scrub_errors: scan?.errors ?? null,
        };
        const rawEnvs = (await client.bootEnvironments()) as Array<Record<string, unknown>>;
        const environments = rawEnvs.map((e) => ({
          id: (e.id as string) ?? null,
          active: (e.active as boolean) ?? null,
          activated: (e.activated as boolean) ?? null,
          created: (e.created as string) ?? null,
          used: (e.used as string) ?? null,
          keep: (e.keep as boolean) ?? null,
        }));
        return respond({ boot_pool, environments }, response_format, () =>
          [
            `**Boot pool**: ${boot_pool.status} · ${humanBytes(boot_pool.allocated_bytes)} / ${humanBytes(boot_pool.size_bytes)} used · frag ${boot_pool.fragmentation}%`,
            "",
            mdTable(
              ["Boot environment", "Active", "Keep", "Used", "Created"],
              environments.map((e) => [
                e.id,
                e.active ? "● active" : e.activated ? "next boot" : "",
                e.keep ? "yes" : "no",
                e.used,
                e.created,
              ])
            ),
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- network config ----------------
  server.registerTool(
    "truenas_get_network_config",
    {
      title: "Network Configuration",
      description:
        "Read global network configuration — hostname, domain, default gateways, DNS nameservers, host entries, and " +
        "service announcement (mDNS/NetBIOS/WSD) — plus any static routes. Complements truenas_list_network " +
        "(per-interface state).",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        config: z.record(z.string(), z.unknown()),
        static_routes: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const config = { ...(await client.networkConfig()) };
        delete config.state; // duplicate of the top-level fields
        const static_routes = (await client.staticRoutes()) as Array<Record<string, unknown>>;
        return respond({ config, static_routes }, response_format, () =>
          [
            `**Hostname**: ${config.hostname ?? "—"}${config.domain ? "." + config.domain : ""}`,
            `**Gateway**: ${config.ipv4gateway ?? "—"}`,
            `**Nameservers**: ${[config.nameserver1, config.nameserver2, config.nameserver3].filter(Boolean).join(", ") || "—"}`,
            `**Static routes**: ${static_routes.length}`,
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- service configs (ssh/snmp/ups) ----------------
  server.registerTool(
    "truenas_get_service_configs",
    {
      title: "Service Daemon Configs (SSH / SNMP / UPS)",
      description:
        "Read the configuration of the SSH, SNMP, and UPS services. Secrets (SSH host/private keys, SNMP community " +
        "and v3 passwords, UPS monitor password) are stripped.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        ssh: z.record(z.string(), z.unknown()),
        snmp: z.record(z.string(), z.unknown()),
        ups: z.record(z.string(), z.unknown()),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const ssh = { ...(await client.sshConfig()) };
        for (const k of [
          "privatekey",
          "host_key",
          "host_key_pub",
          "host_key_cert_pub",
          "host_dsa_key",
          "host_dsa_key_pub",
          "host_dsa_key_cert_pub",
          "host_ecdsa_key",
          "host_ecdsa_key_pub",
          "host_ecdsa_key_cert_pub",
          "host_ed25519_key",
          "host_ed25519_key_pub",
          "host_ed25519_key_cert_pub",
          "host_rsa_key",
          "host_rsa_key_pub",
          "host_rsa_key_cert_pub",
        ]) delete ssh[k];
        const snmp = { ...(await client.snmpConfig()) };
        for (const k of ["community", "v3_password", "v3_privpassphrase"]) delete snmp[k];
        const ups = { ...(await client.upsConfig()) };
        delete ups.monpwd;
        return respond({ ssh, snmp, ups }, response_format, () =>
          [
            `**SSH**: port ${ssh.tcpport ?? "—"}, password auth ${ssh.passwordauth ? "**ENABLED**" : "disabled"}, groups ${(ssh.password_login_groups as string[] | undefined)?.join(", ") || "—"}`,
            `**SNMP**: ${snmp.location || "(no location)"}, v3 ${snmp.v3 ? "on" : "off"}, traps ${snmp.traps ? "on" : "off"}`,
            `**UPS**: driver ${ups.driver || "(not configured)"}, mode ${ups.mode}, shutdown ${ups.shutdown}`,
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- notification config (mail + alerts) ----------------
  server.registerTool(
    "truenas_get_notification_config",
    {
      title: "Notification Config (Email & Alert Services)",
      description:
        "Read how alerts are delivered: the outgoing email config (SMTP or Gmail OAuth), the configured alert " +
        "services (email/Slack/PagerDuty/SNMP-trap/etc.), and any per-class alert level overrides. All secrets " +
        "(SMTP/OAuth credentials, SNMP keys) are stripped.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        mail: z.record(z.string(), z.unknown()),
        alert_services: z.array(z.record(z.string(), z.unknown())),
        alert_class_overrides: z.record(z.string(), z.unknown()),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const mail = { ...(await client.mailConfig()) };
        delete mail.pass;
        if (mail.oauth && typeof mail.oauth === "object") {
          const o = mail.oauth as Record<string, unknown>;
          mail.oauth = { provider: o.provider ?? null, configured: Boolean(o.client_id) };
        }
        const rawSvcs = (await client.alertServices()) as Array<Record<string, unknown>>;
        const alert_services = rawSvcs.map((s) => {
          const attrs = { ...((s.attributes as Record<string, unknown>) ?? {}) };
          for (const k of ["community", "v3_authkey", "v3_privkey", "password", "token", "api_key", "authtoken"]) delete attrs[k];
          return { id: s.id ?? null, name: s.name ?? null, type: s.type__title ?? null, level: s.level ?? null, enabled: s.enabled ?? null, attributes: attrs };
        });
        const classes = (await client.alertClasses()) as { classes?: Record<string, unknown> };
        return respond(
          { mail, alert_services, alert_class_overrides: classes.classes ?? {} },
          response_format,
          () =>
            [
              `**Email**: ${mail.smtp ? `SMTP ${mail.outgoingserver}:${mail.port}` : (mail.oauth as { provider?: string })?.provider ? `OAuth (${(mail.oauth as { provider?: string }).provider})` : "not configured"}, from ${mail.fromemail ?? "—"}`,
              "",
              alert_services.length === 0
                ? "No alert services configured."
                : mdTable(
                    ["Service", "Type", "Level", "Enabled"],
                    alert_services.map((s) => [s.name as string, s.type as string, s.level as string, s.enabled ? "yes" : "no"])
                  ),
            ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- certificates ----------------
  server.registerTool(
    "truenas_list_certificates",
    {
      title: "List TLS Certificates",
      description:
        "List the TLS certificates in the system store (used for the web UI and services) with common name, SANs, " +
        "and validity dates. Certificate bodies and private keys are never included.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        certificates: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            common_name: z.string().nullable(),
            san: z.array(z.string()),
            from: z.string().nullable(),
            until: z.string().nullable(),
            expired: z.boolean().nullable(),
            revoked: z.boolean().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().certificates()) as Array<Record<string, unknown>>;
        const certificates = raw.map((c) => ({
          id: (c.id as number) ?? null,
          name: (c.name as string) ?? null,
          common_name: (c.common as string) ?? null,
          san: Array.isArray(c.san) ? (c.san as string[]) : [],
          from: (c.from as string) ?? null,
          until: (c.until as string) ?? null,
          expired: (c.expired as boolean) ?? null,
          revoked: (c.revoked as boolean) ?? null,
        }));
        return respond({ count: certificates.length, certificates }, response_format, () =>
          mdTable(
            ["Name", "Common name", "Valid until", "Expired"],
            certificates.map((c) => [c.name, c.common_name, c.until, c.expired ? "yes" : "no"])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- API keys ----------------
  server.registerTool(
    "truenas_list_api_keys",
    {
      title: "List API Keys",
      description:
        "List programmatic API keys with their name, linked user, creation/expiry, and revoked state. The key " +
        "material/hash is never included. Useful for auditing which integrations can reach the box.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        keys: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            username: z.string().nullable(),
            created_at: z.string().nullable(),
            expires_at: z.string().nullable(),
            local: z.boolean().nullable(),
            revoked: z.boolean().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().apiKeys()) as Array<Record<string, unknown>>;
        const keys = raw.map((k) => ({
          id: (k.id as number) ?? null,
          name: (k.name as string) ?? null,
          username: (k.username as string) ?? null,
          created_at: (k.created_at as string) ?? null,
          expires_at: (k.expires_at as string) ?? null,
          local: (k.local as boolean) ?? null,
          revoked: (k.revoked as boolean) ?? null,
        }));
        return respond({ count: keys.length, keys }, response_format, () =>
          mdTable(
            ["Name", "User", "Expires", "Revoked"],
            keys.map((k) => [k.name, k.username, k.expires_at ?? "never", k.revoked ? "yes" : "no"])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- sessions ----------------
  server.registerTool(
    "truenas_list_sessions",
    {
      title: "Current Identity & Active Sessions",
      description:
        "Show the identity this server is authenticated as, plus all active API/UI sessions with their source IP, " +
        "credential type, and login time. Good for 'who/what is connected to my NAS right now?'.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        current_user: z.object({
          username: z.string().nullable(),
          uid: z.number().nullable(),
          source: z.string().nullable(),
          local: z.boolean().nullable(),
        }),
        sessions: z.array(
          z.object({
            id: z.string().nullable(),
            current: z.boolean().nullable(),
            origin: z.string().nullable(),
            credentials: z.string().nullable(),
            username: z.string().nullable(),
            api_key: z.string().nullable(),
            created_at: z.string().nullable(),
            secure_transport: z.boolean().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const me = (await client.authMe()) as Record<string, unknown>;
        const current_user = {
          username: (me.pw_name as string) ?? null,
          uid: (me.pw_uid as number) ?? null,
          source: (me.source as string) ?? null,
          local: (me.local as boolean) ?? null,
        };
        const raw = (await client.authSessions()) as Array<Record<string, unknown>>;
        const sessions = raw.map((s) => {
          const cd = (s.credentials_data as Record<string, unknown>) ?? {};
          const apiKey = cd.api_key as { name?: string } | undefined;
          return {
            id: (s.id as string) ?? null,
            current: (s.current as boolean) ?? null,
            origin: (s.origin as string) ?? null,
            credentials: (s.credentials as string) ?? null,
            username: (cd.username as string) ?? null,
            api_key: apiKey?.name ?? null,
            created_at: (s.created_at as string) ?? null,
            secure_transport: (s.secure_transport as boolean) ?? null,
          };
        });
        return respond({ current_user, sessions }, response_format, () =>
          [
            `**Authenticated as**: ${current_user.username} (${current_user.source})`,
            "",
            mdTable(
              ["Origin", "Credential", "User / Key", "Since", "TLS"],
              sessions.map((s) => [
                `${s.origin}${s.current ? " (this)" : ""}`,
                s.credentials,
                s.api_key ?? s.username,
                s.created_at,
                s.secure_transport ? "yes" : "no",
              ])
            ),
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- privileges (RBAC) ----------------
  server.registerTool(
    "truenas_list_privileges",
    {
      title: "List Privileges (RBAC)",
      description:
        "List privilege grants that map local/directory groups to roles (e.g. FULL_ADMIN, READONLY_ADMIN), plus a " +
        "count of assignable roles. Shows who has administrative access and at what level.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        roles_available: z.number(),
        count: z.number(),
        privileges: z.array(
          z.object({
            id: z.number().nullable(),
            name: z.string().nullable(),
            builtin_name: z.string().nullable(),
            roles: z.array(z.string()),
            local_groups: z.array(z.string()),
            ds_groups: z.array(z.string()),
            web_shell: z.boolean().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const raw = (await client.privileges()) as Array<Record<string, unknown>>;
        const roles = (await client.privilegeRoles()) as unknown[];
        const privileges = raw.map((p) => ({
          id: (p.id as number) ?? null,
          name: (p.name as string) ?? null,
          builtin_name: (p.builtin_name as string) ?? null,
          roles: Array.isArray(p.roles) ? (p.roles as string[]) : [],
          local_groups: Array.isArray(p.local_groups)
            ? (p.local_groups as Array<{ name?: string }>).map((g) => g.name ?? "?")
            : [],
          ds_groups: Array.isArray(p.ds_groups)
            ? (p.ds_groups as Array<{ name?: string }>).map((g) => g.name ?? "?")
            : [],
          web_shell: (p.web_shell as boolean) ?? null,
        }));
        return respond({ roles_available: roles.length, count: privileges.length, privileges }, response_format, () =>
          mdTable(
            ["Privilege", "Roles", "Groups", "Shell"],
            privileges.map((p) => [
              p.name,
              p.roles.join(", "),
              [...p.local_groups, ...p.ds_groups].join(", "),
              p.web_shell ? "yes" : "no",
            ])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- directory services ----------------
  server.registerTool(
    "truenas_get_directory_services",
    {
      title: "Directory Services Status",
      description:
        "Report Active Directory / LDAP / IPA configuration and join status (whether the NAS is bound to a domain). " +
        "Bind credentials are stripped.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({ config: z.record(z.string(), z.unknown()), status: z.record(z.string(), z.unknown()) }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const config = { ...(await client.directoryServicesConfig()) };
        delete config.credential; // may hold a bind password / keytab
        const status = await client.directoryServicesStatus();
        return respond({ config, status }, response_format, () =>
          config.enable
            ? `**Directory services**: ${config.service_type ?? "?"} — status ${status.status ?? "?"}`
            : "Directory services are **disabled** (not joined to AD/LDAP/IPA)."
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- hardware / IPMI ----------------
  server.registerTool(
    "truenas_get_hardware",
    {
      title: "Hardware / BMC Status",
      description:
        "Report IPMI/BMC (lights-out) presence and chassis status (power state, intrusion, fan/drive fault, restore " +
        "policy), plus any enclosure/backplane mapping if present.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        ipmi_loaded: z.boolean(),
        chassis: z.record(z.string(), z.unknown()).nullable(),
        enclosures: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const ipmi_loaded = await client.ipmiLoaded();
        let chassis: Record<string, unknown> | null = null;
        if (ipmi_loaded) {
          try {
            chassis = await client.ipmiChassis();
          } catch {
            // BMC present but chassis read failed; leave null
          }
        }
        const enclosures = (await client.enclosures()) as Array<Record<string, unknown>>;
        return respond({ ipmi_loaded, chassis, enclosures }, response_format, () =>
          [
            `**IPMI/BMC**: ${ipmi_loaded ? "present" : "not present"}`,
            chassis ? `**Power**: ${chassis.system_power} · **Intrusion**: ${chassis.chassis_intrusion} · **Restore policy**: ${chassis.power_restore_policy}` : "",
            `**Enclosures**: ${enclosures.length}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- dependency checks (pre-destructive) ----------------
  server.registerTool(
    "truenas_check_dependencies",
    {
      title: "Check Dataset Dependencies",
      description:
        "Before deleting or locking a dataset, list what depends on it: attached tasks/shares (snapshot tasks, SMB/" +
        "NFS shares, replication) and running processes (VMs, apps) holding it open. Use this to avoid breaking a " +
        "live service.",
      inputSchema: z.object({
        dataset: z.string().describe("Dataset id / full path, e.g. 'SSD/PostgreSQL'"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        dataset: z.string(),
        attachments: z.array(z.object({ type: z.string().nullable(), service: z.string().nullable(), items: z.array(z.string()) })),
        processes: z.array(z.object({ pid: z.number().nullable(), name: z.string().nullable(), service: z.string().nullable() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ dataset, response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const rawA = (await client.datasetAttachments(dataset)) as Array<Record<string, unknown>>;
        const attachments = rawA.map((a) => ({
          type: (a.type as string) ?? null,
          service: (a.service as string) ?? null,
          items: Array.isArray(a.attachments) ? (a.attachments as string[]) : [],
        }));
        const rawP = (await client.datasetProcesses(dataset)) as Array<Record<string, unknown>>;
        const processes = rawP.map((p) => ({
          pid: (p.pid as number) ?? null,
          name: (p.name as string) ?? null,
          service: (p.service as string) ?? null,
        }));
        return respond({ dataset, attachments, processes }, response_format, () =>
          [
            `Dependencies of **${dataset}**:`,
            attachments.length
              ? "\n**Attached tasks/shares:**\n" + attachments.map((a) => `- ${a.type}${a.service ? ` (${a.service})` : ""}: ${a.items.join(", ")}`).join("\n")
              : "\n_No attached tasks or shares._",
            processes.length
              ? "\n**Running processes holding it open:**\n" + processes.map((p) => `- ${p.name} (pid ${p.pid})`).join("\n")
              : "\n_No processes holding it open._",
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- filesystem browse ----------------
  server.registerTool(
    "truenas_browse_path",
    {
      title: "Browse Filesystem Path",
      description:
        "List a directory under the NAS filesystem (e.g. /mnt/POOL/dataset) and show the path's metadata, and " +
        "optionally its ACL. Read-only directory browsing for inspecting datasets and permissions.",
      inputSchema: z.object({
        path: z.string().default("/mnt").describe("Absolute path to inspect, e.g. '/mnt/SSD'"),
        include_acl: z.boolean().default(false).describe("Also fetch the path's ACL"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        path: z.string(),
        stat: z.record(z.string(), z.unknown()),
        acl: z.record(z.string(), z.unknown()).nullable(),
        entries: z.array(z.object({ name: z.string().nullable(), type: z.string().nullable(), path: z.string().nullable() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ path, include_acl, response_format }): Promise<ToolResult> => {
      try {
        const client = getClient();
        const stat = await client.fsStat(path);
        const rawEntries = (await client.fsListdir(path)) as Array<Record<string, unknown>>;
        const entries = rawEntries.map((e) => ({
          name: (e.name as string) ?? null,
          type: (e.type as string) ?? null,
          path: (e.path as string) ?? null,
        }));
        let acl: Record<string, unknown> | null = null;
        if (include_acl) {
          try {
            acl = await client.fsGetacl(path);
          } catch {
            acl = null;
          }
        }
        return respond({ path, stat, acl, entries }, response_format, () =>
          [
            `**${path}** (${stat.type}, ${entries.length} entries)`,
            "",
            mdTable(
              ["Name", "Type"],
              entries.map((e) => [e.name, e.type])
            ),
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- disk temperature alerts ----------------
  server.registerTool(
    "truenas_disk_temperature_alerts",
    {
      title: "Disk Temperature Alerts",
      description:
        "Report current per-disk temperature alerts (disks running hotter than their configured threshold). On " +
        "25.10 this is the primary disk-health telemetry (SMART self-tests were removed).",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({ count: z.number(), alerts: z.array(z.record(z.string(), z.unknown())) }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const alerts = (await getClient().diskTempAlerts()) as Array<Record<string, unknown>>;
        return respond({ count: alerts.length, alerts }, response_format, () =>
          alerts.length === 0 ? "No disk temperature alerts — all disks within threshold." : JSON.stringify(alerts, null, 2)
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- rsync tasks ----------------
  server.registerTool(
    "truenas_list_rsync_tasks",
    {
      title: "List Rsync Tasks",
      description:
        "List configured rsync tasks (file-level backups to/from another host or rsyncd module) with local path, " +
        "direction, remote target, schedule, and last-run state. Use the ids here with the run/update/delete rsync tools.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        count: z.number(),
        tasks: z.array(
          z.object({
            id: z.number().nullable(),
            description: z.string().nullable(),
            path: z.string().nullable(),
            direction: z.string().nullable(),
            mode: z.string().nullable(),
            remote: z.string().nullable(),
            enabled: z.boolean().nullable(),
            schedule: z.string().nullable(),
            last_run_state: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().rsyncTasks()) as Array<{
          id?: number;
          desc?: string;
          path?: string;
          direction?: string;
          mode?: string;
          remotehost?: string;
          remotemodule?: string;
          remotepath?: string;
          enabled?: boolean;
          schedule?: { minute?: string; hour?: string; dom?: string; month?: string; dow?: string };
          job?: { state?: string } | null;
        }>;
        const tasks = raw.map((t) => ({
          id: t.id ?? null,
          description: t.desc ?? null,
          path: t.path ?? null,
          direction: t.direction ?? null,
          mode: t.mode ?? null,
          remote: t.mode === "MODULE" ? `${t.remotehost ?? "?"}::${t.remotemodule ?? "?"}` : `${t.remotehost ?? "?"}:${t.remotepath ?? "?"}`,
          enabled: t.enabled ?? null,
          schedule: cronStr(t.schedule),
          last_run_state: t.job?.state ?? null,
        }));
        return respond({ count: tasks.length, tasks }, response_format, () =>
          tasks.length === 0
            ? "No rsync tasks configured."
            : mdTable(
                ["Path", "Dir", "Remote", "Enabled", "Last state"],
                tasks.map((t) => [t.path, t.direction, t.remote, t.enabled ? "yes" : "no", t.last_run_state])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- catalog apps (installable) ----------------
  server.registerTool(
    "truenas_list_catalog_apps",
    {
      title: "Browse App Catalog",
      description:
        "Browse the catalog of installable apps (the same list the UI's Discover Apps shows). Optionally filter by " +
        "a search term. Use a name here as 'catalog_app' when calling truenas_create_app.",
      inputSchema: z.object({
        search: z.string().optional().describe("Case-insensitive filter on name/title/description"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max apps to return (default 50)"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        count: z.number(),
        returned: z.number(),
        apps: z.array(
          z.object({
            name: z.string().nullable(),
            title: z.string().nullable(),
            train: z.string().nullable(),
            version: z.string().nullable(),
            categories: z.array(z.string()),
            recommended: z.boolean().nullable(),
            healthy: z.boolean().nullable(),
            description: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ search, limit, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().catalogApps()) as Array<Record<string, unknown>>;
        const q = search?.toLowerCase();
        const filtered = q
          ? raw.filter((a) =>
              [a.name, a.title, a.description].some((f) => typeof f === "string" && f.toLowerCase().includes(q))
            )
          : raw;
        const apps = filtered.slice(0, limit).map((a) => ({
          name: (a.name as string) ?? null,
          title: (a.title as string) ?? null,
          train: (a.train as string) ?? null,
          version: (a.latest_human_version as string) ?? null,
          categories: Array.isArray(a.categories) ? (a.categories as string[]) : [],
          recommended: (a.recommended as boolean) ?? null,
          healthy: (a.healthy as boolean) ?? null,
          description: (a.description as string) ?? null,
        }));
        return respond({ count: filtered.length, returned: apps.length, apps }, response_format, () =>
          mdTable(
            ["Name", "Title", "Train", "Version", "Categories"],
            apps.map((a) => [a.name, a.title, a.train, a.version, a.categories.join(", ")])
          ) + `\n\n_${apps.length} of ${filtered.length} matching apps._`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- installed app detail ----------------
  server.registerTool(
    "truenas_get_app",
    {
      title: "Get Installed App Detail",
      description:
        "Show operational detail for one installed app: state, version, whether an update is available, web portals, " +
        "used host ports, and container/volume counts. The raw config (which can contain secrets) is deliberately " +
        "NOT included — view it in the TrueNAS UI.",
      inputSchema: z.object({
        app: z.string().describe("Installed app name (see truenas_list_apps)"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        name: z.string().nullable(),
        state: z.string().nullable(),
        version: z.string().nullable(),
        upgrade_available: z.boolean().nullable(),
        image_updates_available: z.boolean().nullable(),
        custom_app: z.boolean().nullable(),
        portals: z.record(z.string(), z.string()),
        used_ports: z.array(z.string()),
        container_count: z.number().nullable(),
        volume_count: z.number().nullable(),
        notes: z.string().nullable(),
      }),
      annotations: READ_ONLY,
    },
    async ({ app, response_format }): Promise<ToolResult> => {
      try {
        const a = (await getClient().appInstance(app)) as Record<string, unknown>;
        const workloads = (a.active_workloads as Record<string, unknown>) ?? {};
        const portalsRaw = (a.portals as Record<string, string>) ?? {};
        const usedPortsRaw = Array.isArray(workloads.used_ports) ? (workloads.used_ports as unknown[]) : [];
        const used_ports = usedPortsRaw.map((p) => {
          const o = p as { host_ports?: Array<{ host_port?: number; host_ip?: string }>; container_port?: number; protocol?: string };
          const hosts = (o.host_ports ?? []).map((h) => h.host_port).filter(Boolean).join(",");
          return `${hosts || "?"}→${o.container_port ?? "?"}/${(o.protocol ?? "tcp").toLowerCase()}`;
        });
        const structured = {
          name: (a.name as string) ?? null,
          state: (a.state as string) ?? null,
          version: (a.human_version as string) ?? (a.version as string) ?? null,
          upgrade_available: (a.upgrade_available as boolean) ?? null,
          image_updates_available: (a.image_updates_available as boolean) ?? null,
          custom_app: (a.custom_app as boolean) ?? null,
          portals: portalsRaw,
          used_ports,
          container_count: typeof workloads.containers === "number" ? (workloads.containers as number) : null,
          volume_count: Array.isArray(workloads.volumes) ? (workloads.volumes as unknown[]).length : null,
          notes: (a.notes as string) ?? null,
        };
        return respond(structured, response_format, () =>
          [
            `**${structured.name}** — ${structured.state} · ${structured.version}`,
            `Update available: app ${structured.upgrade_available ? "yes" : "no"}, image ${structured.image_updates_available ? "yes" : "no"}`,
            Object.keys(structured.portals).length
              ? "Portals: " + Object.entries(structured.portals).map(([k, v]) => `${k} → ${v}`).join(", ")
              : "",
            structured.used_ports.length ? "Ports: " + structured.used_ports.join(", ") : "",
            `Containers: ${structured.container_count ?? "?"}, Volumes: ${structured.volume_count ?? "?"}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- VM devices ----------------
  server.registerTool(
    "truenas_list_vm_devices",
    {
      title: "List VM Devices",
      description:
        "List the devices attached to a virtual machine (disks, NICs, display, CD-ROM, PCI passthrough) with a short " +
        "summary of each. Use with truenas_list_vms to inspect a VM's hardware.",
      inputSchema: z.object({
        vm_id: z.number().int().describe("VM id (see truenas_list_vms)"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        vm_id: z.number(),
        count: z.number(),
        devices: z.array(
          z.object({
            id: z.number().nullable(),
            type: z.string().nullable(),
            order: z.number().nullable(),
            summary: z.string().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ vm_id, response_format }): Promise<ToolResult> => {
      try {
        const raw = (await getClient().vmDevices(vm_id)) as Array<Record<string, unknown>>;
        const devices = raw.map((d) => {
          const at = (d.attributes as Record<string, unknown>) ?? {};
          const type = (at.dtype as string) ?? null;
          let summary: string | null = null;
          switch (type) {
            case "DISK": summary = `${at.path ?? "?"} (${at.type ?? "?"})`; break;
            case "CDROM": summary = String(at.path ?? "?"); break;
            case "NIC": summary = `${at.type ?? "?"} on ${at.nic_attach ?? "?"}${at.mac ? ` (${at.mac})` : ""}`; break;
            case "DISPLAY": summary = `${at.type ?? "?"} :${at.port ?? "?"}`; break;
            case "PCI": summary = String(at.pptdev ?? "?"); break;
            case "RAW": summary = String(at.path ?? "?"); break;
            default: summary = type ? String(type) : null;
          }
          return { id: (d.id as number) ?? null, type, order: (d.order as number) ?? null, summary };
        });
        return respond({ vm_id, count: devices.length, devices }, response_format, () =>
          mdTable(
            ["Type", "Summary", "Order"],
            devices.map((d) => [d.type, d.summary, d.order])
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- pool detail (topology) ----------------
  server.registerTool(
    "truenas_get_pool",
    {
      title: "Get Pool Detail (Topology)",
      description:
        "Show one pool's full topology — data/cache/log/spare/special vdevs, the disks in each, their state and " +
        "per-disk error counts — plus capacity and the last scrub/resilver status. Use this to see RAIDZ/mirror " +
        "layout and spot a degraded disk.",
      inputSchema: z.object({
        pool: z.string().describe("Pool name, e.g. 'SSD'"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        name: z.string().nullable(),
        status: z.string().nullable(),
        healthy: z.boolean().nullable(),
        warning: z.boolean().nullable(),
        size: z.string().nullable(),
        allocated: z.string().nullable(),
        free: z.string().nullable(),
        fragmentation: z.string().nullable(),
        scan: z.record(z.string(), z.unknown()).nullable(),
        topology: z.record(
          z.string(),
          z.array(
            z.object({
              type: z.string().nullable(),
              status: z.string().nullable(),
              disks: z.array(z.object({ name: z.string().nullable(), status: z.string().nullable(), errors: z.number() })),
            })
          )
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ pool, response_format }): Promise<ToolResult> => {
      try {
        const p = (await getClient().poolDetail(pool)) as Record<string, unknown> | null;
        if (!p) throw new TrueNasError(`Pool '${pool}' not found.`);
        const base = (s: string | undefined): string | null => (s ? s.split("/").pop() ?? s : null);
        const diskInfo = (d: Record<string, unknown>) => {
          const st = (d.stats as { read_errors?: number; write_errors?: number; checksum_errors?: number }) ?? {};
          return {
            name: base((d.path as string) ?? (d.name as string)),
            status: (d.status as string) ?? null,
            errors: (st.read_errors ?? 0) + (st.write_errors ?? 0) + (st.checksum_errors ?? 0),
          };
        };
        const summarize = (list: unknown): Array<{ type: string | null; status: string | null; disks: ReturnType<typeof diskInfo>[] }> =>
          (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []).map((v) => ({
            type: (v.type as string) ?? null,
            status: (v.status as string) ?? null,
            disks: Array.isArray(v.children) && (v.children as unknown[]).length
              ? (v.children as Array<Record<string, unknown>>).map(diskInfo)
              : [diskInfo(v)],
          }));
        const topoRaw = (p.topology as Record<string, unknown>) ?? {};
        const topology: Record<string, ReturnType<typeof summarize>> = {};
        for (const cat of ["data", "cache", "log", "spare", "special", "dedup"]) {
          const s = summarize(topoRaw[cat]);
          if (s.length) topology[cat] = s;
        }
        const scan = (p.scan as Record<string, unknown>) ?? null;
        const structured = {
          name: (p.name as string) ?? null,
          status: (p.status as string) ?? null,
          healthy: (p.healthy as boolean) ?? null,
          warning: (p.warning as boolean) ?? null,
          size: (p.size_str as string) ?? null,
          allocated: (p.allocated_str as string) ?? null,
          free: (p.free_str as string) ?? null,
          fragmentation: p.fragmentation != null ? `${p.fragmentation}%` : null,
          scan,
          topology,
        };
        return respond(structured, response_format, () => {
          const lines = [
            `**${structured.name}** — ${structured.status} (${structured.healthy ? "healthy" : "check"}) · ${structured.allocated}/${structured.size} used, frag ${structured.fragmentation}`,
          ];
          for (const [cat, vdevs] of Object.entries(topology)) {
            lines.push(`\n**${cat}:**`);
            for (const v of vdevs) {
              lines.push(`- ${v.type} (${v.status}): ` + v.disks.map((d) => `${d.name}${d.errors ? ` ⚠${d.errors}` : ""} [${d.status}]`).join(", "));
            }
          }
          if (scan) lines.push(`\n_Last ${scan.function}: ${scan.state}${scan.errors != null ? `, ${scan.errors} errors` : ""}._`);
          return lines.join("\n");
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- dataset detail ----------------
  server.registerTool(
    "truenas_get_dataset",
    {
      title: "Get Dataset Detail",
      description:
        "Show one dataset's full properties: encryption status (encrypted/locked/key-loaded, algorithm), quotas and " +
        "reservations, record size, compression + achieved ratio, dedup, sync, atime, and a space-usage breakdown.",
      inputSchema: z.object({
        dataset: z.string().describe("Dataset id / full path, e.g. 'SSD/PostgreSQL'"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        id: z.string().nullable(),
        type: z.string().nullable(),
        encrypted: z.boolean().nullable(),
        locked: z.boolean().nullable(),
        key_loaded: z.boolean().nullable(),
        encryption_root: z.string().nullable(),
        encryption_algorithm: z.string().nullable(),
        used: z.string().nullable(),
        available: z.string().nullable(),
        quota: z.string().nullable(),
        refquota: z.string().nullable(),
        recordsize: z.string().nullable(),
        compression: z.string().nullable(),
        compressratio: z.string().nullable(),
        deduplication: z.string().nullable(),
        sync: z.string().nullable(),
        atime: z.string().nullable(),
        readonly: z.string().nullable(),
        mountpoint: z.string().nullable(),
      }),
      annotations: READ_ONLY,
    },
    async ({ dataset, response_format }): Promise<ToolResult> => {
      try {
        const d = (await getClient().datasetDetail(dataset)) as Record<string, RawZfsProp | unknown> | null;
        if (!d) throw new TrueNasError(`Dataset '${dataset}' not found.`);
        const prop = (k: string): string | null => propStr(d[k] as RawZfsProp);
        const structured = {
          id: (d.id as string) ?? null,
          type: (d.type as string) ?? null,
          encrypted: (d.encrypted as boolean) ?? null,
          locked: (d.locked as boolean) ?? null,
          key_loaded: (d.key_loaded as boolean) ?? null,
          encryption_root: (d.encryption_root as string) ?? null,
          encryption_algorithm: prop("encryption_algorithm"),
          used: prop("used"),
          available: prop("available"),
          quota: prop("quota"),
          refquota: prop("refquota"),
          recordsize: prop("recordsize"),
          compression: prop("compression"),
          compressratio: prop("compressratio"),
          deduplication: prop("deduplication"),
          sync: prop("sync"),
          atime: prop("atime"),
          readonly: prop("readonly"),
          mountpoint: prop("mountpoint"),
        };
        return respond(structured, response_format, () =>
          [
            `**${structured.id}** (${structured.type})`,
            `Encryption: ${structured.encrypted ? `yes — ${structured.encryption_algorithm ?? "?"}, ${structured.locked ? "LOCKED" : "unlocked"} (key ${structured.key_loaded ? "loaded" : "not loaded"}), root ${structured.encryption_root}` : "no"}`,
            `Space: ${structured.used} used, ${structured.available} available` + (structured.quota && structured.quota !== "0" ? `, quota ${structured.quota}` : ""),
            `recordsize ${structured.recordsize} · compression ${structured.compression} (${structured.compressratio}) · dedup ${structured.deduplication} · sync ${structured.sync}`,
            `mountpoint ${structured.mountpoint}`,
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- encryption summary ----------------
  server.registerTool(
    "truenas_encryption_summary",
    {
      title: "Dataset Encryption Summary",
      description:
        "Report the encryption/lock status of a dataset and its encrypted children: key format, whether a valid key " +
        "is stored, and whether each is currently locked. No key material is returned. Read-only (runs as a job).",
      inputSchema: z.object({
        dataset: z.string().describe("Dataset id / full path, e.g. 'SSD'"),
        response_format: responseFormat,
      }),
      outputSchema: z.object({
        dataset: z.string(),
        entries: z.array(
          z.object({
            name: z.string().nullable(),
            key_format: z.string().nullable(),
            key_present_in_database: z.boolean().nullable(),
            valid_key: z.boolean().nullable(),
            locked: z.boolean().nullable(),
          })
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ dataset, response_format }): Promise<ToolResult> => {
      try {
        const out = await getClient().encryptionSummary(dataset);
        if (out.error) throw new TrueNasError(out.error);
        const rows = Array.isArray(out.result) ? (out.result as Array<Record<string, unknown>>) : [];
        const entries = rows.map((r) => ({
          name: (r.name as string) ?? null,
          key_format: (r.key_format as string) ?? null,
          key_present_in_database: (r.key_present_in_database as boolean) ?? null,
          valid_key: (r.valid_key as boolean) ?? null,
          locked: (r.locked as boolean) ?? null,
        }));
        return respond({ dataset, entries }, response_format, () =>
          entries.length === 0
            ? `No encrypted datasets under ${dataset}.`
            : mdTable(
                ["Dataset", "Key format", "Key stored", "Valid key", "Locked"],
                entries.map((e) => [e.name, e.key_format, e.key_present_in_database ? "yes" : "no", e.valid_key ? "yes" : "no", e.locked ? "yes" : "no"])
              )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- iSCSI overview ----------------
  server.registerTool(
    "truenas_iscsi_overview",
    {
      title: "iSCSI Configuration Overview",
      description:
        "Report the entire iSCSI configuration in one call: global settings, targets, extents (backing storage), " +
        "target↔extent mappings (LUNs), portals, allowed initiators, and CHAP auth groups. CHAP secrets are stripped.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        global: z.record(z.string(), z.unknown()),
        targets: z.array(z.record(z.string(), z.unknown())),
        extents: z.array(z.record(z.string(), z.unknown())),
        targetextents: z.array(z.record(z.string(), z.unknown())),
        portals: z.array(z.record(z.string(), z.unknown())),
        initiators: z.array(z.record(z.string(), z.unknown())),
        auth: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const o = await getClient().iscsiOverview();
        const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
        const g = (o.global as Record<string, unknown>) ?? {};
        const structured = {
          global: { basename: g.basename ?? null, listen_port: g.listen_port ?? null, alua: g.alua ?? null, iser: g.iser ?? null },
          targets: arr(o.targets).map((t) => ({ id: t.id, name: t.name, alias: t.alias, mode: t.mode, groups: t.groups })),
          extents: arr(o.extents).map((e) => ({ id: e.id, name: e.name, type: e.type, disk: e.disk, path: e.path, blocksize: e.blocksize, enabled: e.enabled })),
          targetextents: arr(o.targetextents).map((x) => ({ id: x.id, target: x.target, extent: x.extent, lunid: x.lunid })),
          portals: arr(o.portals).map((p) => ({ id: p.id, listen: p.listen, comment: p.comment })),
          initiators: arr(o.initiators).map((i) => ({ id: i.id, initiators: i.initiators, comment: i.comment })),
          // CHAP secret + peersecret intentionally stripped.
          auth: arr(o.auth).map((a) => ({ id: a.id, tag: a.tag, user: a.user, peeruser: a.peeruser })),
        };
        return respond(structured, response_format, () =>
          [
            `**iSCSI** (base ${structured.global.basename}, port ${structured.global.listen_port})`,
            `Targets: ${structured.targets.length} · Extents: ${structured.extents.length} · LUN maps: ${structured.targetextents.length} · Portals: ${structured.portals.length} · Initiator groups: ${structured.initiators.length} · CHAP auth: ${structured.auth.length}`,
            structured.targets.length ? "\n" + mdTable(["Target id", "Name", "Alias"], structured.targets.map((t) => [t.id as number, t.name as string, t.alias as string])) : "\n_No targets configured._",
          ].join("\n")
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------- NVMe-oF overview ----------------
  server.registerTool(
    "truenas_nvme_overview",
    {
      title: "NVMe-oF Configuration Overview",
      description:
        "Report the entire NVMe-over-Fabrics configuration in one call: global settings, subsystems, namespaces " +
        "(backing storage), ports (transport/address), allowed hosts, and the port↔subsystem and host↔subsystem links.",
      inputSchema: z.object({ response_format: responseFormat }),
      outputSchema: z.object({
        global: z.record(z.string(), z.unknown()),
        subsystems: z.array(z.record(z.string(), z.unknown())),
        namespaces: z.array(z.record(z.string(), z.unknown())),
        ports: z.array(z.record(z.string(), z.unknown())),
        hosts: z.array(z.record(z.string(), z.unknown())),
        port_subsys: z.array(z.record(z.string(), z.unknown())),
        host_subsys: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      try {
        const o = await getClient().nvmeOverview();
        const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
        const g = (o.global as Record<string, unknown>) ?? {};
        const structured = {
          global: { basenqn: g.basenqn ?? null, kernel: g.kernel ?? null, ana: g.ana ?? null, rdma: g.rdma ?? null },
          subsystems: arr(o.subsystems).map((s) => ({ id: s.id, name: s.name, subnqn: s.subnqn, allow_any_host: s.allow_any_host })),
          namespaces: arr(o.namespaces).map((n) => ({ id: n.id, subsys_id: n.subsys_id, device_type: n.device_type, device_path: n.device_path, enabled: n.enabled })),
          ports: arr(o.ports).map((p) => ({ id: p.id, addr_trtype: p.addr_trtype, addr_traddr: p.addr_traddr, addr_trsvcid: p.addr_trsvcid })),
          hosts: arr(o.hosts).map((h) => ({ id: h.id, hostnqn: h.hostnqn })),
          port_subsys: arr(o.port_subsys).map((x) => ({ id: x.id, port_id: x.port_id, subsys_id: x.subsys_id })),
          host_subsys: arr(o.host_subsys).map((x) => ({ id: x.id, host_id: x.host_id, subsys_id: x.subsys_id })),
        };
        return respond(structured, response_format, () =>
          [
            `**NVMe-oF** (base ${structured.global.basenqn})`,
            `Subsystems: ${structured.subsystems.length} · Namespaces: ${structured.namespaces.length} · Ports: ${structured.ports.length} · Hosts: ${structured.hosts.length} · Port links: ${structured.port_subsys.length}`,
            structured.subsystems.length ? "\n" + mdTable(["Subsys id", "Name", "NQN"], structured.subsystems.map((s) => [s.id as number, s.name as string, s.subnqn as string])) : "\n_No subsystems configured._",
          ].join("\n")
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

    // ---------------- create dataset ----------------
    server.registerTool(
      "truenas_create_dataset",
      {
        title: "Create Dataset",
        description:
          "Create a new ZFS dataset (a filesystem) or zvol (a block volume). Reversible — the dataset can be " +
          "deleted later. For a zvol, set type=VOLUME and volsize_bytes. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          name: z.string().describe("Full dataset path to create, e.g. 'tank/appdata'"),
          type: z.enum(["FILESYSTEM", "VOLUME"]).default("FILESYSTEM").describe("FILESYSTEM (dataset) or VOLUME (zvol)"),
          volsize_bytes: z.number().int().min(1).optional().describe("Required for VOLUME: the zvol size in bytes"),
          comments: z.string().optional().describe("Free-text comment"),
          compression: z.enum(["INHERIT", "OFF", "LZ4", "ZSTD", "GZIP", "ON"]).optional().describe("Compression"),
          create_ancestors: z.boolean().default(false).describe("Create parent datasets if they don't exist"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), dataset: z.string(), type: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ name, type, volsize_bytes, comments, compression, create_ancestors, response_format }): Promise<ToolResult> => {
        try {
          assertAllowedTarget(config, name);
          if (type === "VOLUME" && volsize_bytes === undefined) {
            throw new TrueNasError("A VOLUME (zvol) requires volsize_bytes.");
          }
          await getClient().createDataset({ name, type, volsize: volsize_bytes, comments, compression, create_ancestors });
          auditLog({ tool: "truenas_create_dataset", method: "pool.dataset.create", target: name, outcome: "success" });
          return respond({ created: true, dataset: name, type }, response_format, () => `Created ${type === "VOLUME" ? "zvol" : "dataset"} **${name}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_create_dataset", method: "pool.dataset.create", target: name, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- rename dataset ----------------
    server.registerTool(
      "truenas_rename_dataset",
      {
        title: "Rename Dataset",
        description:
          "Rename a ZFS dataset. ⚠ ZFS performs NO safety checks: renaming a dataset that backs an active SMB/" +
          "NFS/iSCSI share, snapshot task, or replication can disrupt it. Reversible (rename back). Requires " +
          "TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Current dataset path, e.g. 'tank/old'"),
          new_name: z.string().describe("New full dataset path, e.g. 'tank/new'"),
          recursive: z.boolean().default(false).describe("Recursively rename child datasets"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ renamed: z.boolean(), dataset: z.string(), new_name: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ dataset, new_name, recursive, response_format }): Promise<ToolResult> => {
        try {
          assertAllowedTarget(config, dataset);
          assertAllowedTarget(config, new_name);
          await getClient().renameDataset(dataset, new_name, recursive);
          auditLog({ tool: "truenas_rename_dataset", method: "pool.dataset.rename", target: `${dataset} -> ${new_name}`, outcome: "success" });
          return respond({ renamed: true, dataset, new_name }, response_format, () => `Renamed **${dataset}** → **${new_name}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_rename_dataset", method: "pool.dataset.rename", target: `${dataset} -> ${new_name}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create SMB share ----------------
    server.registerTool(
      "truenas_create_smb_share",
      {
        title: "Create SMB Share",
        description:
          "Create an SMB (Windows/macOS file) share for a path under /mnt. Reversible — the share can be deleted. " +
          "This shares an existing dataset; it does not create the dataset. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          path: z.string().describe("Path to share, e.g. '/mnt/tank/media'"),
          name: z.string().max(80).describe("Share name (what clients see), e.g. 'media'"),
          comment: z.string().optional().describe("Description"),
          enabled: z.boolean().default(true).describe("Enable the share now"),
          readonly: z.boolean().default(false).describe("Export read-only"),
          browsable: z.boolean().default(true).describe("Show in network browse lists"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), name: z.string(), path: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ path, name, comment, enabled, readonly, browsable, response_format }): Promise<ToolResult> => {
        try {
          await getClient().createSmbShare({ path, name, comment, enabled, readonly, browsable });
          auditLog({ tool: "truenas_create_smb_share", method: "sharing.smb.create", target: `${name} (${path})`, outcome: "success" });
          return respond({ created: true, name, path }, response_format, () => `Created SMB share **${name}** → ${path}.`);
        } catch (error) {
          auditLog({ tool: "truenas_create_smb_share", method: "sharing.smb.create", target: `${name} (${path})`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update SMB share ----------------
    server.registerTool(
      "truenas_update_smb_share",
      {
        title: "Update SMB Share",
        description:
          "Update an existing SMB share by id (see truenas_list_shares). Supply only the fields to change. " +
          "Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("SMB share id"),
          enabled: z.boolean().optional(),
          readonly: z.boolean().optional(),
          browsable: z.boolean().optional(),
          comment: z.string().optional(),
          name: z.string().max(80).optional(),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ id, enabled, readonly, browsable, comment, name, response_format }): Promise<ToolResult> => {
        try {
          const data: Record<string, unknown> = {};
          if (enabled !== undefined) data.enabled = enabled;
          if (readonly !== undefined) data.readonly = readonly;
          if (browsable !== undefined) data.browsable = browsable;
          if (comment !== undefined) data.comment = comment;
          if (name !== undefined) data.name = name;
          if (Object.keys(data).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateSmbShare(id, data);
          auditLog({ tool: "truenas_update_smb_share", method: "sharing.smb.update", target: `smb:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format, () => `Updated SMB share ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_smb_share", method: "sharing.smb.update", target: `smb:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create NFS share ----------------
    server.registerTool(
      "truenas_create_nfs_share",
      {
        title: "Create NFS Share",
        description:
          "Create an NFS export for a path under /mnt, optionally limited to networks/hosts. Reversible. Shares " +
          "an existing dataset; does not create it. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          path: z.string().describe("Path to export, e.g. '/mnt/tank/backups'"),
          comment: z.string().optional(),
          networks: z.array(z.string()).optional().describe("Allowed CIDRs, e.g. ['192.168.0.0/24']"),
          hosts: z.array(z.string()).optional().describe("Allowed hosts/IPs"),
          readonly: z.boolean().default(false).describe("Export read-only (maps to 'ro')"),
          enabled: z.boolean().default(true),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), path: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ path, comment, networks, hosts, readonly, enabled, response_format }): Promise<ToolResult> => {
        try {
          await getClient().createNfsShare({ path, comment, networks, hosts, ro: readonly, enabled });
          auditLog({ tool: "truenas_create_nfs_share", method: "sharing.nfs.create", target: path, outcome: "success" });
          return respond({ created: true, path }, response_format, () => `Created NFS export → ${path}.`);
        } catch (error) {
          auditLog({ tool: "truenas_create_nfs_share", method: "sharing.nfs.create", target: path, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update NFS share ----------------
    server.registerTool(
      "truenas_update_nfs_share",
      {
        title: "Update NFS Share",
        description:
          "Update an existing NFS export by id (see truenas_list_shares). Supply only the fields to change. " +
          "Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("NFS share id"),
          enabled: z.boolean().optional(),
          readonly: z.boolean().optional().describe("maps to 'ro'"),
          comment: z.string().optional(),
          networks: z.array(z.string()).optional(),
          hosts: z.array(z.string()).optional(),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ id, enabled, readonly, comment, networks, hosts, response_format }): Promise<ToolResult> => {
        try {
          const data: Record<string, unknown> = {};
          if (enabled !== undefined) data.enabled = enabled;
          if (readonly !== undefined) data.ro = readonly;
          if (comment !== undefined) data.comment = comment;
          if (networks !== undefined) data.networks = networks;
          if (hosts !== undefined) data.hosts = hosts;
          if (Object.keys(data).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateNfsShare(id, data);
          auditLog({ tool: "truenas_update_nfs_share", method: "sharing.nfs.update", target: `nfs:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format, () => `Updated NFS export ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_nfs_share", method: "sharing.nfs.update", target: `nfs:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create user ----------------
    server.registerTool(
      "truenas_create_user",
      {
        title: "Create User",
        description:
          "Create a local user account. Provide a password OR set password_disabled=true for a key-only / no-" +
          "password account. The password is never logged or echoed back. Reversible (delete the user). " +
          "Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          username: z.string().describe("Login name, e.g. 'backupsvc'"),
          full_name: z.string().describe("Display name / description"),
          password: z.string().optional().describe("Password — kept out of logs and output; omit for a no-password account"),
          password_disabled: z.boolean().default(false).describe("Create with no password (key-only)"),
          create_primary_group: z.boolean().default(true).describe("Auto-create a primary group for this user"),
          group_id: z.number().int().optional().describe("Existing primary group id (only if create_primary_group=false)"),
          shell: z.string().optional().describe("Login shell, e.g. '/usr/bin/bash'"),
          smb: z.boolean().optional().describe("Allow SMB (Samba) authentication for this user"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), username: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ username, full_name, password, password_disabled, create_primary_group, group_id, shell, smb, response_format }): Promise<ToolResult> => {
        try {
          if (!password && !password_disabled) {
            throw new TrueNasError("Provide a password, or set password_disabled=true for a no-password account.");
          }
          if (!create_primary_group && group_id === undefined) {
            throw new TrueNasError("Set create_primary_group=true, or provide an existing group_id.");
          }
          await getClient().createUser({
            username,
            full_name,
            password,
            password_disabled: password_disabled || undefined,
            group_create: create_primary_group,
            group: create_primary_group ? undefined : group_id,
            shell,
            smb,
          });
          auditLog({ tool: "truenas_create_user", method: "user.create", target: username, outcome: "success" });
          return respond({ created: true, username }, response_format, () => `Created user **${username}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_create_user", method: "user.create", target: username, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update user ----------------
    server.registerTool(
      "truenas_update_user",
      {
        title: "Update User",
        description:
          "Update a user account by id (see truenas_list_* / the TrueNAS UI). Supply only fields to change. A " +
          "password, if given, is never logged or echoed. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("User id"),
          full_name: z.string().optional(),
          shell: z.string().optional(),
          smb: z.boolean().optional(),
          locked: z.boolean().optional().describe("Lock (disable) the account"),
          password: z.string().optional().describe("New password — kept out of logs and output"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ id, full_name, shell, smb, locked, password, response_format }): Promise<ToolResult> => {
        try {
          const data: Record<string, unknown> = {};
          if (full_name !== undefined) data.full_name = full_name;
          if (shell !== undefined) data.shell = shell;
          if (smb !== undefined) data.smb = smb;
          if (locked !== undefined) data.locked = locked;
          if (password !== undefined) data.password = password;
          if (Object.keys(data).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateUser(id, data);
          auditLog({ tool: "truenas_update_user", method: "user.update", target: `user:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format, () => `Updated user ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_user", method: "user.update", target: `user:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- set user password ----------------
    server.registerTool(
      "truenas_set_user_password",
      {
        title: "Set User Password",
        description:
          "Set a local user's password (by username). The new password is never logged or echoed back. " +
          "Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          username: z.string().describe("Username whose password to set"),
          new_password: z.string().min(1).describe("The new password — kept out of logs and output"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), username: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ username, new_password, response_format }): Promise<ToolResult> => {
        try {
          await getClient().setUserPassword(username, new_password);
          auditLog({ tool: "truenas_set_user_password", method: "user.set_password", target: username, outcome: "success" });
          return respond({ updated: true, username }, response_format, () => `Set password for user **${username}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_set_user_password", method: "user.set_password", target: username, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create group ----------------
    server.registerTool(
      "truenas_create_group",
      {
        title: "Create Group",
        description: "Create a local group. Reversible (delete the group). Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          name: z.string().describe("Group name"),
          gid: z.number().int().optional().describe("Explicit GID (auto-assigned if omitted)"),
          smb: z.boolean().optional().describe("Usable for SMB share ACLs"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), name: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ name, gid, smb, response_format }): Promise<ToolResult> => {
        try {
          await getClient().createGroup({ name, gid, smb });
          auditLog({ tool: "truenas_create_group", method: "group.create", target: name, outcome: "success" });
          return respond({ created: true, name }, response_format, () => `Created group **${name}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_create_group", method: "group.create", target: name, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update group ----------------
    server.registerTool(
      "truenas_update_group",
      {
        title: "Update Group",
        description: "Update a group by id. Supply only fields to change. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("Group id"),
          name: z.string().optional(),
          smb: z.boolean().optional(),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ id, name, smb, response_format }): Promise<ToolResult> => {
        try {
          const data: Record<string, unknown> = {};
          if (name !== undefined) data.name = name;
          if (smb !== undefined) data.smb = smb;
          if (Object.keys(data).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateGroup(id, data);
          auditLog({ tool: "truenas_update_group", method: "group.update", target: `group:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format, () => `Updated group ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_group", method: "group.update", target: `group:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create periodic snapshot task ----------------
    server.registerTool(
      "truenas_create_snapshot_task",
      {
        title: "Create Periodic Snapshot Task",
        description:
          "Set up an automatic snapshot schedule for a dataset with a retention policy. Reversible. Requires " +
          "TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Dataset to snapshot, e.g. 'tank/appdata'"),
          recursive: z.boolean().default(false).describe("Include child datasets"),
          keep_value: z.number().int().min(1).default(2).describe("Retention amount"),
          keep_unit: z.enum(["HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).default("WEEK").describe("Retention unit"),
          hour: z.string().default("0").describe("Cron hour 0-23"),
          minute: z.string().default("0").describe("Cron minute 0-59"),
          enabled: z.boolean().default(true),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), dataset: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ dataset, recursive, keep_value, keep_unit, hour, minute, enabled, response_format }): Promise<ToolResult> => {
        try {
          assertAllowedTarget(config, dataset);
          await getClient().createSnapshotTask({
            dataset,
            recursive,
            lifetime_value: keep_value,
            lifetime_unit: keep_unit,
            enabled,
            schedule: { minute, hour, dom: "*", month: "*", dow: "*" },
          });
          auditLog({ tool: "truenas_create_snapshot_task", method: "pool.snapshottask.create", target: dataset, outcome: "success" });
          return respond({ created: true, dataset }, response_format, () =>
            `Created snapshot task for **${dataset}** at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}, keeping ${keep_value} ${keep_unit.toLowerCase()}(s).`
          );
        } catch (error) {
          auditLog({ tool: "truenas_create_snapshot_task", method: "pool.snapshottask.create", target: dataset, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update periodic snapshot task ----------------
    server.registerTool(
      "truenas_update_snapshot_task",
      {
        title: "Update Periodic Snapshot Task",
        description: "Update a periodic snapshot task by id (enable/disable, recursive). Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("Snapshot task id (see truenas_list_snapshot_tasks)"),
          enabled: z.boolean().optional(),
          recursive: z.boolean().optional(),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ id, enabled, recursive, response_format }): Promise<ToolResult> => {
        try {
          const data: Record<string, unknown> = {};
          if (enabled !== undefined) data.enabled = enabled;
          if (recursive !== undefined) data.recursive = recursive;
          if (Object.keys(data).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateSnapshotTask(id, data);
          auditLog({ tool: "truenas_update_snapshot_task", method: "pool.snapshottask.update", target: `snaptask:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format, () => `Updated snapshot task ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_snapshot_task", method: "pool.snapshottask.update", target: `snaptask:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create scrub schedule ----------------
    server.registerTool(
      "truenas_create_scrub_task",
      {
        title: "Create Scheduled Scrub Task",
        description:
          "Schedule automatic scrubs for a pool. Note: pool is the numeric pool id (from pool.query), not the " +
          "name. Reversible. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          pool_id: z.number().int().describe("Numeric pool id (from the TrueNAS API / pool.query)"),
          threshold_days: z.number().int().min(0).default(35).describe("Minimum days between scrubs"),
          day_of_month: z.string().default("1").describe("Cron day-of-month to run"),
          enabled: z.boolean().default(true),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), pool_id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ pool_id, threshold_days, day_of_month, enabled, response_format }): Promise<ToolResult> => {
        try {
          await getClient().createScrubTask({
            pool: pool_id,
            threshold: threshold_days,
            enabled,
            schedule: { minute: "0", hour: "0", dom: day_of_month, month: "*", dow: "*" },
          });
          auditLog({ tool: "truenas_create_scrub_task", method: "pool.scrub.create", target: `pool:${pool_id}`, outcome: "success" });
          return respond({ created: true, pool_id }, response_format, () => `Created scrub schedule for pool id ${pool_id} (every ${threshold_days} days).`);
        } catch (error) {
          auditLog({ tool: "truenas_create_scrub_task", method: "pool.scrub.create", target: `pool:${pool_id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update scrub schedule ----------------
    server.registerTool(
      "truenas_update_scrub_task",
      {
        title: "Update Scheduled Scrub Task",
        description: "Update a scrub schedule by id (enable/disable, threshold). Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("Scrub task id (see truenas_list_scrub_tasks)"),
          enabled: z.boolean().optional(),
          threshold_days: z.number().int().min(0).optional(),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async ({ id, enabled, threshold_days, response_format }): Promise<ToolResult> => {
        try {
          const data: Record<string, unknown> = {};
          if (enabled !== undefined) data.enabled = enabled;
          if (threshold_days !== undefined) data.threshold = threshold_days;
          if (Object.keys(data).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateScrubTask(id, data);
          auditLog({ tool: "truenas_update_scrub_task", method: "pool.scrub.update", target: `scrubtask:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format, () => `Updated scrub task ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_scrub_task", method: "pool.scrub.update", target: `scrubtask:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ================================================================
    // Data-protection actions (Phase 2). Trigger existing backup tasks,
    // provision rsync tasks, and clone snapshots — all reversible.
    // ================================================================

    // Shared helper: run an existing backup task by id and surface job state.
    const runBackupTool = (
      name: string,
      method: string,
      label: string,
      run: (client: TrueNasClient, id: number) => Promise<JobOutcome>
    ): void => {
      server.registerTool(
        name,
        {
          title: `Run ${label} Now`,
          description:
            `Manually trigger an existing ${label.toLowerCase()} task by id (see the matching list tool) so it ` +
            `runs immediately instead of waiting for its schedule. Runs as a job; the final state is reported. ` +
            `A safe, reversible action. Requires TRUENAS_ENABLE_WRITE=1.`,
          inputSchema: z.object({
            id: z.number().int().describe(`${label} task id`),
            response_format: responseFormat,
          }),
          outputSchema: z.object({
            id: z.number(),
            job_id: z.number().nullable(),
            state: z.string(),
            error: z.string().nullable(),
          }),
          annotations: SAFE_WRITE,
        },
        async ({ id, response_format }): Promise<ToolResult> => {
          try {
            const out = await run(getClient(), id);
            auditLog({ tool: name, method, target: `${label}:${id}`, outcome: out.error ? `error: ${out.error}` : out.state });
            const structured = { id, job_id: out.jobId, state: out.state, error: out.error };
            return respond(structured, response_format, () =>
              out.error
                ? `${label} task ${id} failed: ${out.error}`
                : `${label} task ${id} → **${out.state}**${out.jobId ? ` (job ${out.jobId})` : ""}.`
            );
          } catch (error) {
            auditLog({ tool: name, method, target: `${label}:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
            return errorResult(error);
          }
        }
      );
    };

    runBackupTool("truenas_run_cloudsync_task", "cloudsync.sync", "Cloud Sync", (c, id) => c.runCloudsyncTask(id));
    runBackupTool("truenas_run_replication_task", "replication.run", "Replication", (c, id) => c.runReplicationTask(id));
    runBackupTool("truenas_run_rsync_task", "rsynctask.run", "Rsync", (c, id) => c.runRsyncTask(id));

    // ---------------- clone snapshot ----------------
    server.registerTool(
      "truenas_clone_snapshot",
      {
        title: "Clone a Snapshot to a New Dataset",
        description:
          "Clone a ZFS snapshot into a NEW dataset. Non-destructive: the source dataset and snapshot are untouched, " +
          "and a clone shares the snapshot's blocks (near-zero space until written). Great for recovering files " +
          "from a snapshot or spinning up a copy for inspection. The destination must not already exist and must be " +
          "on the same pool as the snapshot. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          snapshot: z.string().describe("Source snapshot, e.g. 'HDD/data@auto-2026-08-10_00-00'"),
          destination: z.string().describe("New dataset path for the clone, e.g. 'HDD/restore-view' (must not exist)"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ cloned: z.boolean(), snapshot: z.string(), destination: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ snapshot, destination, response_format }): Promise<ToolResult> => {
        try {
          assertAllowedTarget(config, destination);
          await getClient().cloneSnapshot(snapshot, destination);
          auditLog({ tool: "truenas_clone_snapshot", method: "pool.snapshot.clone", target: destination, outcome: "success" });
          return respond({ cloned: true, snapshot, destination }, response_format, () =>
            `Cloned **${snapshot}** → new dataset **${destination}**.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_clone_snapshot", method: "pool.snapshot.clone", target: destination, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- rsync task create / update ----------------
    const rsyncFields = {
      path: z.string().describe("Local path to sync, e.g. '/mnt/HDD/backups'"),
      user: z.string().describe("Local user to run the transfer as, e.g. 'root'"),
      direction: z.enum(["PUSH", "PULL"]).default("PUSH").describe("PUSH = send local→remote; PULL = fetch remote→local"),
      mode: z.enum(["MODULE", "SSH"]).default("SSH").describe("SSH (to another server over SSH) or MODULE (to an rsyncd module)"),
      remotehost: z.string().optional().describe("Remote host (SSH mode, or MODULE host)"),
      remoteport: z.number().int().optional().describe("Remote SSH port (SSH mode)"),
      remotemodule: z.string().optional().describe("Remote rsyncd module name (MODULE mode)"),
      remotepath: z.string().optional().describe("Remote path (SSH mode)"),
      ssh_credentials: z.number().int().optional().describe("Keychain SSH credential id (SSH mode; create it in the TrueNAS UI first)"),
      desc: z.string().optional().describe("Description"),
      recursive: z.boolean().optional(),
      compress: z.boolean().optional(),
      archive: z.boolean().optional(),
      times: z.boolean().optional(),
      delete: z.boolean().optional().describe("Delete files on the receiving side that no longer exist on the sender"),
      preserveperm: z.boolean().optional(),
      preserveattr: z.boolean().optional(),
      extra: z.array(z.string()).optional().describe("Extra raw rsync flags"),
      enabled: z.boolean().optional(),
      minute: z.string().optional().describe("Cron minute (default '0')"),
      hour: z.string().optional().describe("Cron hour (default '*')"),
      dom: z.string().optional().describe("Cron day-of-month (default '*')"),
      month: z.string().optional().describe("Cron month (default '*')"),
      dow: z.string().optional().describe("Cron day-of-week (default '*')"),
    };
    const toRsyncOpts = (a: Record<string, unknown>): RsyncTaskOptions => {
      const o: RsyncTaskOptions = {};
      for (const k of ["path", "user", "direction", "mode", "remotehost", "remoteport", "remotemodule", "remotepath", "ssh_credentials", "desc", "recursive", "compress", "archive", "times", "delete", "preserveperm", "preserveattr", "extra", "enabled"] as const) {
        if (a[k] !== undefined) (o as Record<string, unknown>)[k] = a[k];
      }
      if (a.minute !== undefined || a.hour !== undefined || a.dom !== undefined || a.month !== undefined || a.dow !== undefined) {
        o.schedule = {
          minute: (a.minute as string) ?? "0",
          hour: (a.hour as string) ?? "*",
          dom: (a.dom as string) ?? "*",
          month: (a.month as string) ?? "*",
          dow: (a.dow as string) ?? "*",
        };
      }
      return o;
    };

    server.registerTool(
      "truenas_create_rsync_task",
      {
        title: "Create Rsync Task",
        description:
          "Create a scheduled rsync task (e.g. to back up a dataset to another NAS). SSH mode needs a keychain SSH " +
          "credential (create it once in the TrueNAS UI) plus remotehost/remotepath; MODULE mode needs remotehost " +
          "and remotemodule. This does NOT modify the local SSH server. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({ ...rsyncFields, response_format: responseFormat }),
        outputSchema: z.object({ created: z.boolean(), id: z.number().nullable(), path: z.string() }),
        annotations: SAFE_WRITE,
      },
      async (args): Promise<ToolResult> => {
        const { response_format } = args;
        try {
          assertAllowedTarget(config, args.path as string);
          const raw = (await getClient().createRsyncTask(toRsyncOpts(args))) as { id?: number };
          auditLog({ tool: "truenas_create_rsync_task", method: "rsynctask.create", target: args.path as string, outcome: "success" });
          return respond({ created: true, id: raw?.id ?? null, path: args.path as string }, response_format, () =>
            `Created rsync task${raw?.id ? ` (id ${raw.id})` : ""} for **${args.path}** → ${args.remotehost ?? args.remotemodule ?? "remote"}.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_create_rsync_task", method: "rsynctask.create", target: args.path as string, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    server.registerTool(
      "truenas_update_rsync_task",
      {
        title: "Update Rsync Task",
        description:
          "Update an existing rsync task by id (see truenas_list_rsync_tasks). Supply only the fields you want to " +
          "change. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("Rsync task id"),
          ...Object.fromEntries(Object.entries(rsyncFields).map(([k, v]) => [k, (v as z.ZodTypeAny).isOptional() ? v : (v as z.ZodTypeAny).optional()])),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async (args): Promise<ToolResult> => {
        const { id, response_format } = args as { id: number; response_format?: "markdown" | "json" };
        try {
          const opts = toRsyncOpts(args as Record<string, unknown>);
          if (Object.keys(opts).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateRsyncTask(id, opts);
          auditLog({ tool: "truenas_update_rsync_task", method: "rsynctask.update", target: `rsync:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format ?? "markdown", () => `Updated rsync task ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_rsync_task", method: "rsynctask.update", target: `rsync:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ================================================================
    // App & VM provisioning (Phase 3).
    // ================================================================

    // ---------------- create app (install from catalog) ----------------
    server.registerTool(
      "truenas_create_app",
      {
        title: "Install an App from the Catalog",
        description:
          "Install an app from the catalog (see truenas_list_catalog_apps for names). Runs as a job. 'values' is the " +
          "app's config object (same keys the UI install form uses); omit it to accept catalog defaults. A reversible " +
          "action — the app can be stopped or deleted later. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          app_name: z.string().describe("Name for the new app instance, e.g. 'photoprism'"),
          catalog_app: z.string().describe("Catalog app to install, e.g. 'photoprism' (from truenas_list_catalog_apps)"),
          train: z.string().default("stable").describe("Catalog train: stable | enterprise | community"),
          version: z.string().optional().describe("Specific version (defaults to latest)"),
          values: z.record(z.string(), z.unknown()).optional().describe("App config values object (optional; defaults used if omitted)"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ app_name: z.string(), job_id: z.number().nullable(), state: z.string(), error: z.string().nullable() }),
        annotations: SAFE_WRITE,
      },
      async ({ app_name, catalog_app, train, version, values, response_format }): Promise<ToolResult> => {
        try {
          const out = await getClient().createApp({ app_name, catalog_app, train, version, values });
          auditLog({ tool: "truenas_create_app", method: "app.create", target: app_name, outcome: out.error ? `error: ${out.error}` : out.state });
          const structured = { app_name, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error
              ? `Installing **${app_name}** failed: ${out.error}`
              : `App **${app_name}** (${catalog_app}) → **${out.state}**${out.jobId ? ` (job ${out.jobId})` : ""}.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_create_app", method: "app.create", target: app_name, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- update app config ----------------
    server.registerTool(
      "truenas_update_app",
      {
        title: "Update an App's Config",
        description:
          "Change an installed app's configuration values (the same keys shown in the app's Edit form). Runs as a job " +
          "and redeploys the app. Supply the full 'values' object for the keys you are changing. Requires " +
          "TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          app: z.string().describe("Installed app name (see truenas_list_apps)"),
          values: z.record(z.string(), z.unknown()).describe("Config values to apply"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ app: z.string(), job_id: z.number().nullable(), state: z.string(), error: z.string().nullable() }),
        annotations: SAFE_WRITE,
      },
      async ({ app, values, response_format }): Promise<ToolResult> => {
        try {
          const out = await getClient().updateApp(app, values);
          auditLog({ tool: "truenas_update_app", method: "app.update", target: app, outcome: out.error ? `error: ${out.error}` : out.state });
          const structured = { app, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error ? `Updating **${app}** failed: ${out.error}` : `App **${app}** updated → **${out.state}**.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_update_app", method: "app.update", target: app, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- create / update VM ----------------
    const vmFields = {
      description: z.string().optional(),
      vcpus: z.number().int().min(1).optional().describe("Virtual CPU sockets"),
      cores: z.number().int().min(1).optional(),
      threads: z.number().int().min(1).optional(),
      min_memory: z.number().int().min(64).optional().describe("Ballooning minimum RAM in MiB"),
      autostart: z.boolean().optional().describe("Start automatically on boot"),
      bootloader: z.enum(["UEFI", "UEFI_CSM"]).optional(),
      shutdown_timeout: z.number().int().min(0).optional(),
      time: z.enum(["LOCAL", "UTC"]).optional(),
      cpu_mode: z.enum(["CUSTOM", "HOST-MODEL", "HOST-PASSTHROUGH"]).optional(),
    };
    const toVmOpts = (a: Record<string, unknown>): VmOptions => {
      const o: VmOptions = {};
      for (const k of ["name", "description", "vcpus", "cores", "threads", "memory", "min_memory", "autostart", "bootloader", "shutdown_timeout", "time", "cpu_mode"] as const) {
        if (a[k] !== undefined) (o as Record<string, unknown>)[k] = a[k];
      }
      return o;
    };

    server.registerTool(
      "truenas_create_vm",
      {
        title: "Create a Virtual Machine",
        description:
          "Create a VM shell (CPU/memory/boot config). Disks, NICs, and a display are added separately (in the UI or " +
          "via the VM devices API) before the VM is useful. A reversible action — the VM can be deleted later. " +
          "Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          name: z.string().describe("VM name, e.g. 'test-vm'"),
          memory: z.number().int().min(64).describe("RAM in MiB (required), e.g. 2048"),
          ...vmFields,
          response_format: responseFormat,
        }),
        outputSchema: z.object({ created: z.boolean(), id: z.number().nullable(), name: z.string() }),
        annotations: SAFE_WRITE,
      },
      async (args): Promise<ToolResult> => {
        const { name, response_format } = args as { name: string; response_format?: "markdown" | "json" };
        try {
          const raw = (await getClient().createVm(toVmOpts(args as Record<string, unknown>))) as { id?: number };
          auditLog({ tool: "truenas_create_vm", method: "vm.create", target: name, outcome: "success" });
          return respond({ created: true, id: raw?.id ?? null, name }, response_format ?? "markdown", () =>
            `Created VM **${name}**${raw?.id ? ` (id ${raw.id})` : ""}. Add disks/NIC/display before starting it.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_create_vm", method: "vm.create", target: name, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    server.registerTool(
      "truenas_update_vm",
      {
        title: "Update a Virtual Machine's Config",
        description:
          "Update an existing VM's config (name, vcpus/cores/threads, memory, autostart, bootloader, etc.). Supply " +
          "only the fields to change; the VM should be stopped for CPU/memory changes. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          id: z.number().int().describe("VM id (see truenas_list_vms)"),
          name: z.string().optional().describe("New VM name"),
          memory: z.number().int().min(64).optional().describe("RAM in MiB"),
          ...vmFields,
          response_format: responseFormat,
        }),
        outputSchema: z.object({ updated: z.boolean(), id: z.number() }),
        annotations: SAFE_WRITE,
      },
      async (args): Promise<ToolResult> => {
        const { id, response_format } = args as { id: number; response_format?: "markdown" | "json" };
        try {
          const opts = toVmOpts(args as Record<string, unknown>);
          if (Object.keys(opts).length === 0) throw new TrueNasError("No fields supplied to update.");
          await getClient().updateVm(id, opts);
          auditLog({ tool: "truenas_update_vm", method: "vm.update", target: `vm:${id}`, outcome: "success" });
          return respond({ updated: true, id }, response_format ?? "markdown", () => `Updated VM ${id}.`);
        } catch (error) {
          auditLog({ tool: "truenas_update_vm", method: "vm.update", target: `vm:${id}`, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ================================================================
    // Storage & encryption depth (Phase 4).
    // ================================================================

    // ---------------- unlock encrypted dataset ----------------
    server.registerTool(
      "truenas_unlock_dataset",
      {
        title: "Unlock an Encrypted Dataset",
        description:
          "Unlock a locked encrypted dataset by supplying its passphrase or hex key. Reversible (see " +
          "truenas_lock_dataset). Runs as a job. The secret is sent straight to TrueNAS and is never logged or echoed. " +
          "Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Encrypted dataset id / path, e.g. 'SSD/PostgreSQL'"),
          passphrase: z.string().optional().describe("Passphrase (for passphrase-encrypted datasets)"),
          key: z.string().optional().describe("Hex key (for key-encrypted datasets)"),
          recursive: z.boolean().default(false).describe("Also unlock encrypted children"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ dataset: z.string(), job_id: z.number().nullable(), state: z.string(), error: z.string().nullable() }),
        annotations: SAFE_WRITE,
      },
      async ({ dataset, passphrase, key, recursive, response_format }): Promise<ToolResult> => {
        try {
          if (!passphrase && !key) throw new TrueNasError("Provide either a passphrase or a hex key to unlock.");
          const out = await getClient().unlockDataset(dataset, { passphrase, key, recursive });
          // NOTE: target is the dataset name only — the passphrase/key is never logged.
          auditLog({ tool: "truenas_unlock_dataset", method: "pool.dataset.unlock", target: dataset, outcome: out.error ? `error: ${out.error}` : out.state });
          const structured = { dataset, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error ? `Unlock of **${dataset}** failed: ${out.error}` : `Unlocked **${dataset}** → **${out.state}**.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_unlock_dataset", method: "pool.dataset.unlock", target: dataset, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- change dataset encryption key ----------------
    server.registerTool(
      "truenas_change_dataset_key",
      {
        title: "Rotate a Dataset's Encryption Key",
        description:
          "Change an encrypted dataset's passphrase or key (re-wraps the key — data is preserved). Supply a new " +
          "passphrase, a new hex key, or generate_key=true to have TrueNAS generate one. Runs as a job. The secret is " +
          "never logged or echoed. Back up your config afterward. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Encrypted dataset id / path"),
          passphrase: z.string().optional().describe("New passphrase"),
          key: z.string().optional().describe("New hex key"),
          generate_key: z.boolean().optional().describe("Let TrueNAS generate a new random key"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ dataset: z.string(), job_id: z.number().nullable(), state: z.string(), error: z.string().nullable() }),
        annotations: SAFE_WRITE,
      },
      async ({ dataset, passphrase, key, generate_key, response_format }): Promise<ToolResult> => {
        try {
          if (!passphrase && !key && !generate_key) throw new TrueNasError("Provide a new passphrase, a hex key, or generate_key=true.");
          const out = await getClient().changeDatasetKey(dataset, { passphrase, key, generate_key });
          auditLog({ tool: "truenas_change_dataset_key", method: "pool.dataset.change_key", target: dataset, outcome: out.error ? `error: ${out.error}` : out.state });
          const structured = { dataset, job_id: out.jobId, state: out.state, error: out.error };
          return respond(structured, response_format, () =>
            out.error ? `Key rotation for **${dataset}** failed: ${out.error}` : `Rotated encryption key for **${dataset}** → **${out.state}**. Back up your config now.`
          );
        } catch (error) {
          auditLog({ tool: "truenas_change_dataset_key", method: "pool.dataset.change_key", target: dataset, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- promote clone ----------------
    server.registerTool(
      "truenas_promote_dataset",
      {
        title: "Promote a Cloned Dataset",
        description:
          "Promote a clone (from truenas_clone_snapshot) so it no longer depends on its origin snapshot — after this " +
          "the origin dataset/snapshot can be deleted independently. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          dataset: z.string().describe("Clone dataset id / path to promote"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ promoted: z.boolean(), dataset: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ dataset, response_format }): Promise<ToolResult> => {
        try {
          await getClient().promoteDataset(dataset);
          auditLog({ tool: "truenas_promote_dataset", method: "pool.dataset.promote", target: dataset, outcome: "success" });
          return respond({ promoted: true, dataset }, response_format, () => `Promoted clone **${dataset}** — it is now independent of its origin.`);
        } catch (error) {
          auditLog({ tool: "truenas_promote_dataset", method: "pool.dataset.promote", target: dataset, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ---------------- hold / release snapshot ----------------
    server.registerTool(
      "truenas_hold_snapshot",
      {
        title: "Hold a Snapshot (Protect from Deletion)",
        description:
          "Place a hold on a snapshot so it cannot be deleted until released. Useful to protect a known-good " +
          "restore point. Reversible with truenas_release_snapshot. Requires TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          snapshot: z.string().describe("Snapshot id, e.g. 'HDD/data@keep-me'"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ held: z.boolean(), snapshot: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ snapshot, response_format }): Promise<ToolResult> => {
        try {
          await getClient().holdSnapshot(snapshot);
          auditLog({ tool: "truenas_hold_snapshot", method: "pool.snapshot.hold", target: snapshot, outcome: "success" });
          return respond({ held: true, snapshot }, response_format, () => `Held snapshot **${snapshot}** — it can't be deleted until released.`);
        } catch (error) {
          auditLog({ tool: "truenas_hold_snapshot", method: "pool.snapshot.hold", target: snapshot, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    server.registerTool(
      "truenas_release_snapshot",
      {
        title: "Release a Snapshot Hold",
        description:
          "Remove a hold placed by truenas_hold_snapshot, allowing the snapshot to be deleted again. Requires " +
          "TRUENAS_ENABLE_WRITE=1.",
        inputSchema: z.object({
          snapshot: z.string().describe("Snapshot id, e.g. 'HDD/data@keep-me'"),
          response_format: responseFormat,
        }),
        outputSchema: z.object({ released: z.boolean(), snapshot: z.string() }),
        annotations: SAFE_WRITE,
      },
      async ({ snapshot, response_format }): Promise<ToolResult> => {
        try {
          await getClient().releaseSnapshot(snapshot);
          auditLog({ tool: "truenas_release_snapshot", method: "pool.snapshot.release", target: snapshot, outcome: "success" });
          return respond({ released: true, snapshot }, response_format, () => `Released hold on **${snapshot}**.`);
        } catch (error) {
          auditLog({ tool: "truenas_release_snapshot", method: "pool.snapshot.release", target: snapshot, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
          return errorResult(error);
        }
      }
    );

    // ================================================================
    // Block sharing: iSCSI + NVMe-oF provisioning (Phase 5).
    // ================================================================

    // Helper for the many similar "create a block-sharing resource" tools.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const simpleCreate = (spec: {
      name: string;
      title: string;
      description: string;
      inputSchema: z.ZodObject<any>;
      method: string;
      target: (args: GateArgs) => string;
      run: (client: TrueNasClient, args: GateArgs) => Promise<unknown>;
      summary: (args: GateArgs, result: { id?: number }) => string;
    }): void => {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description + " Requires TRUENAS_ENABLE_WRITE=1.",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: spec.inputSchema.extend({ response_format: responseFormat }) as any,
          outputSchema: z.object({ created: z.boolean(), id: z.number().nullable() }),
          annotations: SAFE_WRITE,
        },
        async (args: GateArgs): Promise<ToolResult> => {
          const format = (args.response_format ?? "markdown") as "markdown" | "json";
          try {
            const r = (await spec.run(getClient(), args)) as { id?: number };
            auditLog({ tool: spec.name, method: spec.method, target: spec.target(args), outcome: "success" });
            return respond({ created: true, id: r?.id ?? null }, format, () => spec.summary(args, r ?? {}));
          } catch (error) {
            auditLog({ tool: spec.name, method: spec.method, target: spec.target(args), outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
            return errorResult(error);
          }
        }
      );
    };

    // ---- iSCSI ----
    simpleCreate({
      name: "truenas_create_iscsi_portal",
      title: "Create iSCSI Portal",
      description: "Create an iSCSI portal — the IP(s) the target service listens on. Use the returned id when creating a target.",
      inputSchema: z.object({
        listen: z.array(z.string()).min(1).describe("IP address(es) to listen on, e.g. ['0.0.0.0']"),
        comment: z.string().optional(),
        discovery_authmethod: z.enum(["NONE", "CHAP", "CHAP_MUTUAL"]).optional(),
        discovery_authgroup: z.number().int().optional().describe("CHAP auth group tag for discovery"),
      }),
      method: "iscsi.portal.create",
      target: (a) => `portal:${(a.listen as string[]).join(",")}`,
      run: (c, a) => c.createIscsiPortal(a as { listen: string[]; comment?: string; discovery_authmethod?: string; discovery_authgroup?: number }),
      summary: (a, r) => `Created iSCSI portal${r.id ? ` (id ${r.id})` : ""} listening on ${(a.listen as string[]).join(", ")}.`,
    });

    simpleCreate({
      name: "truenas_create_iscsi_target",
      title: "Create iSCSI Target",
      description: "Create an iSCSI target. Optionally attach a portal group (portal id + optional initiator/auth). Map extents to it with truenas_create_iscsi_targetextent.",
      inputSchema: z.object({
        name: z.string().describe("Target name (lowercase, becomes part of the IQN)"),
        alias: z.string().optional(),
        mode: z.enum(["ISCSI", "FC", "BOTH"]).optional(),
        portal: z.number().int().optional().describe("Portal id to attach (from truenas_create_iscsi_portal)"),
        initiator: z.number().int().optional().describe("Initiator group id"),
        auth: z.number().int().optional().describe("CHAP auth group tag"),
        authmethod: z.enum(["NONE", "CHAP", "CHAP_MUTUAL"]).optional(),
      }),
      method: "iscsi.target.create",
      target: (a) => `target:${a.name}`,
      run: (c, a) => c.createIscsiTarget(a as { name: string; alias?: string; mode?: string; portal?: number; initiator?: number; auth?: number; authmethod?: string }),
      summary: (a, r) => `Created iSCSI target **${a.name}**${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_iscsi_extent",
      title: "Create iSCSI Extent",
      description: "Create an iSCSI extent — the backing storage for a LUN. Use type=DISK with a zvol (disk='zvol/POOL/NAME'), or type=FILE with a path and filesize.",
      inputSchema: z.object({
        name: z.string(),
        type: z.enum(["DISK", "FILE"]).default("DISK"),
        disk: z.string().optional().describe("Backing zvol for DISK type, e.g. 'zvol/SSD/lun0'"),
        path: z.string().optional().describe("File path for FILE type, e.g. '/mnt/SSD/lun0.img'"),
        filesize: z.number().int().optional().describe("File size in bytes (FILE type)"),
        blocksize: z.number().int().optional().describe("Logical block size (512/1024/2048/4096)"),
        comment: z.string().optional(),
      }),
      method: "iscsi.extent.create",
      target: (a) => `extent:${a.name}`,
      run: (c, a) => c.createIscsiExtent(a as { name: string; type?: string; disk?: string; path?: string; filesize?: number; blocksize?: number; comment?: string }),
      summary: (a, r) => `Created iSCSI extent **${a.name}**${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_iscsi_targetextent",
      title: "Map iSCSI Extent to Target (LUN)",
      description: "Associate an extent with a target as a LUN. This is the step that exposes the storage over iSCSI.",
      inputSchema: z.object({
        target: z.number().int().describe("Target id"),
        extent: z.number().int().describe("Extent id"),
        lunid: z.number().int().optional().describe("LUN id (auto-assigned if omitted)"),
      }),
      method: "iscsi.targetextent.create",
      target: (a) => `targetextent:t${a.target}-e${a.extent}`,
      run: (c, a) => c.createIscsiTargetExtent(a as { target: number; extent: number; lunid?: number }),
      summary: (a, r) => `Mapped extent ${a.extent} to target ${a.target}${r.id ? ` (LUN map id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_iscsi_auth",
      title: "Create iSCSI CHAP Auth",
      description: "Create a CHAP authentication group. The secret (and optional mutual peersecret) are sent to TrueNAS and never logged or echoed.",
      inputSchema: z.object({
        tag: z.number().int().describe("Auth group tag (group multiple entries under one number)"),
        user: z.string().describe("CHAP username"),
        secret: z.string().describe("CHAP secret (12–16 chars)"),
        peeruser: z.string().optional().describe("Mutual CHAP username"),
        peersecret: z.string().optional().describe("Mutual CHAP secret"),
      }),
      method: "iscsi.auth.create",
      target: (a) => `auth:tag${a.tag}`,
      run: (c, a) => c.createIscsiAuth(a as { tag: number; user: string; secret: string; peeruser?: string; peersecret?: string }),
      summary: (a, r) => `Created CHAP auth for user **${a.user}** (tag ${a.tag})${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_iscsi_initiator",
      title: "Create iSCSI Initiator Group",
      description: "Create an allowed-initiators group. Leave 'initiators' empty to allow all initiators.",
      inputSchema: z.object({
        initiators: z.array(z.string()).optional().describe("Allowed initiator IQNs (empty/omitted = allow all)"),
        comment: z.string().optional(),
      }),
      method: "iscsi.initiator.create",
      target: () => "initiator",
      run: (c, a) => c.createIscsiInitiator(a as { initiators?: string[]; comment?: string }),
      summary: (a, r) => `Created iSCSI initiator group${r.id ? ` (id ${r.id})` : ""}.`,
    });

    // ---- NVMe-oF ----
    simpleCreate({
      name: "truenas_create_nvme_subsystem",
      title: "Create NVMe-oF Subsystem",
      description: "Create an NVMe-oF subsystem (the NVMe equivalent of an iSCSI target). Add namespaces and link a port to expose it.",
      inputSchema: z.object({
        name: z.string().describe("Subsystem name (becomes part of the NQN)"),
        allow_any_host: z.boolean().optional().describe("Allow any host to connect (skip host allow-list)"),
      }),
      method: "nvmet.subsys.create",
      target: (a) => `subsys:${a.name}`,
      run: (c, a) => c.createNvmeSubsys(a as { name: string; allow_any_host?: boolean }),
      summary: (a, r) => `Created NVMe-oF subsystem **${a.name}**${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_nvme_namespace",
      title: "Create NVMe-oF Namespace",
      description: "Create a namespace (backing storage) in a subsystem. Use device_type=ZVOL with device_path='zvol/POOL/NAME', or device_type=FILE with a path and filesize.",
      inputSchema: z.object({
        subsys_id: z.number().int().describe("Subsystem id"),
        device_type: z.enum(["ZVOL", "FILE"]),
        device_path: z.string().describe("'zvol/POOL/NAME' for ZVOL, or a file path for FILE"),
        filesize: z.number().int().optional().describe("File size in bytes (FILE type)"),
      }),
      method: "nvmet.namespace.create",
      target: (a) => `namespace:s${a.subsys_id}`,
      run: (c, a) => c.createNvmeNamespace(a as { subsys_id: number; device_type: string; device_path: string; filesize?: number }),
      summary: (a, r) => `Created NVMe namespace on subsystem ${a.subsys_id}${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_nvme_port",
      title: "Create NVMe-oF Port",
      description: "Create a transport port (where the subsystem is reachable). For TCP set addr_traddr (IP) and addr_trsvcid (e.g. 4420).",
      inputSchema: z.object({
        addr_trtype: z.enum(["TCP", "RDMA", "FC"]).describe("Transport type"),
        addr_traddr: z.string().optional().describe("Listen IP (TCP/RDMA)"),
        addr_trsvcid: z.number().int().optional().describe("Port number, e.g. 4420 (TCP/RDMA)"),
        addr_adrfam: z.enum(["IPV4", "IPV6"]).optional(),
      }),
      method: "nvmet.port.create",
      target: (a) => `port:${a.addr_trtype}:${a.addr_traddr ?? "?"}`,
      run: (c, a) => c.createNvmePort(a as { addr_trtype: string; addr_traddr?: string; addr_trsvcid?: number; addr_adrfam?: string }),
      summary: (a, r) => `Created NVMe-oF ${a.addr_trtype} port${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_nvme_port_subsys",
      title: "Link NVMe-oF Port to Subsystem",
      description: "Associate a port with a subsystem — this is the step that actually exposes the subsystem on that transport.",
      inputSchema: z.object({
        port_id: z.number().int().describe("Port id"),
        subsys_id: z.number().int().describe("Subsystem id"),
      }),
      method: "nvmet.port_subsys.create",
      target: (a) => `port_subsys:p${a.port_id}-s${a.subsys_id}`,
      run: (c, a) => c.createNvmePortSubsys(a as { port_id: number; subsys_id: number }),
      summary: (a, r) => `Linked port ${a.port_id} to subsystem ${a.subsys_id}${r.id ? ` (id ${r.id})` : ""}.`,
    });

    simpleCreate({
      name: "truenas_create_nvme_host",
      title: "Create NVMe-oF Host",
      description: "Register an allowed host by its NQN (for subsystems that don't allow any host). Link it to a subsystem in the UI or via host_subsys.",
      inputSchema: z.object({
        hostnqn: z.string().describe("Host NQN, e.g. 'nqn.2014-08.org.nvmexpress:uuid:...'"),
      }),
      method: "nvmet.host.create",
      target: (a) => `host:${a.hostnqn}`,
      run: (c, a) => c.createNvmeHost(a as { hostnqn: string }),
      summary: (a, r) => `Registered NVMe-oF host${r.id ? ` (id ${r.id})` : ""}.`,
    });
  }

  // ================================================================
  // Destructive tier — registered ONLY when BOTH TRUENAS_ENABLE_WRITE=1 AND
  // TRUENAS_ENABLE_DESTRUCTIVE=1. Each is gated by a human elicitation
  // confirmation and fails closed when the client can't be prompted. The
  // catastrophic disk.wipe / pool.create / pool.export-with-destroy are
  // intentionally NOT implemented (UI-only).
  // ================================================================
  if (config.enableWrite && config.enableDestructive) {
    registerDestructive(server, config, getClient, {
      name: "truenas_delete_snapshot",
      title: "Delete ZFS Snapshot",
      description:
        "Permanently delete a ZFS snapshot. IRREVERSIBLE. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 and a human " +
        "confirmation; refuses if the client can't be prompted for confirmation.",
      inputSchema: z.object({
        snapshot: z.string().describe("Snapshot id, e.g. 'tank/data@snap1'"),
        recursive: z.boolean().default(false).describe("Also delete child snapshots"),
        response_format: responseFormat,
      }),
      method: "pool.snapshot.delete",
      action: (a) => `delete snapshot ${a.snapshot}`,
      target: (a) => a.snapshot,
      guardTarget: (a) => a.snapshot,
      run: (c, a) => c.deleteSnapshot(a.snapshot, a.recursive),
      summary: (a) => `Deleted snapshot **${a.snapshot}**.`,
    });

    // ---- D1: deletes ----
    registerDestructive(server, config, getClient, {
      name: "truenas_delete_dataset",
      title: "Delete Dataset",
      description:
        "Permanently delete a ZFS dataset/zvol AND ALL ITS DATA (with recursive, its children too). " +
        "IRREVERSIBLE. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + human confirmation.",
      inputSchema: z.object({
        dataset: z.string().describe("Dataset id / full path, e.g. 'tank/old'"),
        recursive: z.boolean().default(false).describe("Also delete child datasets"),
        force: z.boolean().default(false).describe("Delete even if busy (e.g. actively shared)"),
        response_format: responseFormat,
      }),
      method: "pool.dataset.delete",
      action: (a) => `delete dataset ${a.dataset}${a.recursive ? " and its children" : ""} (destroys its data)`,
      target: (a) => a.dataset,
      guardTarget: (a) => a.dataset,
      run: (c, a) => c.deleteDataset(a.dataset, a.recursive, a.force),
      summary: (a) => `Deleted dataset **${a.dataset}**.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_smb_share",
      title: "Delete SMB Share",
      description:
        "Delete an SMB share by id (terminates active client connections). The underlying data is NOT deleted. " +
        "Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ id: z.number().int().describe("SMB share id"), response_format: responseFormat }),
      method: "sharing.smb.delete",
      action: (a) => `delete SMB share ${a.id}`,
      target: (a) => `smb:${a.id}`,
      run: (c, a) => c.deleteSmbShare(a.id),
      summary: (a) => `Deleted SMB share ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_nfs_share",
      title: "Delete NFS Share",
      description:
        "Delete an NFS export by id. The underlying data is NOT deleted. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ id: z.number().int().describe("NFS share id"), response_format: responseFormat }),
      method: "sharing.nfs.delete",
      action: (a) => `delete NFS share ${a.id}`,
      target: (a) => `nfs:${a.id}`,
      run: (c, a) => c.deleteNfsShare(a.id),
      summary: (a) => `Deleted NFS export ${a.id}.`,
    });

    // ---------------- data-protection task deletions (Phase 2) ----------------
    registerDestructive(server, config, getClient, {
      name: "truenas_delete_rsync_task",
      title: "Delete Rsync Task",
      description:
        "Delete a scheduled rsync task by id. The task definition is removed; data already synced is NOT touched. " +
        "Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ id: z.number().int().describe("Rsync task id (see truenas_list_rsync_tasks)"), response_format: responseFormat }),
      method: "rsynctask.delete",
      action: (a) => `delete rsync task ${a.id}`,
      target: (a) => `rsync:${a.id}`,
      run: (c, a) => c.deleteRsyncTask(a.id),
      summary: (a) => `Deleted rsync task ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_cloudsync_task",
      title: "Delete Cloud Sync Task",
      description:
        "Delete a cloud-sync (cloud backup) task by id. The task definition is removed; data already in the cloud " +
        "is NOT touched. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ id: z.number().int().describe("Cloud sync task id (see truenas_list_cloudsync_tasks)"), response_format: responseFormat }),
      method: "cloudsync.delete",
      action: (a) => `delete cloud sync task ${a.id}`,
      target: (a) => `cloudsync:${a.id}`,
      run: (c, a) => c.deleteCloudsyncTask(a.id),
      summary: (a) => `Deleted cloud sync task ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_replication_task",
      title: "Delete Replication Task",
      description:
        "Delete a ZFS replication task by id. The task definition is removed; snapshots already replicated are NOT " +
        "touched. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ id: z.number().int().describe("Replication task id (see truenas_list_replication_tasks)"), response_format: responseFormat }),
      method: "replication.delete",
      action: (a) => `delete replication task ${a.id}`,
      target: (a) => `replication:${a.id}`,
      run: (c, a) => c.deleteReplicationTask(a.id),
      summary: (a) => `Deleted replication task ${a.id}.`,
    });

    // ---------------- block-sharing teardown (Phase 5) ----------------
    registerDestructive(server, config, getClient, {
      name: "truenas_delete_iscsi",
      title: "Delete an iSCSI Resource",
      description:
        "Delete an iSCSI resource by type and id: target, extent, targetextent (LUN map), portal, initiator, or auth. " +
        "IRREVERSIBLE. Deleting an extent removes the LUN mapping but does NOT delete the backing zvol/file. Requires " +
        "TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        resource: z.enum(["target", "extent", "targetextent", "portal", "initiator", "auth"]).describe("Which iSCSI resource type"),
        id: z.number().int().describe("Resource id (see truenas_iscsi_overview)"),
        response_format: responseFormat,
      }),
      method: "iscsi.<resource>.delete",
      action: (a) => `delete iSCSI ${a.resource} ${a.id}`,
      target: (a) => `iscsi:${a.resource}:${a.id}`,
      run: (c, a) => c.deleteIscsi(a.resource, a.id),
      summary: (a) => `Deleted iSCSI ${a.resource} ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_nvme",
      title: "Delete an NVMe-oF Resource",
      description:
        "Delete an NVMe-oF resource by type and id: subsys, namespace, port, port_subsys, host, or host_subsys. " +
        "IRREVERSIBLE. Deleting a namespace removes it but does NOT delete the backing zvol/file. Requires " +
        "TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        resource: z.enum(["subsys", "namespace", "port", "port_subsys", "host", "host_subsys"]).describe("Which NVMe-oF resource type"),
        id: z.number().int().describe("Resource id (see truenas_nvme_overview)"),
        response_format: responseFormat,
      }),
      method: "nvmet.<resource>.delete",
      action: (a) => `delete NVMe-oF ${a.resource} ${a.id}`,
      target: (a) => `nvme:${a.resource}:${a.id}`,
      run: (c, a) => c.deleteNvme(a.resource, a.id),
      summary: (a) => `Deleted NVMe-oF ${a.resource} ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_app",
      title: "Delete App",
      description:
        "Delete an installed app. By default its persistent ix-volumes are KEPT; set remove_data=true to also " +
        "delete them (destroys app data). Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        app: z.string().describe("App name"),
        remove_data: z.boolean().default(false).describe("Also delete the app's ix-volumes (persistent data)"),
        response_format: responseFormat,
      }),
      method: "app.delete",
      action: (a) => `delete app ${a.app}${a.remove_data ? " AND its data" : ""}`,
      target: (a) => a.app,
      run: (c, a) => c.deleteApp(a.app, a.remove_data),
      summary: (a) => `Deleted app **${a.app}**${a.remove_data ? " and its data" : ""}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_vm",
      title: "Delete VM",
      description:
        "Delete a virtual machine by id. Set delete_disks=true to also destroy its zvol disks (destroys VM " +
        "data). Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        id: z.number().int().describe("VM id"),
        delete_disks: z.boolean().default(false).describe("Also delete the VM's zvol disks"),
        response_format: responseFormat,
      }),
      method: "vm.delete",
      action: (a) => `delete VM ${a.id}${a.delete_disks ? " AND its disks" : ""}`,
      target: (a) => `vm:${a.id}`,
      run: (c, a) => c.deleteVm(a.id, a.delete_disks),
      summary: (a) => `Deleted VM ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_user",
      title: "Delete User",
      description:
        "Delete a local user account by id. Its primary group is removed if unused (unless disabled). " +
        "Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        id: z.number().int().describe("User id"),
        delete_primary_group: z.boolean().default(true).describe("Delete the user's primary group if unused"),
        response_format: responseFormat,
      }),
      method: "user.delete",
      action: (a) => `delete user ${a.id}`,
      target: (a) => `user:${a.id}`,
      run: (c, a) => c.deleteUser(a.id, a.delete_primary_group),
      summary: (a) => `Deleted user ${a.id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_delete_group",
      title: "Delete Group",
      description: "Delete a local group by id. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        id: z.number().int().describe("Group id"),
        delete_users: z.boolean().default(false).describe("Also delete users whose primary group this is"),
        response_format: responseFormat,
      }),
      method: "group.delete",
      action: (a) => `delete group ${a.id}`,
      target: (a) => `group:${a.id}`,
      run: (c, a) => c.deleteGroup(a.id, a.delete_users),
      summary: (a) => `Deleted group ${a.id}.`,
    });

    // ---- D2: catastrophic (still elicitation-gated; disk.wipe/pool.create/pool.export are UI-only) ----
    registerDestructive(server, config, getClient, {
      name: "truenas_rollback_snapshot",
      title: "Roll Back to Snapshot",
      description:
        "Revert a dataset to one of its snapshots, DISCARDING all newer data and intermediate snapshots. " +
        "IRREVERSIBLE. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        snapshot: z.string().describe("Snapshot id to roll back to, e.g. 'tank/data@good'"),
        recursive: z.boolean().default(false).describe("Also roll back child datasets"),
        response_format: responseFormat,
      }),
      method: "pool.snapshot.rollback",
      action: (a) => `roll back to snapshot ${a.snapshot} (discards all newer data)`,
      target: (a) => a.snapshot,
      guardTarget: (a) => a.snapshot,
      run: (c, a) => c.rollbackSnapshot(a.snapshot, a.recursive),
      summary: (a) => `Rolled back to **${a.snapshot}** — newer data discarded.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_lock_dataset",
      title: "Lock Encrypted Dataset",
      description:
        "Lock an encrypted dataset, making its data inaccessible until unlocked with the key/passphrase. " +
        "Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        dataset: z.string().describe("Dataset id to lock"),
        force_umount: z.boolean().default(false).describe("Force-unmount before locking"),
        response_format: responseFormat,
      }),
      method: "pool.dataset.lock",
      action: (a) => `lock dataset ${a.dataset} (data becomes inaccessible)`,
      target: (a) => a.dataset,
      guardTarget: (a) => a.dataset,
      run: (c, a) => c.lockDataset(a.dataset, a.force_umount),
      summary: (a) => `Locked dataset **${a.dataset}**.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_pool_detach_disk",
      title: "Detach Disk from Pool",
      description:
        "Detach a disk/vdev from a pool by its GUID or device name, reducing redundancy. Requires " +
        "TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        pool_id: z.number().int().describe("Numeric pool id"),
        label: z.string().describe("vdev GUID or device name to detach"),
        response_format: responseFormat,
      }),
      method: "pool.detach",
      action: (a) => `detach disk ${a.label} from pool ${a.pool_id}`,
      target: (a) => `pool:${a.pool_id}/${a.label}`,
      run: (c, a) => c.detachPoolDisk(a.pool_id, a.label),
      summary: (a) => `Detached ${a.label} from pool ${a.pool_id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_pool_offline_disk",
      title: "Offline a Pool Disk",
      description:
        "Take a pool disk/vdev offline by GUID or device name, degrading redundancy (reversible by bringing it " +
        "online). Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        pool_id: z.number().int().describe("Numeric pool id"),
        label: z.string().describe("vdev GUID or device name"),
        response_format: responseFormat,
      }),
      method: "pool.offline",
      action: (a) => `offline disk ${a.label} in pool ${a.pool_id}`,
      target: (a) => `pool:${a.pool_id}/${a.label}`,
      run: (c, a) => c.offlinePoolDisk(a.pool_id, a.label),
      summary: (a) => `Took ${a.label} offline in pool ${a.pool_id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_pool_remove_vdev",
      title: "Remove a Pool vdev",
      description:
        "Remove a device/vdev from a pool by GUID or device name. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        pool_id: z.number().int().describe("Numeric pool id"),
        label: z.string().describe("vdev GUID or device name"),
        response_format: responseFormat,
      }),
      method: "pool.remove",
      action: (a) => `remove vdev ${a.label} from pool ${a.pool_id}`,
      target: (a) => `pool:${a.pool_id}/${a.label}`,
      run: (c, a) => c.removePoolVdev(a.pool_id, a.label),
      summary: (a) => `Removed ${a.label} from pool ${a.pool_id}.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_upgrade_pool",
      title: "Upgrade Pool Feature Flags",
      description:
        "Apply the latest ZFS feature flags to a pool. IRREVERSIBLE — the pool can no longer be imported by " +
        "older TrueNAS/ZFS versions afterward. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ pool_id: z.number().int().describe("Numeric pool id"), response_format: responseFormat }),
      method: "pool.upgrade",
      action: (a) => `upgrade feature flags on pool ${a.pool_id} (irreversible)`,
      target: (a) => `pool:${a.pool_id}`,
      run: (c, a) => c.upgradePool(a.pool_id),
      summary: (a) => `Upgraded pool ${a.pool_id} feature flags.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_reboot_system",
      title: "Reboot TrueNAS",
      description:
        "Reboot the entire TrueNAS system — interrupts ALL services and access until it comes back up. " +
        "Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        reason: z.string().default("Requested via MCP").describe("Reason (logged)"),
        response_format: responseFormat,
      }),
      method: "system.reboot",
      action: () => `REBOOT the entire TrueNAS system`,
      target: () => "system",
      run: (c, a) => c.rebootSystem(a.reason),
      summary: () => `Reboot initiated — the NAS will be offline until it comes back up.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_shutdown_system",
      title: "Shut Down TrueNAS",
      description:
        "Power off the entire TrueNAS system — it stays OFFLINE until manually powered back on. Requires " +
        "TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({
        reason: z.string().default("Requested via MCP").describe("Reason (logged)"),
        delay_seconds: z.number().int().min(0).optional().describe("Delay before powering off"),
        response_format: responseFormat,
      }),
      method: "system.shutdown",
      action: () => `SHUT DOWN the entire TrueNAS system`,
      target: () => "system",
      run: (c, a) => c.shutdownSystem(a.reason, a.delay_seconds),
      summary: () => `Shutdown initiated — the NAS will power off.`,
    });

    registerDestructive(server, config, getClient, {
      name: "truenas_apply_update",
      title: "Apply System Update",
      description:
        "Download and apply the pending TrueNAS OS update, then REBOOT into the new version. Check availability " +
        "first with truenas_check_updates. Requires TRUENAS_ENABLE_DESTRUCTIVE=1 + confirmation.",
      inputSchema: z.object({ response_format: responseFormat }),
      method: "update.run",
      action: () => `apply the pending system update and reboot`,
      target: () => "system",
      run: (c) => c.applyUpdate(),
      summary: () => `System update started — the NAS will reboot into the new version.`,
    });
  }
}
