#!/usr/bin/env node
/**
 * MCP-TrueNAS — lets Claude (or any MCP client) manage a TrueNAS box.
 *
 * How it fits together:
 *   Claude Code ── stdio (JSON-RPC) ──> this process ── HTTPS/WSS ──> TrueNAS
 *
 *   index.ts          — bootstrap: config, server object, stdio transport
 *   truenas-client.ts — talks to TrueNAS (auto-detects WebSocket vs REST API)
 *   tools.ts          — the tools Claude sees; add new capabilities there
 *
 * IMPORTANT: stdout belongs to the MCP protocol. Never console.log in this
 * process — use console.error, which goes to stderr and into client logs.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { TrueNasClient, TrueNasConfig } from "./truenas-client.js";
import { registerTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Configuration — read from a .env file next to package.json, or from env
// vars supplied by the MCP client. The API key never appears in source code.
// ---------------------------------------------------------------------------
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch {
  // No .env file — fine when the MCP client supplies env vars itself.
}

const config: TrueNasConfig = {
  url: (process.env.TRUENAS_URL ?? "").replace(/\/+$/, ""),
  apiKey: process.env.TRUENAS_API_KEY ?? "",
  username: process.env.TRUENAS_USERNAME || undefined,
  skipTlsVerify: process.env.TRUENAS_SKIP_TLS_VERIFY === "1",
  allowHttp: process.env.TRUENAS_ALLOW_HTTP === "1",
};

// The client is created lazily so the server always starts and lists its
// tools, even when configuration is missing — tools then return helpful
// errors instead of the whole server failing to boot.
let client: TrueNasClient | null = null;
function getClient(): TrueNasClient {
  if (!client) client = new TrueNasClient(config);
  return client;
}

const server = new McpServer({
  name: "mcp-truenas",
  version: "0.1.0",
});

registerTools(server, { config, getClient });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-truenas running on stdio");

  // Clean shutdown: close the MCP transport and the upstream TrueNAS WebSocket
  // instead of leaking the authenticated connection on exit.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`mcp-truenas received ${signal}, shutting down`);
    try {
      client?.close();
    } catch {
      // best-effort
    }
    void Promise.resolve(server.close?.()).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Last-resort safety net so a stray rejection/exception is logged to stderr
  // (never stdout — that would corrupt the protocol stream) rather than
  // crashing silently.
  process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));
  process.on("uncaughtException", (error) => console.error("Uncaught exception:", error));
}

main().catch((error: unknown) => {
  console.error("Fatal:", error);
  process.exit(1);
});
