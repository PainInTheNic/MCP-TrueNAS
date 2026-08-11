/**
 * TrueNAS API client with automatic transport detection.
 *
 * TrueNAS has two API generations, and which one your box speaks depends on
 * its version:
 *
 *   - 25.04 "Fangtooth" and newer: JSON-RPC 2.0 over WebSocket at
 *     wss://HOST/api/current  (REST is deprecated there, and REMOVED in
 *     TrueNAS 26).
 *   - Older SCALE (<= 24.10) and CORE 13.x: REST v2.0 at https://HOST/api/v2.0
 *     with an  Authorization: Bearer <key>  header.
 *
 * Detection trick: `GET https://HOST/api/versions` requires no auth and only
 * exists on 25.04+. A JSON array in the response means "speak WebSocket";
 * anything else means "fall back to REST". The result is cached for the life
 * of the process.
 */

import https from "node:https";
import axios, { AxiosInstance } from "axios";
import WebSocket from "ws";

export interface TrueNasConfig {
  /** Base URL of the TrueNAS web UI, e.g. https://192.168.1.50 */
  url: string;
  /** User-linked API key, format "<id>-<secret>" */
  apiKey: string;
  /** Only needed for auth.login_ex (TrueNAS 27+, where login_with_api_key is removed) */
  username?: string;
  skipTlsVerify: boolean;
  allowHttp: boolean;
  /** Register safe (reversible) write tools. Off unless TRUENAS_ENABLE_WRITE=1. */
  enableWrite: boolean;
  /** Register destructive tools (delete/rollback/reboot/...). Off unless TRUENAS_ENABLE_DESTRUCTIVE=1. */
  enableDestructive: boolean;
  /** Test-safety guard: when set, write tools refuse any target outside this dataset and its children. */
  testDataset?: string;
}

export type ApiMode = "websocket" | "rest";

export interface Detection {
  mode: ApiMode;
  /** Versions from /api/versions (WebSocket mode only), e.g. ["v25.04.2","v25.10.0"] */
  apiVersions: string[];
  /** Highest [major, minor] parsed from apiVersions, e.g. [25, 10] */
  maxVersion: [number, number] | null;
}

/** An error whose message is already safe and actionable to show to the model. */
export class TrueNasError extends Error {}

/** Result of a possibly-async (job) mutation. */
export interface JobOutcome {
  /** Job id when the method ran as a job, else null. */
  jobId: number | null;
  /** WAITING | RUNNING | SUCCESS | FAILED | ABORTED (RUNNING if the wait timed out). */
  state: string;
  error: string | null;
  result: unknown;
}

/** Typed options for rsynctask.create / rsynctask.update (assembled in rsyncPayload). */
export interface RsyncTaskOptions {
  path?: string;
  user?: string;
  direction?: "PUSH" | "PULL";
  mode?: "MODULE" | "SSH";
  remotehost?: string;
  remoteport?: number;
  remotemodule?: string;
  remotepath?: string;
  ssh_credentials?: number;
  desc?: string;
  recursive?: boolean;
  compress?: boolean;
  archive?: boolean;
  times?: boolean;
  delete?: boolean;
  preserveperm?: boolean;
  preserveattr?: boolean;
  extra?: string[];
  enabled?: boolean;
  schedule?: Record<string, string>;
}

