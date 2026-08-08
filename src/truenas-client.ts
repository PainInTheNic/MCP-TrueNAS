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
    if (det.mode === "websocket") {
      return (await this.call("disk.temperatures", [[], false])) as Record<string, number | null>;
    }
    return (await this.restPost("/disk/temperatures", { names: [] })) as Record<string, number | null>;
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
      // The snapshot namespace was renamed between releases:
      // 25.04 = zfs.snapshot.query, 25.10+ = pool.snapshot.query.
      const isModern =
        det.maxVersion !== null &&
        (det.maxVersion[0] > 25 || (det.maxVersion[0] === 25 && det.maxVersion[1] >= 10));
      const method = isModern ? "pool.snapshot.query" : "zfs.snapshot.query";
      const filters = opts.dataset ? [["dataset", "=", opts.dataset]] : [];
      const options = {
        limit: opts.limit,
        offset: opts.offset,
        extra: { properties: SNAPSHOT_PROPERTIES },
      };
      return (await this.call(method, [filters, options])) as unknown[];
    }
    const params: Record<string, unknown> = {
      limit: opts.limit,
      offset: opts.offset,
      "extra.properties": JSON.stringify(SNAPSHOT_PROPERTIES),
    };
    if (opts.dataset) params.dataset = opts.dataset;
    return (await this.restGet("/zfs/snapshot", params)) as unknown[];
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
