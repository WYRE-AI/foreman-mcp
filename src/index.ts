#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FOREMAN_ENDPOINTS } from "./tools/registry.js";
import { getEnabledTiers } from "./tiers.js";
import { callForemanTool } from "./utils/handler.js";
import { getCredentials, getBaseUrl, runWithCredentials, resolveGatewayCredentials } from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

const LOOPBACK_HOST = "127.0.0.1";
const MISSING_S2S_SECRET_ERROR = "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty.";
const PLACEHOLDER_S2S_SECRET_ERROR = "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder.";
const INSECURE_DEV_WARNING = "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only.";

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; insecureDev: boolean } {
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && ["replace-with-a-real-secret", "your-s2s-secret", "your-secret", "changeme", "change-me", "placeholder", "secret", "example", "replace-me", "s2s-secret"].includes(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") return { secret: "", insecureDev: true };
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

function resolveBindHost(s2sSecret: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(`WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. Binding ${LOOPBACK_HOST} only.`);
  }
  return LOOPBACK_HOST;
}

export function createFreshServer(): Server {
  const server = new Server(
    { name: "foreman-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.onerror = (error) => {
    logger.error("MCP server error", { error: error instanceof Error ? error.message : String(error) });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: FOREMAN_ENDPOINTS
      .filter((endpoint) => {
        const enabled = getEnabledTiers();
        return enabled.has(endpoint.tier);
      })
      .map((endpoint) => ({
        name: endpoint.toolName,
        description: endpoint.description,
        inputSchema: endpoint.inputSchema,
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool call received", { tool: name });
    try {
      return await callForemanTool(name, (args ?? {}) as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Tool call failed", { tool: name, error: message });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  credentials?: ReturnType<typeof getCredentials>,
): Promise<void> {
  const server = createFreshServer();
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    if (credentials) {
      await runWithCredentials(credentials, () => transport.handleRequest(req, res));
    } else {
      await transport.handleRequest(req, res);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("MCP request handling failed", { error: message });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}

async function startStdioTransport(): Promise<void> {
  const server = createFreshServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Foreman MCP server running on stdio");
}

export async function startHttpTransport(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveBindHost(s2sSecret);
  if (insecureDev) logger.error(INSECURE_DEV_WARNING);
  const authMode = (process.env.AUTH_MODE || "env").trim();
  if (authMode !== "env" && authMode !== "gateway") {
    refuseStart(`Refusing to start HTTP transport: AUTH_MODE must be "env" or "gateway" (got "${authMode}").`);
  }
  const isGatewayMode = authMode === "gateway";
  if (!isGatewayMode && !getCredentials()) {
    logger.warn("AUTH_MODE=env but FOREMAN_USERNAME or FOREMAN_TOKEN is not set; tool calls will return an authentication error.");
  }

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/mcp") {
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway." }));
        return;
      }
      if (isGatewayMode) {
        const { credentials, error } = resolveGatewayCredentials((name) => headerValue(req.headers[name]));
        if (!credentials) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing credentials", message: error, required: ["x-foreman-username", "x-foreman-token"] }));
          return;
        }
        void handleMcpRequest(req, res, credentials);
        return;
      }
      void handleMcpRequest(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info(`Foreman MCP server listening on http://${host}:${actualPort}/mcp`);
      logger.info(`Health check available at http://${host}:${actualPort}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway" : "env"}`);
      resolve();
    });
  });
  return httpServer;
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  const baseUrl = getBaseUrl();
  const tiers = [...getEnabledTiers()];
  logger.info("Starting Foreman MCP server", {
    transport: transportType,
    apiUrl: baseUrl,
    enabledTiers: tiers,
    toolCount: FOREMAN_ENDPOINTS.filter((endpoint) => tiers.includes(endpoint.tier)).length,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });
  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      logger.info("Shutting down Foreman MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    if (!getCredentials()) {
      logger.warn("FOREMAN_USERNAME or FOREMAN_TOKEN is not set; tool calls will return an authentication error.");
    }
    await startStdioTransport();
  }
}

if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