/** Typed options for vm.create / vm.update (assembled in vmPayload). */
export interface VmOptions {
  name?: string;
  description?: string;
  vcpus?: number;
  cores?: number;
  threads?: number;
  memory?: number;
  min_memory?: number;
  autostart?: boolean;
  bootloader?: "UEFI" | "UEFI_CSM";
  shutdown_timeout?: number;
  time?: "LOCAL" | "UTC";
  cpu_mode?: "CUSTOM" | "HOST-MODEL" | "HOST-PASSTHROUGH";
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: { reason?: string; errname?: string }
  ) {
    super(message);
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const CALL_TIMEOUT_MS = 30_000;

/** ZFS properties we ask for on dataset queries — a short list keeps payloads small. */
const DATASET_PROPERTIES = [
  "used",
  "available",
  "usedbysnapshots",
  "quota",
  "refquota",
  "compression",
  "compressratio",
  "readonly",
];

const SNAPSHOT_PROPERTIES = ["creation", "used", "referenced"];

export class TrueNasClient {
  private readonly http: AxiosInstance;
  /** Normalized origin, e.g. "https://192.168.1.50" — always from a parsed URL. */
  private readonly baseUrl: string;
  /** WebSocket origin derived from the parsed protocol, e.g. "wss://192.168.1.50". */
  private readonly wsBase: string;
  private detection: Detection | null = null;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  /** Cached snapshot-query method name once feature-detected at runtime. */
  private snapshotMethod: string | null = null;

  constructor(private readonly cfg: TrueNasConfig) {
    if (!cfg.url) {
      throw new TrueNasError(
        "TRUENAS_URL is not set. Add it to the .env file next to package.json, e.g. TRUENAS_URL=https://192.168.1.50"
      );
    }
    // Parse instead of string-matching: URL schemes are case-insensitive
    // ("HTTP://host" is plain http), and a scheme-less value should become
    // https rather than failing deep inside axios with a cryptic error.
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cfg.url) ? cfg.url : `https://${cfg.url}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      throw new TrueNasError("TRUENAS_URL is not a valid URL — use e.g. https://192.168.1.50");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new TrueNasError("TRUENAS_URL must be an http(s) URL, e.g. https://192.168.1.50");
    }
    if (parsed.protocol === "http:" && !cfg.allowHttp) {
      throw new TrueNasError(
        "TRUENAS_URL uses plain http:// — refusing to continue, because TrueNAS 25.04+ automatically " +
          "REVOKES API keys that are sent over unencrypted HTTP. Use https:// (with TRUENAS_SKIP_TLS_VERIFY=1 " +
          "if the NAS has a self-signed certificate), or set TRUENAS_ALLOW_HTTP=1 to accept the risk."
      );
    }
    if (!cfg.apiKey) {
      throw new TrueNasError(
        "TRUENAS_API_KEY is not set. Create a key in the TrueNAS UI (user icon, top right -> My API Keys -> Add) " +
          "and put it in the .env file."
      );
    }
    this.baseUrl = parsed.origin;
    this.wsBase = (parsed.protocol === "https:" ? "wss://" : "ws://") + parsed.host;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: CALL_TIMEOUT_MS,
      httpsAgent: new https.Agent({ rejectUnauthorized: !cfg.skipTlsVerify }),
    });
  }

  // ------------------------------------------------------------------
  // Transport detection
  // ------------------------------------------------------------------

  async detect(): Promise<Detection> {
    if (this.detection) return this.detection;

    const versions = await this.http
      .get("/api/versions", { validateStatus: () => true })
      .catch((error) => {
        throw this.friendly(error);
      });

    if (versions.status === 200 && Array.isArray(versions.data)) {
      const list = versions.data.filter((v): v is string => typeof v === "string");
      this.detection = { mode: "websocket", apiVersions: list, maxVersion: maxApiVersion(list) };
      return this.detection;
    }

    // No JSON-RPC endpoint — an older SCALE or CORE box. Confirm REST answers.
    const rest = await this.http
      .get("/api/v2.0/system/info", { headers: this.restHeaders(), validateStatus: () => true })
      .catch((error) => {
        throw this.friendly(error);
      });

    if (rest.status === 200) {
      this.detection = { mode: "rest", apiVersions: [], maxVersion: null };
      return this.detection;
    }
    if (rest.status === 401 || rest.status === 403) {
      throw new TrueNasError(
        `TrueNAS rejected the API key (HTTP ${rest.status}). Check TRUENAS_API_KEY — copy the entire ` +
          `"<id>-<secret>" string shown when the key was created (it is only displayed once).`
      );
    }
    throw new TrueNasError(
      `${this.baseUrl} does not answer like a TrueNAS box (no /api/versions endpoint, and /api/v2.0 ` +
        `returned HTTP ${rest.status}). Double-check TRUENAS_URL.`
    );
  }

  getDetection(): Detection | null {
    return this.detection;
  }

  // ------------------------------------------------------------------
  // WebSocket JSON-RPC transport (TrueNAS 25.04+)
  // ------------------------------------------------------------------

  private wsUrl(): string {
    return this.wsBase + "/api/current";
  }

  private ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.connect().catch((error) => {
        this.connectPromise = null;
        throw this.friendly(error);
      });
    }
    return this.connectPromise;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl(), {
        rejectUnauthorized: !this.cfg.skipTlsVerify,
        handshakeTimeout: 15_000,
      });
      this.ws = socket;
      socket.on("message", (raw) => this.onMessage(String(raw)));
      socket.on("close", () => {
        // A superseded socket's teardown must never touch current state.
        if (this.ws !== socket) return;
        // Auth is per-connection, so a drop invalidates everything; the next
        // call will reconnect and log in again.
        this.connectPromise = null;
        this.ws = null;
        this.failAllPending(
          new TrueNasError("The WebSocket connection to TrueNAS closed; it will reconnect on the next call.")
        );
      });
      socket.on("error", (error) => reject(error));
      socket.on("open", () => {
        // On login failure, tear the socket down — otherwise every failed
        // attempt would leak a live connection to the NAS.
        this.login().then(resolve, (error) => {
          socket.terminate();
          reject(error);
        });
      });
    });
  }

  /**
   * Log in on the freshly opened connection. Auth is session state on the
   * socket: one login, then every later call on this connection is authorized.
   */
  private async login(): Promise<void> {
    try {
      const ok = await this.rawCall("auth.login_with_api_key", [this.cfg.apiKey]);
      if (ok !== true) {
        throw new TrueNasError(
          "TrueNAS rejected the API key. Check TRUENAS_API_KEY — copy the entire \"<id>-<secret>\" string " +
            "shown at creation, and make sure the key has not been revoked (keys sent over plain HTTP are auto-revoked)."
        );
      }
    } catch (error) {
      // TrueNAS 27+ removes auth.login_with_api_key (-32601 method not found);
      // the replacement auth.login_ex additionally needs the key's linked username.
      if (error instanceof JsonRpcError && error.code === -32601) {
        if (!this.cfg.username) {
          throw new TrueNasError(
            "This TrueNAS version requires auth.login_ex, which needs the username the API key is linked to. " +
              "Set TRUENAS_USERNAME in the .env file."
          );
        }
        const result = (await this.rawCall("auth.login_ex", [
          { mechanism: "API_KEY_PLAIN", username: this.cfg.username, api_key: this.cfg.apiKey },
        ])) as { response_type?: string };
        if (result?.response_type !== "SUCCESS") {
          throw new TrueNasError(
            `TrueNAS API-key login failed (${result?.response_type ?? "unknown"}). ` +
              "Check TRUENAS_API_KEY and TRUENAS_USERNAME."
          );
        }
        return;
      }
      throw error;
    }
  }

  /** Send one JSON-RPC request on the open socket and await its response. */
  private rawCall(method: string, params: unknown[], timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TrueNasError("WebSocket is not connected."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TrueNasError(`TrueNAS did not answer '${method}' within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(this.friendly(error));
        }
      });
    });
  }

  private onMessage(text: string): void {
    let msg: {
      id?: number | null;
      result?: unknown;
      error?: { code: number; message: string; data?: { reason?: string; errname?: string } };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id == null) return; // server-push notification (collection_update) — unused in v1
    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.error) {
      const reason = msg.error.data?.reason?.trim() || msg.error.message;
      call.reject(new JsonRpcError(msg.error.code, reason, msg.error.data));
    } else {
      call.resolve(msg.result);
    }
  }

  private failAllPending(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  /** Public JSON-RPC entry point (WebSocket mode only). */
  async call(method: string, params: unknown[] = []): Promise<unknown> {
    // ws flips readyState to CLOSING as soon as a close frame arrives but the
    // 'close' event (which resets connectPromise) can lag — force a fresh
    // connect in that window instead of failing with "not connected".
    // (CONNECTING is deliberately not reset: that's a live connect in flight.)
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)
    ) {
      this.connectPromise = null;
    }
    await this.ensureConnected();
    try {
      return await this.rawCall(method, params);
    } catch (error) {
      throw this.friendlyRpc(error, method);
    }
  }

  // ------------------------------------------------------------------
  // REST v2.0 transport (SCALE <= 24.10 and CORE 13.x)
  // ------------------------------------------------------------------

  private restHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  private async restGet(path: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      const res = await this.http.get(`/api/v2.0${path}`, { headers: this.restHeaders(), params });
      return res.data;
    } catch (error) {
      throw this.friendlyRest(error, path);
    }
  }

  private async restPost(path: string, body: unknown): Promise<unknown> {
    try {
      const res = await this.http.post(`/api/v2.0${path}`, body, { headers: this.restHeaders() });
      return res.data;
    } catch (error) {
      throw this.friendlyRest(error, path);
    }
  }

  // ------------------------------------------------------------------
  // Error translation — raw network/protocol errors become instructions
  // ------------------------------------------------------------------

  private friendly(error: unknown): Error {
    if (error instanceof TrueNasError || error instanceof JsonRpcError) return error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const tlsCodes = [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
    ];
    if (code && tlsCodes.includes(code)) {
      return new TrueNasError(
        `TLS certificate verification failed (${code}). If your NAS uses a self-signed certificate ` +
          `(the TrueNAS default), set TRUENAS_SKIP_TLS_VERIFY=1 in the .env file.`
      );
    }
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "ETIMEDOUT" ||
      code === "ECONNABORTED"
    ) {
      return new TrueNasError(
        `Cannot reach ${this.baseUrl} (${code}). Check TRUENAS_URL, that the NAS is powered on, and that ` +
          `this machine can reach it on the network.`
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private friendlyRpc(error: unknown, method: string): Error {
    if (error instanceof JsonRpcError) {
      if (error.code === -32000) {
        return new TrueNasError("TrueNAS is at its concurrent-call limit; wait a moment and retry.");
      }
      if (error.code === -32601) {
        return new TrueNasError(`This TrueNAS version does not support '${method}'.`);
      }
      return new TrueNasError(`TrueNAS error from '${method}': ${error.message}`);
    }
    return this.friendly(error);
  }

  private friendlyRest(error: unknown, path: string): Error {
    if (axios.isAxiosError(error) && error.response) {
      const { status, data } = error.response;
      if (status === 401) {
        return new TrueNasError("TrueNAS rejected the API key (HTTP 401) — check TRUENAS_API_KEY.");
      }
      if (status === 403) {
        return new TrueNasError(
          "Permission denied (HTTP 403): the API key's user lacks the role for this call, or the NAS " +
            "authentication security level blocks API keys."
        );
      }
      const message =
        typeof data === "object" && data !== null && "message" in data
          ? ` — ${String((data as { message?: unknown }).message)}`
          : "";
      return new TrueNasError(`TrueNAS REST call ${path} failed with HTTP ${status}${message}.`);
    }
    return this.friendly(error);
  }

  // ------------------------------------------------------------------
  // High-level operations — each branches on the detected transport so the
  // tools never need to care which API generation the NAS speaks.
  // ------------------------------------------------------------------

  async systemInfo(): Promise<Record<string, unknown>> {
    const det = await this.detect();
    const raw =
      det.mode === "websocket" ? await this.call("system.info") : await this.restGet("/system/info");
    return normalizeDates(raw) as Record<string, unknown>;
  }

  async pools(): Promise<unknown[]> {
    const det = await this.detect();
    const raw = det.mode === "websocket" ? await this.call("pool.query", [[], {}]) : await this.restGet("/pool");
    return (normalizeDates(raw) as unknown[]) ?? [];
  }

  async datasets(opts: { pool?: string; limit: number; offset: number }): Promise<unknown[]> {
    const det = await this.detect();
    if (det.mode === "websocket") {
      const filters = opts.pool ? [["pool", "=", opts.pool]] : [];
      const options = {
        limit: opts.limit,
        offset: opts.offset,
        extra: { flat: true, retrieve_user_props: false, properties: DATASET_PROPERTIES },
      };
      return (await this.call("pool.dataset.query", [filters, options])) as unknown[];
    }
    const params: Record<string, unknown> = {
      limit: opts.limit,
      offset: opts.offset,
      "extra.flat": "true",
      "extra.retrieve_user_props": "false",
      "extra.properties": JSON.stringify(DATASET_PROPERTIES),
    };
    if (opts.pool) params.pool = opts.pool;
    return (await this.restGet("/pool/dataset", params)) as unknown[];
  }

  async alerts(): Promise<unknown[]> {
    const det = await this.detect();
    const raw =
      det.mode === "websocket" ? await this.call("alert.list") : await this.restGet("/alert/list");
    return (normalizeDates(raw) as unknown[]) ?? [];
  }

  async disks(): Promise<unknown[]> {
    const det = await this.detect();
    if (det.mode === "websocket") {
      return (await this.call("disk.query", [[], { extra: { pools: true } }])) as unknown[];
    }
    return (await this.restGet("/disk", { "extra.pools": "true" })) as unknown[];
  }

  /** Map of disk name -> temperature in °C (server caches readings ~5 min). */
  async diskTemperatures(): Promise<Record<string, number | null>> {
    const det = await this.detect();
    // disk.temperatures wants an explicit list of names; the "empty array means
    // all disks" convention is undocumented, so fetch the names first.
    const disks = (await this.disks()) as { name?: string }[];
    const names = disks
      .map((d) => d.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.length === 0) return {};
    if (det.mode === "websocket") {
      return (await this.call("disk.temperatures", [names])) as Record<string, number | null>;
    }
    return (await this.restPost("/disk/temperatures", { names })) as Record<string, number | null>;
  }

  async services(): Promise<unknown[]> {
    const det = await this.detect();
    if (det.mode === "websocket") {
      return (await this.call("service.query", [[], {}])) as unknown[];
    }
    return (await this.restGet("/service")) as unknown[];
  }

  async jobs(opts: { state?: string; limit: number }): Promise<unknown[]> {
    const det = await this.detect();
    if (det.mode === "websocket") {
      const filters = opts.state ? [["state", "=", opts.state]] : [];
      const raw = await this.call("core.get_jobs", [filters, { order_by: ["-id"], limit: opts.limit }]);
      return (normalizeDates(raw) as unknown[]) ?? [];
    }
    const params: Record<string, unknown> = { limit: opts.limit, sort: "-id" };
    if (opts.state) params.state = opts.state;
    return (normalizeDates(await this.restGet("/core/get_jobs", params)) as unknown[]) ?? [];
  }

  async snapshots(opts: { dataset?: string; limit: number; offset: number }): Promise<unknown[]> {
    const det = await this.detect();
    if (det.mode === "websocket") {
      // The snapshot namespace was renamed between releases (25.04 =
      // zfs.snapshot.query, 25.10+ = pool.snapshot.query). Feature-detect at
      // runtime instead of guessing from a version string: try the modern name
      // first, fall back on a "method not found", and cache whichever answers.
      const filters = opts.dataset ? [["dataset", "=", opts.dataset]] : [];
      const options = {
        limit: opts.limit,
        offset: opts.offset,
        extra: { properties: SNAPSHOT_PROPERTIES },
      };
      const candidates = this.snapshotMethod
        ? [this.snapshotMethod]
        : ["pool.snapshot.query", "zfs.snapshot.query"];
      let lastError: unknown;
      for (const method of candidates) {
        try {
          const res = (await this.call(method, [filters, options])) as unknown[];
          this.snapshotMethod = method;
          return res;
        } catch (error) {
          // friendlyRpc turns JSON-RPC -32601 into a "does not support" message;
          // only then do we try the next candidate. Any other error is real.
          if (error instanceof TrueNasError && /does not support/.test(error.message)) {
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new TrueNasError("No supported snapshot query method found on this TrueNAS version.");
    }
    const params: Record<string, unknown> = {
      limit: opts.limit,
      offset: opts.offset,
      "extra.properties": JSON.stringify(SNAPSHOT_PROPERTIES),
    };
    if (opts.dataset) params.dataset = opts.dataset;
    return (await this.restGet("/zfs/snapshot", params)) as unknown[];
  }

  /**
   * Check whether a base-OS update is available.
   *
   * TrueNAS 25.04+ (WebSocket): update.status takes no params and returns
   *   { code, status: { current_version, new_version | null }, error }
   * where new_version === null means "up to date". (The older
   * update.check_available / update.get_pending were REMOVED — they 404 now,
   * which is why the earlier system.info hack silently always said "up to date".)
   * We additionally query system.reboot.info so the tool can report whether a
   * previously-applied change is still waiting on a reboot.
   */
  async updateCheck(): Promise<{
    available: boolean;
    current_version: string | null;
    train: string | null;
    new_version: string | null;
    release_notes_url: string | null;
    reboot_required: boolean | null;
    reboot_reasons: string[];
    raw: unknown;
  }> {
    const det = await this.detect();
    if (det.mode === "websocket") {
      const status = (await this.call("update.status")) as {
        code?: string;
        error?: string | null;
        status?: {
          // On 25.04+ this is train/profile metadata, NOT the version number.
          current_version?: { train?: string; profile?: string } | null;
          new_version?: { version?: string; release_notes_url?: string } | null;
        } | null;
      };
      if (status?.code && status.code !== "NORMAL") {
        throw new TrueNasError(
          `TrueNAS could not determine update status (code ${status.code})${
            status.error ? `: ${status.error}` : ""
          }.`
        );
      }
      const s = status?.status ?? {};
      const train = s.current_version?.train ?? null;
      const nv = s.new_version ?? null;

      // update.status.current_version carries train/profile, not the running
      // version string — get the actual version from system.info.
      let currentVersion: string | null = null;
      try {
        const info = (await this.call("system.info")) as { version?: string };
        currentVersion = info?.version ?? null;
      } catch {
        // Non-fatal: the update answer stands even without the version label.
      }

      let rebootRequired: boolean | null = null;
      let rebootReasons: string[] = [];
      try {
        const reboot = (await this.call("system.reboot.info")) as {
          reboot_required_reasons?: { code?: string; reason?: string }[];
        };
        const reasons = reboot?.reboot_required_reasons ?? [];
        rebootRequired = reasons.length > 0;
        rebootReasons = reasons.map((r) => r.reason ?? r.code ?? "unknown");
      } catch {
        // Reboot info is a bonus; a failure here shouldn't sink the update check.
      }

      return {
        available: nv !== null,
        current_version: currentVersion,
        train,
        new_version: nv?.version ?? null,
        release_notes_url: nv?.release_notes_url ?? null,
        reboot_required: rebootRequired,
        reboot_reasons: rebootReasons,
        raw: status,
      };
    }
    // Legacy REST (SCALE <= 24.10 / CORE 13.x). This shape is version-dependent
    // and not verified against a live legacy box, so treat it as best-effort.
    const raw = (await this.restGet("/update/check_available")) as {
      status?: string;
      version?: string;
    };
    return {
      available: raw?.status === "AVAILABLE",
      current_version: null,
      train: null,
      new_version: raw?.version ?? null,
      release_notes_url: null,
      reboot_required: null,
      reboot_reasons: [],
      raw,
    };
  }

  // ------------------------------------------------------------------
  // v2 capabilities (apps, backups, shares, network, ...). These use the
  // JSON-RPC API only: the legacy REST transport is deprecated (removed in
  // TrueNAS 26) and unverified against a real legacy box, so rather than ship
  // untested REST paths we surface a clear "needs 25.04+" error there.
  // ------------------------------------------------------------------

  private async wsOnly<T>(feature: string, fn: () => Promise<T>): Promise<T> {
    const det = await this.detect();
    if (det.mode !== "websocket") {
      throw new TrueNasError(
        `The ${feature} data requires the TrueNAS WebSocket API (25.04+); the legacy REST API is not supported for it.`
      );
    }
    return fn();
  }

  /** Installed apps, including per-app upgrade availability. */
  async apps(): Promise<unknown[]> {
    return this.wsOnly("apps", async () => ((await this.call("app.query", [[], {}])) as unknown[]) ?? []);
  }

  async replicationTasks(): Promise<unknown[]> {
    return this.wsOnly(
      "replication task",
      async () => (normalizeDates(await this.call("replication.query", [[], {}])) as unknown[]) ?? []
    );
  }

  async cloudsyncTasks(): Promise<unknown[]> {
    return this.wsOnly(
      "cloud sync task",
      async () => (normalizeDates(await this.call("cloudsync.query", [[], {}])) as unknown[]) ?? []
    );
  }

  async rsyncTasks(): Promise<unknown[]> {
    return this.wsOnly(
      "rsync task",
      async () => (normalizeDates(await this.call("rsynctask.query", [[], {}])) as unknown[]) ?? []
    );
  }

  async smbShares(): Promise<unknown[]> {
    return this.wsOnly("SMB share", async () => ((await this.call("sharing.smb.query", [[], {}])) as unknown[]) ?? []);
  }

  async nfsShares(): Promise<unknown[]> {
    return this.wsOnly("NFS share", async () => ((await this.call("sharing.nfs.query", [[], {}])) as unknown[]) ?? []);
  }

  async iscsiTargets(): Promise<unknown[]> {
    return this.wsOnly(
      "iSCSI target",
      async () => ((await this.call("iscsi.target.query", [[], {}])) as unknown[]) ?? []
    );
  }

  async interfaces(): Promise<unknown[]> {
    return this.wsOnly(
      "network interface",
      async () => ((await this.call("interface.query", [[], {}])) as unknown[]) ?? []
    );
  }

  async networkSummary(): Promise<Record<string, unknown>> {
    return this.wsOnly(
      "network summary",
      async () => (await this.call("network.general.summary")) as Record<string, unknown>
    );
  }

  async snapshotTasks(): Promise<unknown[]> {
    return this.wsOnly(
      "snapshot task",
      async () => (normalizeDates(await this.call("pool.snapshottask.query", [[], {}])) as unknown[]) ?? []
    );
  }

  async scrubTasks(): Promise<unknown[]> {
    return this.wsOnly("scrub task", async () => ((await this.call("pool.scrub.query", [[], {}])) as unknown[]) ?? []);
  }

  async dockerStatus(): Promise<Record<string, unknown>> {
    return this.wsOnly("Docker status", async () => (await this.call("docker.status")) as Record<string, unknown>);
  }

  async vms(): Promise<unknown[]> {
    return this.wsOnly("virtual machine", async () => (normalizeDates(await this.call("vm.query", [[], {}])) as unknown[]) ?? []);
  }

  // ------------------------------------------------------------------
  // Phase 1 config & inventory reads (WebSocket-only). Secret stripping
  // happens in the tool projections, not here.
  // ------------------------------------------------------------------

  async systemGeneralConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("system config", async () => (await this.call("system.general.config")) as Record<string, unknown>);
  }
  async systemAdvancedConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("advanced config", async () => (await this.call("system.advanced.config")) as Record<string, unknown>);
  }
  async systemSecurityConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("security config", async () => (await this.call("system.security.config")) as Record<string, unknown>);
  }
  async systemDatasetConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("system dataset config", async () => (await this.call("systemdataset.config")) as Record<string, unknown>);
  }
  async systemState(): Promise<unknown> {
    return this.wsOnly("system state", () => this.call("system.state"));
  }
  async ntpServers(): Promise<unknown[]> {
    return this.wsOnly("NTP servers", async () => ((await this.call("system.ntpserver.query", [[], {}])) as unknown[]) ?? []);
  }
  async initScripts(): Promise<unknown[]> {
    return this.wsOnly("init/shutdown scripts", async () => ((await this.call("initshutdownscript.query", [[], {}])) as unknown[]) ?? []);
  }
  async cronJobs(): Promise<unknown[]> {
    return this.wsOnly("cron jobs", async () => ((await this.call("cronjob.query", [[], {}])) as unknown[]) ?? []);
  }
  async tunables(): Promise<unknown[]> {
    return this.wsOnly("tunables", async () => ((await this.call("tunable.query", [[], {}])) as unknown[]) ?? []);
  }
  async mailConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("mail config", async () => (await this.call("mail.config")) as Record<string, unknown>);
  }
  async alertServices(): Promise<unknown[]> {
    return this.wsOnly("alert services", async () => ((await this.call("alertservice.query", [[], {}])) as unknown[]) ?? []);
  }
  async alertClasses(): Promise<Record<string, unknown>> {
    return this.wsOnly("alert classes", async () => (await this.call("alertclasses.config")) as Record<string, unknown>);
  }
  async bootState(): Promise<Record<string, unknown>> {
    return this.wsOnly("boot state", async () => (normalizeDates(await this.call("boot.get_state")) as Record<string, unknown>) ?? {});
  }
  async bootEnvironments(): Promise<unknown[]> {
    return this.wsOnly("boot environments", async () => (normalizeDates(await this.call("boot.environment.query", [[], {}])) as unknown[]) ?? []);
  }
  async networkConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("network config", async () => (await this.call("network.configuration.config")) as Record<string, unknown>);
  }
  async staticRoutes(): Promise<unknown[]> {
    return this.wsOnly("static routes", async () => ((await this.call("staticroute.query", [[], {}])) as unknown[]) ?? []);
  }
  async sshConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("SSH config", async () => (await this.call("ssh.config")) as Record<string, unknown>);
  }
  async snmpConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("SNMP config", async () => (await this.call("snmp.config")) as Record<string, unknown>);
  }
  async upsConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("UPS config", async () => (await this.call("ups.config")) as Record<string, unknown>);
  }

  async certificates(): Promise<unknown[]> {
    return this.wsOnly("certificates", async () => ((await this.call("certificate.query", [[], {}])) as unknown[]) ?? []);
  }
  async apiKeys(): Promise<unknown[]> {
    return this.wsOnly("API keys", async () => (normalizeDates(await this.call("api_key.query", [[], {}])) as unknown[]) ?? []);
  }
  async authMe(): Promise<Record<string, unknown>> {
    return this.wsOnly("current identity", async () => (await this.call("auth.me")) as Record<string, unknown>);
  }
  async authSessions(): Promise<unknown[]> {
    return this.wsOnly("sessions", async () => (normalizeDates(await this.call("auth.sessions", [[], {}])) as unknown[]) ?? []);
  }
  async privileges(): Promise<unknown[]> {
    return this.wsOnly("privileges", async () => ((await this.call("privilege.query", [[], {}])) as unknown[]) ?? []);
  }
  async privilegeRoles(): Promise<unknown[]> {
    return this.wsOnly("roles", async () => ((await this.call("privilege.roles", [[], {}])) as unknown[]) ?? []);
  }
  async directoryServicesConfig(): Promise<Record<string, unknown>> {
    return this.wsOnly("directory services", async () => (await this.call("directoryservices.config")) as Record<string, unknown>);
  }
  async directoryServicesStatus(): Promise<Record<string, unknown>> {
    return this.wsOnly("directory services status", async () => (await this.call("directoryservices.status")) as Record<string, unknown>);
  }
  async ipmiLoaded(): Promise<boolean> {
    return this.wsOnly("IPMI presence", async () => Boolean(await this.call("ipmi.is_loaded")));
  }
  async ipmiChassis(): Promise<Record<string, unknown>> {
    return this.wsOnly("IPMI chassis", async () => (await this.call("ipmi.chassis.info")) as Record<string, unknown>);
  }
  async enclosures(): Promise<unknown[]> {
    return this.wsOnly("enclosures", async () => ((await this.call("enclosure2.query", [[], {}])) as unknown[]) ?? []);
  }
  /** Tasks/shares that depend on a dataset (pool.dataset.attachments). */
  async datasetAttachments(id: string): Promise<unknown[]> {
    return this.wsOnly("dataset attachments", async () => ((await this.call("pool.dataset.attachments", [id])) as unknown[]) ?? []);
  }
  /** Running processes using a dataset (pool.dataset.processes). */
  async datasetProcesses(id: string): Promise<unknown[]> {
    return this.wsOnly("dataset processes", async () => ((await this.call("pool.dataset.processes", [id])) as unknown[]) ?? []);
  }
  async fsListdir(path: string): Promise<unknown[]> {
    return this.wsOnly("directory listing", async () => ((await this.call("filesystem.listdir", [path])) as unknown[]) ?? []);
  }
  async fsStat(path: string): Promise<Record<string, unknown>> {
    return this.wsOnly("path stat", async () => (await this.call("filesystem.stat", [path])) as Record<string, unknown>);
  }
  async fsGetacl(path: string): Promise<Record<string, unknown>> {
    return this.wsOnly("path ACL", async () => (await this.call("filesystem.getacl", [path])) as Record<string, unknown>);
  }
  /** Current disk-temperature alerts (disk.temperature_alerts needs an explicit name list). */
  async diskTempAlerts(): Promise<unknown[]> {
    return this.wsOnly("disk temperature alerts", async () => {
      const disks = (await this.disks()) as { name?: string }[];
      const names = disks.map((d) => d.name).filter((n): n is string => typeof n === "string" && n.length > 0);
      if (names.length === 0) return [];
      return ((await this.call("disk.temperature_alerts", [names])) as unknown[]) ?? [];
    });
  }

  // ------------------------------------------------------------------
  // Mutations (safe writes). WebSocket-only; gated at the tool layer by
  // TRUENAS_ENABLE_WRITE. Each returns the raw upstream result.
  // ------------------------------------------------------------------

  /** Create a ZFS snapshot (pool.snapshot.create). Returns the new snapshot info. */
  async createSnapshot(opts: {
    dataset: string;
    name: string;
    recursive?: boolean;
    properties?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.wsOnly("snapshot creation", async () =>
      this.call("pool.snapshot.create", [
        {
          dataset: opts.dataset,
          name: opts.name,
          recursive: opts.recursive ?? false,
          ...(opts.properties && Object.keys(opts.properties).length ? { properties: opts.properties } : {}),
        },
      ])
    );
  }

  /** Update ZFS dataset properties (pool.dataset.update). Returns the updated dataset. */
  async updateDataset(id: string, data: Record<string, unknown>): Promise<unknown> {
    return this.wsOnly("dataset update", async () => this.call("pool.dataset.update", [id, data]));
  }

  /**
   * Call a method and, if it runs as a TrueNAS job (the JSON-RPC call returns a
   * numeric job id), best-effort wait for it to finish by polling core.get_jobs.
   * Non-job methods (which return their actual result, not a number) resolve
   * immediately. On wait timeout the job keeps running — we return its last
   * state and id so the caller can point the user at truenas_list_jobs.
   *
   * IMPORTANT: only route genuine @job methods here. A non-job method that
   * returns an integer (e.g. service.update returns the service id) would be
   * mistaken for a job id — call those directly instead.
   */
  async callJob(method: string, params: unknown[], waitMs = 20_000): Promise<JobOutcome> {
    const submitted = await this.call(method, params);
    if (typeof submitted !== "number") {
      return { jobId: null, state: "SUCCESS", error: null, result: submitted };
    }
    const jobId = submitted;
    const deadline = Date.now() + waitMs;
    let state = "RUNNING";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      let jobs: Array<{ state?: string; error?: string | null; result?: unknown }>;
      try {
        jobs = (await this.call("core.get_jobs", [[["id", "=", jobId]], { limit: 1 }])) as typeof jobs;
      } catch {
        break; // Polling failed; report the job as still running.
      }
      const job = jobs?.[0];
      if (job?.state) state = job.state;
      if (job && (job.state === "SUCCESS" || job.state === "FAILED" || job.state === "ABORTED")) {
        return { jobId, state: job.state, error: job.error ?? null, result: job.result ?? null };
      }
    }
    return { jobId, state, error: null, result: null };
  }

  /** service.control — START/STOP/RESTART/RELOAD a service by name (runs as a job). */
  async controlService(action: "START" | "STOP" | "RESTART" | "RELOAD", service: string): Promise<JobOutcome> {
    return this.wsOnly("service control", () => this.callJob("service.control", [action, service, {}]));
  }

  /** service.update — set whether a service starts on boot (synchronous; returns the service id). */
  async setServiceBoot(service: string, enable: boolean): Promise<unknown> {
    return this.wsOnly("service update", () => this.call("service.update", [service, { enable }]));
  }

  /** app.start/stop/redeploy/upgrade/rollback — lifecycle actions on an installed app (all jobs). */
  async appAction(
    action: "start" | "stop" | "redeploy" | "upgrade" | "rollback",
    appName: string,
    appVersion?: string
  ): Promise<JobOutcome> {
    return this.wsOnly("app action", () => {
      if (action === "upgrade") {
        return this.callJob("app.upgrade", [appName, { app_version: appVersion ?? "latest" }]);
      }
      if (action === "rollback") {
        return this.callJob("app.rollback", [appName, { app_version: appVersion }]);
      }
      return this.callJob(`app.${action}`, [appName]);
    });
  }

  /** vm.start/stop/restart/suspend/resume — lifecycle actions on a VM by id. */
  async vmAction(
    action: "start" | "stop" | "restart" | "suspend" | "resume",
    id: number
  ): Promise<JobOutcome> {
    return this.wsOnly("vm action", () => this.callJob(`vm.${action}`, [id]));
  }

  /**
   * pool.scrub.run — start a manual scrub on a pool by name (synchronous).
   * Note: deprecated in TrueNAS 26 in favor of zpool.scrub.run; still valid on 25.10.
   */
  async runScrub(pool: string, threshold?: number): Promise<unknown> {
    return this.wsOnly("scrub run", () =>
      this.call("pool.scrub.run", threshold !== undefined ? [pool, threshold] : [pool])
    );
  }

  // ------------------------------------------------------------------
  // Data-protection actions (Phase 2). Manually trigger existing backup
  // tasks; each runs as a @job so we surface the final job state.
  // ------------------------------------------------------------------

  /** cloudsync.sync — trigger an existing cloud-sync (backup) task now. */
  async runCloudsyncTask(id: number): Promise<JobOutcome> {
    return this.wsOnly("cloudsync run", () => this.callJob("cloudsync.sync", [id]));
  }

  /** replication.run — trigger an existing ZFS replication task now. */
  async runReplicationTask(id: number): Promise<JobOutcome> {
    return this.wsOnly("replication run", () => this.callJob("replication.run", [id]));
  }

  /** rsynctask.run — trigger an existing rsync task now. */
  async runRsyncTask(id: number): Promise<JobOutcome> {
    return this.wsOnly("rsync run", () => this.callJob("rsynctask.run", [id]));
  }

  // ------------------------------------------------------------------
  // App & VM provisioning (Phase 3).
  // ------------------------------------------------------------------

  /** app.available — browse the catalog of installable apps. */
  async catalogApps(): Promise<unknown[]> {
    return this.wsOnly(
      "catalog",
      async () =>
        ((await this.call("app.available", [
          [],
          {
            select: [
              "name", "title", "description", "categories", "tags", "latest_version",
              "latest_human_version", "recommended", "healthy", "home", "train",
            ],
            order_by: ["title"],
          },
        ])) as unknown[]) ?? []
    );
  }

  /** app.get_instance — full detail for one installed app. */
  async appInstance(name: string): Promise<unknown> {
    return this.wsOnly("app instance", () => this.call("app.get_instance", [name]));
  }

  /** vm.device.query — devices attached to a VM. */
  async vmDevices(vmId: number): Promise<unknown[]> {
    return this.wsOnly(
      "vm devices",
      async () => ((await this.call("vm.device.query", [[["vm", "=", vmId]], {}])) as unknown[]) ?? []
    );
  }

  /** app.create — install an app from the catalog (runs as a @job). */
  async createApp(opts: {
    app_name: string;
    catalog_app: string;
    train?: string;
    version?: string;
    values?: Record<string, unknown>;
  }): Promise<JobOutcome> {
    const data: Record<string, unknown> = { app_name: opts.app_name, catalog_app: opts.catalog_app };
    if (opts.train !== undefined) data.train = opts.train;
    if (opts.version !== undefined) data.version = opts.version;
    if (opts.values !== undefined) data.values = opts.values;
    return this.wsOnly("app create", () => this.callJob("app.create", [data]));
  }

  /** app.update — change an installed app's config values (runs as a @job). */
  async updateApp(name: string, values: Record<string, unknown>): Promise<JobOutcome> {
    return this.wsOnly("app update", () => this.callJob("app.update", [name, { values }]));
  }

  // ------------------------------------------------------------------
  // Storage & encryption depth (Phase 4).
  // ------------------------------------------------------------------

  /** pool.query for a single pool by name — full topology + scan status. */
  async poolDetail(name: string): Promise<unknown> {
    return this.wsOnly("pool detail", async () => {
      const rows = normalizeDates(await this.call("pool.query", [[["name", "=", name]], {}])) as unknown[];
      return rows?.[0] ?? null;
    });
  }

  /** pool.dataset.query for a single dataset by id — full properties. */
  async datasetDetail(id: string): Promise<unknown> {
    return this.wsOnly("dataset detail", async () => {
      const rows = normalizeDates(
        await this.call("pool.dataset.query", [[["id", "=", id]], { extra: { retrieve_children: false } }])
      ) as unknown[];
      return rows?.[0] ?? null;
    });
  }

  /** pool.dataset.encryption_summary — per-dataset key/lock status (runs as a @job; non-mutating). */
  async encryptionSummary(id: string): Promise<JobOutcome> {
    return this.wsOnly("encryption summary", () => this.callJob("pool.dataset.encryption_summary", [id]));
  }

  /**
   * pool.dataset.unlock — unlock an encrypted dataset (runs as a @job).
   * The passphrase/key is passed straight to the API and is NEVER logged.
   */
  async unlockDataset(
    id: string,
    opts: { passphrase?: string; key?: string; recursive?: boolean }
  ): Promise<JobOutcome> {
    const entry: Record<string, unknown> = { name: id };
    if (opts.passphrase !== undefined) entry.passphrase = opts.passphrase;
    if (opts.key !== undefined) entry.key = opts.key;
    const options: Record<string, unknown> = { datasets: [entry] };
    if (opts.recursive !== undefined) options.recursive = opts.recursive;
    return this.wsOnly("dataset unlock", () => this.callJob("pool.dataset.unlock", [id, options]));
  }

  /**
   * pool.dataset.change_key — rotate an encrypted dataset's key/passphrase (runs as a @job).
   * The secret is passed straight to the API and is NEVER logged.
   */
  async changeDatasetKey(
    id: string,
    opts: { passphrase?: string; key?: string; generate_key?: boolean }
  ): Promise<JobOutcome> {
    const options: Record<string, unknown> = {};
    if (opts.passphrase !== undefined) options.passphrase = opts.passphrase;
    if (opts.key !== undefined) options.key = opts.key;
    if (opts.generate_key !== undefined) options.generate_key = opts.generate_key;
    return this.wsOnly("dataset change key", () => this.callJob("pool.dataset.change_key", [id, options]));
  }

  // ------------------------------------------------------------------
  // Provisioning (create/update). All WebSocket-only and synchronous. The
  // typed option objects are assembled into the API payload HERE (not in the
  // tool handlers) so the exact params are unit-testable.
  // ------------------------------------------------------------------

  private provision(method: string, params: unknown[]): Promise<unknown> {
    return this.wsOnly(method, () => this.call(method, params));
  }

  async createDataset(opts: {
    name: string;
    type?: "FILESYSTEM" | "VOLUME";
    volsize?: number;
    comments?: string;
    compression?: string;
    create_ancestors?: boolean;
  }): Promise<unknown> {
    const data: Record<string, unknown> = { name: opts.name, type: opts.type ?? "FILESYSTEM" };
    if (opts.volsize !== undefined) data.volsize = opts.volsize;
    if (opts.comments !== undefined) data.comments = opts.comments;
    if (opts.compression !== undefined) data.compression = opts.compression;
    if (opts.create_ancestors !== undefined) data.create_ancestors = opts.create_ancestors;
    return this.provision("pool.dataset.create", [data]);
  }

  async renameDataset(id: string, newName: string, recursive?: boolean): Promise<unknown> {
    const data: Record<string, unknown> = { new_name: newName };
    if (recursive !== undefined) data.recursive = recursive;
    return this.provision("pool.dataset.rename", [id, data]);
  }

  /** vm.create — create a virtual machine shell (add devices separately in the UI/API). */
  async createVm(opts: VmOptions): Promise<unknown> {
    return this.provision("vm.create", [this.vmPayload(opts)]);
  }

  /** vm.update — change an existing VM's config. */
  async updateVm(id: number, opts: VmOptions): Promise<unknown> {
    return this.provision("vm.update", [id, this.vmPayload(opts)]);
  }

  /** Assemble a vm.create / vm.update payload from typed options. */
  private vmPayload(opts: VmOptions): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const copy: (keyof VmOptions)[] = [
      "name", "description", "vcpus", "cores", "threads", "memory", "min_memory",
      "autostart", "bootloader", "shutdown_timeout", "time", "cpu_mode",
    ];
    for (const k of copy) if (opts[k] !== undefined) data[k] = opts[k];
    return data;
  }

  /** pool.dataset.promote — make a clone independent of its origin snapshot. */
  async promoteDataset(id: string): Promise<unknown> {
    return this.provision("pool.dataset.promote", [id]);
  }

  /** pool.snapshot.hold — protect a snapshot from deletion. */
  async holdSnapshot(id: string): Promise<unknown> {
    return this.provision("pool.snapshot.hold", [id]);
  }

  /** pool.snapshot.release — remove a hold, allowing the snapshot to be deleted again. */
  async releaseSnapshot(id: string): Promise<unknown> {
    return this.provision("pool.snapshot.release", [id]);
  }

  async createSmbShare(opts: {
    path: string;
    name: string;
    comment?: string;
    enabled?: boolean;
    readonly?: boolean;
    browsable?: boolean;
    purpose?: string;
  }): Promise<unknown> {
    const data: Record<string, unknown> = { path: opts.path, name: opts.name };
    if (opts.comment !== undefined) data.comment = opts.comment;
    if (opts.enabled !== undefined) data.enabled = opts.enabled;
    if (opts.readonly !== undefined) data.readonly = opts.readonly;
    if (opts.browsable !== undefined) data.browsable = opts.browsable;
    if (opts.purpose !== undefined) data.purpose = opts.purpose;
    return this.provision("sharing.smb.create", [data]);
  }

  async updateSmbShare(id: number, data: Record<string, unknown>): Promise<unknown> {
    return this.provision("sharing.smb.update", [id, data]);
  }

  async createNfsShare(opts: {
    path: string;
    comment?: string;
    networks?: string[];
    hosts?: string[];
    ro?: boolean;
    enabled?: boolean;
  }): Promise<unknown> {
    const data: Record<string, unknown> = { path: opts.path };
    if (opts.comment !== undefined) data.comment = opts.comment;
    if (opts.networks !== undefined) data.networks = opts.networks;
    if (opts.hosts !== undefined) data.hosts = opts.hosts;
    if (opts.ro !== undefined) data.ro = opts.ro;
    if (opts.enabled !== undefined) data.enabled = opts.enabled;
    return this.provision("sharing.nfs.create", [data]);
  }

  async updateNfsShare(id: number, data: Record<string, unknown>): Promise<unknown> {
    return this.provision("sharing.nfs.update", [id, data]);
  }

  async createUser(opts: {
    username: string;
    full_name: string;
    password?: string;
    password_disabled?: boolean;
    group?: number;
    group_create?: boolean;
    shell?: string;
    home?: string;
    smb?: boolean;
    groups?: number[];
  }): Promise<unknown> {
    const data: Record<string, unknown> = { username: opts.username, full_name: opts.full_name };
    if (opts.password !== undefined) data.password = opts.password;
    if (opts.password_disabled !== undefined) data.password_disabled = opts.password_disabled;
    if (opts.group !== undefined) data.group = opts.group;
    if (opts.group_create !== undefined) data.group_create = opts.group_create;
    if (opts.shell !== undefined) data.shell = opts.shell;
    if (opts.home !== undefined) data.home = opts.home;
    if (opts.smb !== undefined) data.smb = opts.smb;
    if (opts.groups !== undefined) data.groups = opts.groups;
    return this.provision("user.create", [data]);
  }

  async updateUser(id: number, data: Record<string, unknown>): Promise<unknown> {
    return this.provision("user.update", [id, data]);
  }

  /** user.set_password — username-keyed (NOT id). new_password is a secret. */
  async setUserPassword(username: string, newPassword: string): Promise<unknown> {
    return this.provision("user.set_password", [{ username, new_password: newPassword }]);
  }

  async createGroup(opts: { name: string; gid?: number; smb?: boolean }): Promise<unknown> {
    const data: Record<string, unknown> = { name: opts.name };
    if (opts.gid !== undefined) data.gid = opts.gid;
    if (opts.smb !== undefined) data.smb = opts.smb;
    return this.provision("group.create", [data]);
  }

  async updateGroup(id: number, data: Record<string, unknown>): Promise<unknown> {
    return this.provision("group.update", [id, data]);
  }

  async createSnapshotTask(opts: {
    dataset: string;
    recursive?: boolean;
    lifetime_value?: number;
    lifetime_unit?: string;
    naming_schema?: string;
    enabled?: boolean;
    schedule?: Record<string, string>;
  }): Promise<unknown> {
    const data: Record<string, unknown> = { dataset: opts.dataset };
    if (opts.recursive !== undefined) data.recursive = opts.recursive;
    if (opts.lifetime_value !== undefined) data.lifetime_value = opts.lifetime_value;
    if (opts.lifetime_unit !== undefined) data.lifetime_unit = opts.lifetime_unit;
    if (opts.naming_schema !== undefined) data.naming_schema = opts.naming_schema;
    if (opts.enabled !== undefined) data.enabled = opts.enabled;
    if (opts.schedule !== undefined) data.schedule = opts.schedule;
    return this.provision("pool.snapshottask.create", [data]);
  }

  async updateSnapshotTask(id: number, data: Record<string, unknown>): Promise<unknown> {
    return this.provision("pool.snapshottask.update", [id, data]);
  }

  async createScrubTask(opts: {
    pool: number;
    threshold?: number;
    enabled?: boolean;
    description?: string;
    schedule?: Record<string, string>;
  }): Promise<unknown> {
    const data: Record<string, unknown> = { pool: opts.pool };
    if (opts.threshold !== undefined) data.threshold = opts.threshold;
    if (opts.enabled !== undefined) data.enabled = opts.enabled;
    if (opts.description !== undefined) data.description = opts.description;
    if (opts.schedule !== undefined) data.schedule = opts.schedule;
    return this.provision("pool.scrub.create", [data]);
  }

  async updateScrubTask(id: number, data: Record<string, unknown>): Promise<unknown> {
    return this.provision("pool.scrub.update", [id, data]);
  }

  /** pool.snapshot.clone — clone a snapshot into a NEW dataset (non-destructive; the source is untouched). */
  async cloneSnapshot(snapshot: string, datasetDst: string): Promise<unknown> {
    return this.provision("pool.snapshot.clone", [{ snapshot, dataset_dst: datasetDst }]);
  }

  /** Assemble an rsync-task payload from typed options (shared by create/update). */
  private rsyncPayload(opts: RsyncTaskOptions): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const copy: (keyof RsyncTaskOptions)[] = [
      "path", "user", "direction", "mode", "remotehost", "remoteport", "remotemodule",
      "remotepath", "ssh_credentials", "desc", "recursive", "compress", "archive",
      "times", "delete", "preserveperm", "preserveattr", "extra", "enabled", "schedule",
    ];
    for (const k of copy) if (opts[k] !== undefined) data[k] = opts[k];
    return data;
  }

  async createRsyncTask(opts: RsyncTaskOptions): Promise<unknown> {
    return this.provision("rsynctask.create", [this.rsyncPayload(opts)]);
  }

  async updateRsyncTask(id: number, opts: RsyncTaskOptions): Promise<unknown> {
    return this.provision("rsynctask.update", [id, this.rsyncPayload(opts)]);
  }

  // ------------------------------------------------------------------
  // Destructive operations. WebSocket-only; gated at the tool layer by
  // TRUENAS_ENABLE_DESTRUCTIVE + a human elicitation confirmation.
  // ------------------------------------------------------------------

  async deleteSnapshot(id: string, recursive?: boolean): Promise<unknown> {
    return this.provision("pool.snapshot.delete", recursive !== undefined ? [id, { recursive }] : [id]);
  }

  async deleteDataset(id: string, recursive?: boolean, force?: boolean): Promise<unknown> {
    const options: Record<string, unknown> = {};
    if (recursive !== undefined) options.recursive = recursive;
    if (force !== undefined) options.force = force;
    return this.provision("pool.dataset.delete", Object.keys(options).length ? [id, options] : [id]);
  }

  async deleteSmbShare(id: number): Promise<unknown> {
    return this.provision("sharing.smb.delete", [id]);
  }

  async deleteNfsShare(id: number): Promise<unknown> {
    return this.provision("sharing.nfs.delete", [id]);
  }

  async deleteApp(appName: string, removeIxVolumes?: boolean): Promise<JobOutcome> {
    return this.wsOnly("app delete", () =>
      this.callJob("app.delete", removeIxVolumes !== undefined ? [appName, { remove_ix_volumes: removeIxVolumes }] : [appName])
    );
  }

  async deleteVm(id: number, deleteZvols?: boolean): Promise<unknown> {
    return this.provision("vm.delete", deleteZvols !== undefined ? [id, { zvols: deleteZvols }] : [id]);
  }

  async deleteUser(id: number, deleteGroup?: boolean): Promise<unknown> {
    return this.provision("user.delete", deleteGroup !== undefined ? [id, { delete_group: deleteGroup }] : [id]);
  }

  async deleteGroup(id: number, deleteUsers?: boolean): Promise<unknown> {
    return this.provision("group.delete", deleteUsers !== undefined ? [id, { delete_users: deleteUsers }] : [id]);
  }

  async deleteRsyncTask(id: number): Promise<unknown> {
    return this.provision("rsynctask.delete", [id]);
  }

  async deleteCloudsyncTask(id: number): Promise<unknown> {
    return this.provision("cloudsync.delete", [id]);
  }

  async deleteReplicationTask(id: number): Promise<unknown> {
    return this.provision("replication.delete", [id]);
  }

  /** pool.snapshot.rollback — revert a dataset to a snapshot (destroys newer data). */
  async rollbackSnapshot(id: string, recursive?: boolean): Promise<unknown> {
    return this.provision("pool.snapshot.rollback", [id, recursive !== undefined ? { recursive } : {}]);
  }

  async lockDataset(id: string, forceUmount?: boolean): Promise<JobOutcome> {
    return this.wsOnly("dataset lock", () =>
      this.callJob("pool.dataset.lock", [id, forceUmount !== undefined ? { force_umount: forceUmount } : {}])
    );
  }

  async detachPoolDisk(poolId: number, label: string): Promise<unknown> {
    return this.provision("pool.detach", [poolId, { label }]);
  }

  async offlinePoolDisk(poolId: number, label: string): Promise<unknown> {
    return this.provision("pool.offline", [poolId, { label }]);
  }

  async removePoolVdev(poolId: number, label: string): Promise<JobOutcome> {
    return this.wsOnly("pool remove", () => this.callJob("pool.remove", [poolId, { label }]));
  }

  async upgradePool(poolId: number): Promise<unknown> {
    return this.provision("pool.upgrade", [poolId]);
  }

  async rebootSystem(reason: string): Promise<unknown> {
    // system.reboot's exact signature is undocumented on v25.10; mirror system.shutdown(reason, {}).
    return this.provision("system.reboot", [reason, {}]);
  }

  async shutdownSystem(reason: string, delay?: number): Promise<JobOutcome> {
    return this.wsOnly("system shutdown", () =>
      this.callJob("system.shutdown", [reason, delay !== undefined ? { delay } : {}])
    );
  }

  async applyUpdate(): Promise<JobOutcome> {
    return this.wsOnly("update run", () => this.callJob("update.run", [{}]));
  }

  /** Close the WebSocket connection and fail any in-flight calls (shutdown). */
  close(): void {
    this.failAllPending(new TrueNasError("The client is shutting down."));
    const sock = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (sock) {
      try {
        sock.terminate();
      } catch {
        // Best-effort teardown.
      }
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function maxApiVersion(versions: string[]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const v of versions) {
    const m = /^v(\d+)\.(\d+)/.exec(v);
    if (!m) continue;
    const cur: [number, number] = [Number(m[1]), Number(m[2])];
    if (!best || cur[0] > best[0] || (cur[0] === best[0] && cur[1] > best[1])) best = cur;
  }
  return best;
}

/** TrueNAS serializes datetimes as {"$date": <epoch ms>} — convert to ISO strings, recursively. */
export function normalizeDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$date === "number" && Object.keys(obj).length === 1) {
      return new Date(obj.$date).toISOString();
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) out[key] = normalizeDates(val);
    return out;
  }
  return value;
}
